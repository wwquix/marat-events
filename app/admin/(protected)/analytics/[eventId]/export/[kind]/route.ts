import { NextRequest, NextResponse } from "next/server";

import { parseEventAnalytics } from "@/lib/analytics/event";
import { validateAdminId } from "@/lib/admin/events";
import { getAdminSession } from "@/lib/admin/session";
import { buildExportCsv, exportFilename, type ExportCsvCell } from "@/lib/exports/csv";
import { parseEventExportKind, type EventExportKind } from "@/lib/exports/kinds";
import {
  ExportLimitExceededError,
  ExportLoadError,
  loadBoundedExportRows,
} from "@/lib/exports/paging";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ eventId: string; kind: string }>;
};

type EventRow = { id: string; slug: string; title: string };
type TicketRelation = { code: string; name: string };
type RegistrationRow = {
  id: string;
  person_id: string | null;
  ticket_type_id: string | null;
  full_name: string;
  email: string;
  phone: string | null;
  age: number | null;
  gender: string | null;
  source: string | null;
  payment_status: string;
  amount_cents: number;
  currency: string;
  created_at: string;
  paid_at: string | null;
  ticket_types: TicketRelation | TicketRelation[] | null;
};
type AudienceRow = {
  person_id: string;
  full_name: string;
  eligible: boolean;
  reason_codes: string[];
  required_channel: string;
  usable_contact_value: string | null;
  usable_contact_consent_status: string | null;
  usable_contact_contactability_status: string | null;
  suppression_status: string;
  identity_status: string;
};
type CampaignRecipientRow = {
  id: string;
  ordinal: number;
  person_id: string;
  destination_snapshot: string;
  channel: string;
  consent_status_snapshot: string;
  contactability_status_snapshot: string;
  suppression_status_snapshot: string;
  identity_status_snapshot: string;
  eligibility: string;
  policy_reason: string;
  available_at: string;
  created_at: string;
};
type OutboxRow = {
  campaign_recipient_id: string;
  status: string;
  attempt_count: number;
  last_result_code: string | null;
  completed_at: string | null;
};
type MatchRow = {
  public_id: string;
  profile_one_id: string;
  profile_two_id: string;
  notification_status: string;
  created_at: string;
};
type MatchProfileRow = { id: string; public_id: string; display_name: string; status: string };

const REGISTRATION_FIELDS = [
  "id",
  "person_id",
  "ticket_type_id",
  "full_name",
  "email",
  "phone",
  "age",
  "gender",
  "source",
  "payment_status",
  "amount_cents",
  "currency",
  "created_at",
  "paid_at",
  "ticket_types(code,name)",
].join(",");

function firstRelation<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEventRow(value: unknown): value is EventRow {
  return isObject(value)
    && typeof value.id === "string"
    && typeof value.slug === "string"
    && typeof value.title === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value);
}

function isTicketRelation(value: unknown): value is TicketRelation {
  return isObject(value) && typeof value.code === "string" && typeof value.name === "string";
}

function isRegistrationRow(value: unknown): value is RegistrationRow {
  return isObject(value)
    && typeof value.id === "string"
    && typeof value.full_name === "string"
    && typeof value.email === "string"
    && isNullableString(value.person_id)
    && isNullableString(value.ticket_type_id)
    && isNullableString(value.phone)
    && isNullableSafeInteger(value.age)
    && isNullableString(value.gender)
    && isNullableString(value.source)
    && typeof value.payment_status === "string"
    && Number.isSafeInteger(value.amount_cents)
    && typeof value.currency === "string"
    && typeof value.created_at === "string"
    && isNullableString(value.paid_at)
    && (
      value.ticket_types === null
      || isTicketRelation(value.ticket_types)
      || (Array.isArray(value.ticket_types) && value.ticket_types.length <= 1 && value.ticket_types.every(isTicketRelation))
    );
}

function isAudienceRow(value: unknown): value is AudienceRow {
  return isObject(value)
    && typeof value.person_id === "string"
    && typeof value.full_name === "string"
    && typeof value.eligible === "boolean"
    && Array.isArray(value.reason_codes)
    && value.reason_codes.every((reason) => typeof reason === "string")
    && typeof value.required_channel === "string"
    && isNullableString(value.usable_contact_value)
    && isNullableString(value.usable_contact_consent_status)
    && isNullableString(value.usable_contact_contactability_status)
    && typeof value.suppression_status === "string"
    && typeof value.identity_status === "string";
}

function isCampaignRecipientRow(value: unknown): value is CampaignRecipientRow {
  return isObject(value)
    && typeof value.id === "string"
    && Number.isSafeInteger(value.ordinal)
    && typeof value.person_id === "string"
    && typeof value.destination_snapshot === "string"
    && typeof value.channel === "string"
    && typeof value.consent_status_snapshot === "string"
    && typeof value.contactability_status_snapshot === "string"
    && typeof value.suppression_status_snapshot === "string"
    && typeof value.identity_status_snapshot === "string"
    && typeof value.eligibility === "string"
    && typeof value.policy_reason === "string"
    && typeof value.available_at === "string"
    && typeof value.created_at === "string";
}

function isOutboxRow(value: unknown): value is OutboxRow {
  return isObject(value)
    && typeof value.campaign_recipient_id === "string"
    && typeof value.status === "string"
    && Number.isSafeInteger(value.attempt_count)
    && isNullableString(value.last_result_code)
    && isNullableString(value.completed_at);
}

function isMatchRow(value: unknown): value is MatchRow {
  return isObject(value)
    && typeof value.public_id === "string"
    && typeof value.profile_one_id === "string"
    && typeof value.profile_two_id === "string"
    && typeof value.notification_status === "string"
    && typeof value.created_at === "string";
}

function isMatchProfileRow(value: unknown): value is MatchProfileRow {
  return isObject(value)
    && typeof value.id === "string"
    && typeof value.public_id === "string"
    && typeof value.display_name === "string"
    && typeof value.status === "string";
}

function csvResponse(csv: string, filename: string): NextResponse {
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "text/csv; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function exportFailure(kind: EventExportKind, error: unknown): NextResponse {
  if (error instanceof ExportLimitExceededError) {
    return new NextResponse(`${kind} export exceeds the 5,000-row safety limit.`, { status: 413 });
  }
  return new NextResponse(`Unable to create ${kind} export.`, { status: 500 });
}

async function audienceExport(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  event: EventRow,
  selectionId: string | null,
): Promise<NextResponse> {
  if (!selectionId) return new NextResponse("A valid selectionId is required.", { status: 400 });
  const { data: selection, error: selectionError } = await supabase
    .from("event_audience_selections")
    .select("id,name,event_id")
    .eq("id", selectionId)
    .eq("event_id", event.id)
    .maybeSingle();
  if (selectionError) throw new ExportLoadError();
  if (!isObject(selection) || typeof selection.name !== "string") return new NextResponse("Not found", { status: 404 });

  const rows = await loadBoundedExportRows<unknown>(async (fromInclusive, toInclusive) => {
    const result = await supabase
      .rpc("preview_event_audience_selection", { p_selection_id: selectionId, p_limit: 5001 })
      .range(fromInclusive, toInclusive);
    return { data: result.data as unknown[] | null, error: result.error };
  });
  if (!rows.every(isAudienceRow)) throw new ExportLoadError();

  const csvRows: ExportCsvCell[][] = rows.map((row) => [
    row.person_id,
    row.full_name,
    row.eligible ? "eligible" : "excluded",
    row.reason_codes.join("|"),
    row.required_channel,
    row.usable_contact_value,
    row.usable_contact_consent_status,
    row.usable_contact_contactability_status,
    row.suppression_status,
    row.identity_status,
  ]);
  return csvResponse(
    buildExportCsv(
      [
        "person_id",
        "full_name",
        "eligibility",
        "reason_codes",
        "required_channel",
        "contact_value",
        "consent_status",
        "contactability_status",
        "suppression_status",
        "identity_status",
      ],
      csvRows,
    ),
    exportFilename(event.slug, "audience", selection.name),
  );
}

async function attendeesExport(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  event: EventRow,
): Promise<NextResponse> {
  const rows = await loadBoundedExportRows<unknown>(async (fromInclusive, toInclusive) => {
    const result = await supabase
      .from("registrations")
      .select(REGISTRATION_FIELDS)
      .eq("event_id", event.id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(fromInclusive, toInclusive);
    return { data: result.data as unknown[] | null, error: result.error };
  });
  if (!rows.every(isRegistrationRow)) throw new ExportLoadError();

  const csvRows: ExportCsvCell[][] = rows.map((row) => {
    const ticket = firstRelation(row.ticket_types);
    return [
      row.id,
      row.person_id,
      row.full_name,
      row.email,
      row.phone,
      row.age,
      row.gender,
      row.source,
      row.payment_status,
      ticket?.code,
      ticket?.name,
      row.amount_cents,
      row.currency,
      row.created_at,
      row.paid_at,
    ];
  });
  return csvResponse(
    buildExportCsv(
      [
        "registration_id",
        "person_id",
        "full_name",
        "email",
        "phone",
        "age",
        "gender",
        "source",
        "payment_status",
        "ticket_code",
        "ticket_name",
        "amount_cents",
        "currency",
        "created_at_utc",
        "paid_at_utc",
      ],
      csvRows,
    ),
    exportFilename(event.slug, "attendees"),
  );
}

async function campaignResultsExport(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  event: EventRow,
  campaignId: string | null,
): Promise<NextResponse> {
  if (!campaignId) return new NextResponse("A valid campaignId is required.", { status: 400 });
  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .select("id,name,event_id")
    .eq("id", campaignId)
    .eq("event_id", event.id)
    .maybeSingle();
  if (campaignError) throw new ExportLoadError();
  if (!isObject(campaign) || typeof campaign.name !== "string") return new NextResponse("Not found", { status: 404 });

  const [recipients, outbox] = await Promise.all([
    loadBoundedExportRows<unknown>(async (fromInclusive, toInclusive) => {
      const result = await supabase
        .from("campaign_recipients")
        .select("id,ordinal,person_id,destination_snapshot,channel,consent_status_snapshot,contactability_status_snapshot,suppression_status_snapshot,identity_status_snapshot,eligibility,policy_reason,available_at,created_at")
        .eq("campaign_id", campaignId)
        .order("ordinal", { ascending: true })
        .order("id", { ascending: true })
        .range(fromInclusive, toInclusive);
      return { data: result.data as unknown[] | null, error: result.error };
    }),
    loadBoundedExportRows<unknown>(async (fromInclusive, toInclusive) => {
      const result = await supabase
        .from("outbox_messages")
        .select("campaign_recipient_id,status,attempt_count,last_result_code,completed_at")
        .eq("campaign_id", campaignId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(fromInclusive, toInclusive);
      return { data: result.data as unknown[] | null, error: result.error };
    }),
  ]);
  if (!recipients.every(isCampaignRecipientRow) || !outbox.every(isOutboxRow)) throw new ExportLoadError();
  const messageByRecipient = new Map(outbox.map((message) => [message.campaign_recipient_id, message]));

  const csvRows: ExportCsvCell[][] = recipients.map((recipient) => {
    const message = messageByRecipient.get(recipient.id);
    return [
      recipient.ordinal,
      recipient.person_id,
      recipient.channel,
      recipient.destination_snapshot,
      recipient.eligibility,
      recipient.policy_reason,
      recipient.consent_status_snapshot,
      recipient.contactability_status_snapshot,
      recipient.suppression_status_snapshot,
      recipient.identity_status_snapshot,
      message?.status ?? "not_queued",
      message?.attempt_count ?? 0,
      message?.last_result_code,
      recipient.available_at,
      message?.completed_at,
      recipient.created_at,
    ];
  });
  return csvResponse(
    buildExportCsv(
      [
        "ordinal",
        "person_id",
        "channel",
        "destination",
        "eligibility",
        "policy_reason",
        "consent_snapshot",
        "contactability_snapshot",
        "suppression_snapshot",
        "identity_snapshot",
        "outbox_status",
        "attempt_count",
        "last_result_code",
        "available_at_utc",
        "completed_at_utc",
        "recipient_created_at_utc",
      ],
      csvRows,
    ),
    exportFilename(event.slug, "campaign-results", campaign.name),
  );
}

async function eventSummaryExport(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  event: EventRow,
): Promise<NextResponse> {
  const { data, error } = await supabase.rpc("get_event_analytics", { p_event_id: event.id }).maybeSingle();
  if (error) throw new ExportLoadError();
  const analytics = parseEventAnalytics(data);
  if (!analytics) throw new ExportLoadError();

  const csv = buildExportCsv(
    [
      "event_id",
      "event_title",
      "starts_at_utc",
      "capacity",
      "eligible_people",
      "campaign_recipients",
      "outbox_messages",
      "registrations",
      "paid_registrations",
      "paid_revenue_cents",
      "currency",
      "checked_in_registrations",
      "matching_participants",
      "likes",
      "matches",
      "remaining_capacity",
      "oversold_by",
      "audience_limit_exceeded",
      "outbox_statuses_json",
      "ticket_breakdown_json",
      "source_breakdown_json",
    ],
    [[
      analytics.eventId,
      analytics.eventTitle,
      analytics.startsAt,
      analytics.eventCapacity,
      analytics.eligiblePeople,
      analytics.campaignRecipientCount,
      analytics.outboxMessageCount,
      analytics.registrationCount,
      analytics.paidRegistrationCount,
      analytics.paidRevenueCents,
      analytics.eventCurrency,
      analytics.checkedInRegistrationCount,
      analytics.matchingParticipantCount,
      analytics.likeCount,
      analytics.matchCount,
      analytics.remainingCapacity,
      analytics.oversoldBy,
      analytics.audienceLimitExceeded ? "true" : "false",
      JSON.stringify(analytics.outboxStatuses),
      JSON.stringify(analytics.tickets),
      JSON.stringify(analytics.sources),
    ]],
  );
  return csvResponse(csv, exportFilename(event.slug, "event-summary"));
}

async function matchesExport(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  event: EventRow,
): Promise<NextResponse> {
  const [matches, profiles] = await Promise.all([
    loadBoundedExportRows<unknown>(async (fromInclusive, toInclusive) => {
      const result = await supabase
        .from("matching_matches")
        .select("public_id,profile_one_id,profile_two_id,notification_status,created_at")
        .eq("event_id", event.id)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(fromInclusive, toInclusive);
      return { data: result.data as unknown[] | null, error: result.error };
    }),
    loadBoundedExportRows<unknown>(async (fromInclusive, toInclusive) => {
      const result = await supabase
        .from("matching_participant_profiles")
        .select("id,public_id,display_name,status")
        .eq("event_id", event.id)
        .order("display_name", { ascending: true })
        .order("id", { ascending: true })
        .range(fromInclusive, toInclusive);
      return { data: result.data as unknown[] | null, error: result.error };
    }),
  ]);
  if (!matches.every(isMatchRow) || !profiles.every(isMatchProfileRow)) throw new ExportLoadError();
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const csvRows: ExportCsvCell[][] = matches.map((match) => {
    const first = profileById.get(match.profile_one_id);
    const second = profileById.get(match.profile_two_id);
    if (!first || !second) throw new ExportLoadError();
    return [
      match.public_id,
      first.public_id,
      first.display_name,
      first.status,
      second.public_id,
      second.display_name,
      second.status,
      match.notification_status,
      match.created_at,
    ];
  });
  return csvResponse(
    buildExportCsv(
      [
        "match_public_id",
        "participant_one_public_id",
        "participant_one_name",
        "participant_one_status",
        "participant_two_public_id",
        "participant_two_name",
        "participant_two_status",
        "notification_status",
        "matched_at_utc",
      ],
      csvRows,
    ),
    exportFilename(event.slug, "matches"),
  );
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const session = await getAdminSession();
  if (!session) return NextResponse.redirect(new URL("/admin/login", request.url), 303);

  const params = await context.params;
  const eventId = validateAdminId(params.eventId);
  const kind = parseEventExportKind(params.kind);
  if (!eventId || !kind) return new NextResponse("Not found", { status: 404 });

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("events")
    .select("id,slug,title")
    .eq("id", eventId)
    .maybeSingle();
  if (error) return new NextResponse("Unable to create export.", { status: 500 });
  if (!isEventRow(data)) return new NextResponse("Not found", { status: 404 });

  try {
    if (kind === "audience") {
      return await audienceExport(supabase, data, validateAdminId(request.nextUrl.searchParams.get("selectionId")));
    }
    if (kind === "attendees") return await attendeesExport(supabase, data);
    if (kind === "campaign-results") {
      return await campaignResultsExport(
        supabase,
        data,
        validateAdminId(request.nextUrl.searchParams.get("campaignId")),
      );
    }
    if (kind === "event-summary") return await eventSummaryExport(supabase, data);
    return await matchesExport(supabase, data);
  } catch (caught) {
    return exportFailure(kind, caught);
  }
}
