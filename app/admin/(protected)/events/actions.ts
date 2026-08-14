"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  validateAdminEventInput,
  validateAdminId,
  validateAdminTicketInput,
  validateEventMutation,
  validateTicketMutation,
  type AdminMutationError,
} from "@/lib/admin/events";
import { requireAdminSession } from "@/lib/admin/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function formDataToObject(formData: FormData): Record<string, FormDataEntryValue> {
  return Object.fromEntries(formData.entries());
}

function eventPath(eventId: string, params?: Record<string, string>): string {
  const query = new URLSearchParams(params);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return `/admin/events/${eventId}${suffix}`;
}

function newEventPath(error: string): string {
  return `/admin/events/new?error=${encodeURIComponent(error)}`;
}

function mutationErrorCode(error: AdminMutationError): string {
  return error;
}

async function countPaidForEvent(eventId: string): Promise<number> {
  const supabase = createSupabaseServerClient();
  const { count, error } = await supabase
    .from("registrations")
    .select("id", { count: "exact", head: true })
    .eq("event_id", eventId)
    .eq("payment_status", "paid");

  if (error || count === null) {
    throw new Error("Unable to count paid event registrations.");
  }

  return count;
}

async function countPaidForTicket(ticketId: string): Promise<number> {
  const supabase = createSupabaseServerClient();
  const { count, error } = await supabase
    .from("registrations")
    .select("id", { count: "exact", head: true })
    .eq("ticket_type_id", ticketId)
    .eq("payment_status", "paid");

  if (error || count === null) {
    throw new Error("Unable to count paid ticket registrations.");
  }

  return count;
}

export async function createEventAction(formData: FormData) {
  await requireAdminSession();

  const validation = validateAdminEventInput(formDataToObject(formData));
  if (!validation.ok) {
    redirect(newEventPath("invalid"));
  }

  const policyError = validateEventMutation(
    { slug: validation.value.slug, status: "draft" },
    validation.value,
    0,
  );
  if (policyError) {
    redirect(newEventPath(mutationErrorCode(policyError)));
  }

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("events")
    .insert({
      slug: validation.value.slug,
      title: validation.value.title,
      description: validation.value.description,
      venue: validation.value.venue,
      starts_at: validation.value.startsAt,
      capacity: validation.value.capacity,
      status: validation.value.status,
      price_cents: 0,
      currency: "USD",
    })
    .select("id")
    .single();

  if (error || !data || typeof data.id !== "string") {
    redirect(newEventPath(error?.code === "23505" ? "slug_exists" : "database"));
  }

  revalidatePath("/admin");
  revalidatePath(`/events/${validation.value.slug}`);
  redirect(eventPath(data.id, { saved: "event_created" }));
}

export async function updateEventAction(formData: FormData) {
  await requireAdminSession();

  const eventId = validateAdminId(formData.get("event_id"));
  const validation = validateAdminEventInput(formDataToObject(formData));
  if (!eventId || !validation.ok) {
    redirect(eventId ? eventPath(eventId, { error: "invalid" }) : "/admin?error=invalid");
  }

  const supabase = createSupabaseServerClient();
  const { data: existing, error: loadError } = await supabase
    .from("events")
    .select("id,slug,status")
    .eq("id", eventId)
    .maybeSingle();

  if (loadError || !existing) {
    redirect(eventPath(eventId, { error: "not_found" }));
  }

  let paidCount: number;
  try {
    paidCount = await countPaidForEvent(eventId);
  } catch {
    redirect(eventPath(eventId, { error: "database" }));
  }

  const policyError = validateEventMutation(
    { slug: existing.slug, status: existing.status },
    validation.value,
    paidCount,
  );
  if (policyError) {
    redirect(eventPath(eventId, { error: mutationErrorCode(policyError) }));
  }

  const { error: updateError } = await supabase
    .from("events")
    .update({
      slug: validation.value.slug,
      title: validation.value.title,
      description: validation.value.description,
      venue: validation.value.venue,
      starts_at: validation.value.startsAt,
      capacity: validation.value.capacity,
      status: validation.value.status,
    })
    .eq("id", eventId);

  if (updateError) {
    redirect(eventPath(eventId, { error: updateError.code === "23505" ? "slug_exists" : "database" }));
  }

  revalidatePath("/admin");
  revalidatePath(eventPath(eventId));
  revalidatePath(`/events/${existing.slug}`);
  revalidatePath(`/events/${validation.value.slug}`);
  redirect(eventPath(eventId, { saved: "event_updated" }));
}

export async function createTicketAction(formData: FormData) {
  await requireAdminSession();

  const eventId = validateAdminId(formData.get("event_id"));
  const validation = validateAdminTicketInput(formDataToObject(formData));
  if (!eventId || !validation.ok) {
    redirect(eventId ? eventPath(eventId, { error: "ticket_invalid" }) : "/admin?error=invalid");
  }

  const supabase = createSupabaseServerClient();
  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id,slug")
    .eq("id", eventId)
    .maybeSingle();

  if (eventError || !event) {
    redirect(eventPath(eventId, { error: "not_found" }));
  }

  const { error } = await supabase.from("ticket_types").insert({
    event_id: eventId,
    code: validation.value.code,
    name: validation.value.name,
    audience: validation.value.audience,
    price_cents: validation.value.priceCents,
    currency: validation.value.currency,
    capacity: validation.value.capacity,
    status: validation.value.status,
  });

  if (error) {
    redirect(eventPath(eventId, { error: error.code === "23505" ? "ticket_code_exists" : "database" }));
  }

  revalidatePath(eventPath(eventId));
  revalidatePath(`/events/${event.slug}`);
  redirect(eventPath(eventId, { saved: "ticket_created" }));
}

export async function updateTicketAction(formData: FormData) {
  await requireAdminSession();

  const eventId = validateAdminId(formData.get("event_id"));
  const ticketId = validateAdminId(formData.get("ticket_id"));
  const validation = validateAdminTicketInput(formDataToObject(formData));
  if (!eventId || !ticketId || !validation.ok) {
    redirect(eventId ? eventPath(eventId, { error: "ticket_invalid" }) : "/admin?error=invalid");
  }

  const supabase = createSupabaseServerClient();
  const { data: ticket, error: loadError } = await supabase
    .from("ticket_types")
    .select("id,event_id,code,audience,price_cents,currency,events(slug)")
    .eq("id", ticketId)
    .eq("event_id", eventId)
    .maybeSingle();

  if (loadError || !ticket) {
    redirect(eventPath(eventId, { error: "ticket_not_found" }));
  }

  let paidCount: number;
  try {
    paidCount = await countPaidForTicket(ticketId);
  } catch {
    redirect(eventPath(eventId, { error: "database" }));
  }

  const policyError = validateTicketMutation(
    {
      code: ticket.code,
      audience: ticket.audience,
      priceCents: ticket.price_cents,
      currency: ticket.currency,
    },
    validation.value,
    paidCount,
  );
  if (policyError) {
    redirect(eventPath(eventId, { error: mutationErrorCode(policyError) }));
  }

  const { error: updateError } = await supabase
    .from("ticket_types")
    .update({
      code: validation.value.code,
      name: validation.value.name,
      audience: validation.value.audience,
      price_cents: validation.value.priceCents,
      currency: validation.value.currency,
      capacity: validation.value.capacity,
      status: validation.value.status,
    })
    .eq("id", ticketId)
    .eq("event_id", eventId);

  if (updateError) {
    redirect(
      eventPath(eventId, {
        error: updateError.code === "23505" ? "ticket_code_exists" : "database",
      }),
    );
  }

  const relatedEvent = Array.isArray(ticket.events) ? ticket.events[0] : ticket.events;
  const eventSlug =
    relatedEvent && typeof relatedEvent === "object" && "slug" in relatedEvent
      ? String(relatedEvent.slug)
      : null;

  revalidatePath(eventPath(eventId));
  if (eventSlug) {
    revalidatePath(`/events/${eventSlug}`);
  }
  redirect(eventPath(eventId, { saved: "ticket_updated" }));
}
