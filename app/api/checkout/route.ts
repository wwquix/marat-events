import { NextRequest, NextResponse } from "next/server";

import {
  buildCheckoutSessionParams,
  checkoutIdempotencyKey,
  isEventAvailableForSale,
  isSoldOut,
  parseCheckoutEvent,
  validateCheckoutInput,
} from "@/lib/checkout/rules";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getStripeServerClient } from "@/lib/stripe/server";

type CheckoutErrorCode =
  | "invalid"
  | "unavailable"
  | "sold_out"
  | "database"
  | "stripe";

type FailureStage =
  | "read_input"
  | "load_event"
  | "count_capacity"
  | "insert_registration"
  | "create_stripe_session"
  | "store_stripe_session";

type OperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

function logCheckoutFailure(
  stage: FailureStage,
  context: { eventSlug?: string; eventId?: string; registrationId?: string },
  error?: unknown,
) {
  console.error("checkout_failure", {
    stage,
    ...context,
    errorName: error instanceof Error ? error.name : "unknown",
  });
}

function redirectToEvent(
  request: NextRequest,
  slug: string,
  errorCode: CheckoutErrorCode,
) {
  const eventUrl = new URL(`/events/${encodeURIComponent(slug)}`, request.nextUrl.origin);
  eventUrl.searchParams.set("checkout_error", errorCode);
  return NextResponse.redirect(eventUrl, 303);
}

async function attemptDatabaseOperation<T>(
  operation: () => PromiseLike<T>,
): Promise<OperationResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function readRequestData(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return request.json();
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await request.formData();
    return Object.fromEntries(formData.entries());
  }

  throw new Error("Unsupported checkout request content type.");
}

function isInsertedRegistration(value: unknown): value is { id: string } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).id === "string" &&
    ((value as Record<string, unknown>).id as string).length > 0
  );
}

export async function POST(request: NextRequest) {
  let rawInput: unknown;

  try {
    rawInput = await readRequestData(request);
  } catch (error) {
    logCheckoutFailure("read_input", {}, error);
    return NextResponse.json({ error: "Invalid checkout request." }, { status: 400 });
  }

  const validation = validateCheckoutInput(rawInput);
  if (!validation.ok) {
    const candidateSlug =
      rawInput && typeof rawInput === "object"
        ? (rawInput as Record<string, unknown>).slug
        : undefined;

    if (typeof candidateSlug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidateSlug)) {
      return redirectToEvent(request, candidateSlug, "invalid");
    }

    return NextResponse.json({ error: "Invalid checkout request." }, { status: 400 });
  }

  const { slug, fullName, email } = validation.value;
  let supabase: ReturnType<typeof createSupabaseServerClient>;

  try {
    supabase = createSupabaseServerClient();
  } catch (error) {
    logCheckoutFailure("load_event", { eventSlug: slug }, error);
    return redirectToEvent(request, slug, "database");
  }

  const eventQuery = await attemptDatabaseOperation(() =>
    supabase
      .from("events")
      .select("id,slug,title,starts_at,capacity,price_cents,currency,status")
      .eq("slug", slug)
      .maybeSingle(),
  );

  if (!eventQuery.ok) {
    logCheckoutFailure("load_event", { eventSlug: slug }, eventQuery.error);
    return redirectToEvent(request, slug, "database");
  }

  const { data: eventData, error: eventError } = eventQuery.value;

  if (eventError) {
    logCheckoutFailure("load_event", { eventSlug: slug });
    return redirectToEvent(request, slug, "database");
  }

  if (eventData === null) {
    return NextResponse.json({ error: "Event not found." }, { status: 404 });
  }

  const event = parseCheckoutEvent(eventData);
  if (!event) {
    logCheckoutFailure("load_event", { eventSlug: slug });
    return redirectToEvent(request, slug, "database");
  }

  if (!isEventAvailableForSale(event)) {
    return redirectToEvent(request, slug, "unavailable");
  }

  if (event.capacity !== null) {
    const countQuery = await attemptDatabaseOperation(() =>
      supabase
        .from("registrations")
        .select("id", { count: "exact", head: true })
        .eq("event_id", event.id)
        .eq("payment_status", "paid"),
    );

    if (!countQuery.ok) {
      logCheckoutFailure(
        "count_capacity",
        { eventSlug: slug, eventId: event.id },
        countQuery.error,
      );
      return redirectToEvent(request, slug, "database");
    }

    const { count, error: countError } = countQuery.value;

    if (countError || count === null) {
      logCheckoutFailure("count_capacity", { eventSlug: slug, eventId: event.id });
      return redirectToEvent(request, slug, "database");
    }

    if (isSoldOut(event.capacity, count)) {
      return redirectToEvent(request, slug, "sold_out");
    }
  }

  const registrationQuery = await attemptDatabaseOperation(() =>
    supabase
      .from("registrations")
      .insert({
        event_id: event.id,
        full_name: fullName,
        email,
        amount_cents: event.priceCents,
        currency: event.currency,
        payment_status: "pending",
      })
      .select("id")
      .single(),
  );

  if (!registrationQuery.ok) {
    logCheckoutFailure(
      "insert_registration",
      { eventSlug: slug, eventId: event.id },
      registrationQuery.error,
    );
    return redirectToEvent(request, slug, "database");
  }

  const { data: registrationData, error: registrationError } = registrationQuery.value;

  if (registrationError || !isInsertedRegistration(registrationData)) {
    logCheckoutFailure("insert_registration", { eventSlug: slug, eventId: event.id });
    return redirectToEvent(request, slug, "database");
  }

  const registrationId = registrationData.id;
  let sessionId: string;
  let sessionUrl: string;

  try {
    const stripe = getStripeServerClient();
    const session = await stripe.checkout.sessions.create(
      buildCheckoutSessionParams(event, registrationId, email, request.nextUrl.origin),
      { idempotencyKey: checkoutIdempotencyKey(registrationId) },
    );

    if (!session.url) {
      throw new Error("Stripe Checkout Session URL is unavailable.");
    }

    sessionId = session.id;
    sessionUrl = session.url;
  } catch (error) {
    logCheckoutFailure(
      "create_stripe_session",
      { eventSlug: slug, eventId: event.id, registrationId },
      error,
    );
    return redirectToEvent(request, slug, "stripe");
  }

  const updateQuery = await attemptDatabaseOperation(() =>
    supabase
      .from("registrations")
      .update({ stripe_checkout_session_id: sessionId })
      .eq("id", registrationId)
      .eq("payment_status", "pending")
      .select("id")
      .maybeSingle(),
  );

  if (!updateQuery.ok) {
    logCheckoutFailure(
      "store_stripe_session",
      { eventSlug: slug, eventId: event.id, registrationId },
      updateQuery.error,
    );
    return redirectToEvent(request, slug, "database");
  }

  const { data: updatedRegistration, error: updateError } = updateQuery.value;

  if (updateError || !isInsertedRegistration(updatedRegistration)) {
    logCheckoutFailure("store_stripe_session", {
      eventSlug: slug,
      eventId: event.id,
      registrationId,
    });
    return redirectToEvent(request, slug, "database");
  }

  return NextResponse.redirect(sessionUrl, 303);
}
