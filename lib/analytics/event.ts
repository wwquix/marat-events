export type SelectionAnalytics = {
  selectionId: string;
  name: string;
  evaluatedCount: number;
  eligibleCount: number;
  limitExceeded: boolean;
};

export type CampaignAnalytics = {
  campaignId: string;
  name: string;
  channel: string;
  deliveryMode: string;
  status: string;
  recipientCount: number;
  outboxMessageCount: number;
  outboxStatuses: Record<string, number>;
};

export type TicketAnalytics = {
  ticketTypeId: string | null;
  code: string;
  name: string;
  capacity: number | null;
  priceCents: number | null;
  currency: string;
  registrationCount: number;
  paidCount: number;
  checkedInCount: number;
  paidRevenueCents: number;
};

export type SourceAnalytics = {
  source: string;
  registrationCount: number;
  paidCount: number;
  checkedInCount: number;
};

export type EventAnalytics = {
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  startsAt: string;
  eventCapacity: number | null;
  eventPriceCents: number;
  eventCurrency: string;
  activeSelectionCount: number;
  eligiblePeople: number;
  audienceLimitExceeded: boolean;
  campaignCount: number;
  campaignRecipientCount: number;
  campaignRecipientPeople: number;
  outboxMessageCount: number;
  registrationCount: number;
  registeredPeople: number;
  paidRegistrationCount: number;
  paidPeople: number;
  paidRevenueCents: number;
  checkedInRegistrationCount: number;
  checkedInPeople: number;
  matchingParticipantCount: number;
  likedProfileCount: number;
  likeCount: number;
  matchCount: number;
  matchedProfileCount: number;
  remainingCapacity: number | null;
  oversoldBy: number | null;
  selections: SelectionAnalytics[];
  campaigns: CampaignAnalytics[];
  outboxStatuses: Record<string, number>;
  tickets: TicketAnalytics[];
  sources: SourceAnalytics[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const parsed = text(value);
  return parsed && Number.isFinite(Date.parse(parsed)) ? parsed : null;
}

function uuid(value: unknown): string | null {
  const parsed = text(value);
  return parsed && UUID_PATTERN.test(parsed) ? parsed : null;
}

function count(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nullableCount(value: unknown): number | null | undefined {
  return value === null ? null : (count(value) ?? undefined);
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function countMap(value: unknown): Record<string, number> | null {
  const input = record(value);
  if (!input) return null;

  const parsed: Record<string, number> = {};
  for (const [key, rawCount] of Object.entries(input)) {
    const safeCount = count(rawCount);
    if (!key || safeCount === null) return null;
    parsed[key] = safeCount;
  }
  return parsed;
}

function parseSelections(value: unknown): SelectionAnalytics[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: SelectionAnalytics[] = [];
  for (const item of value) {
    const row = record(item);
    const selectionId = uuid(row?.selection_id);
    const name = text(row?.name);
    const evaluatedCount = count(row?.evaluated_count);
    const eligibleCount = count(row?.eligible_count);
    const limitExceeded = boolean(row?.limit_exceeded);
    if (
      !selectionId
      || !name
      || evaluatedCount === null
      || eligibleCount === null
      || eligibleCount > evaluatedCount
      || limitExceeded === null
    ) {
      return null;
    }
    parsed.push({ selectionId, name, evaluatedCount, eligibleCount, limitExceeded });
  }
  return parsed;
}

function parseCampaigns(value: unknown): CampaignAnalytics[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: CampaignAnalytics[] = [];
  for (const item of value) {
    const row = record(item);
    const campaignId = uuid(row?.campaign_id);
    const name = text(row?.name);
    const channel = text(row?.channel);
    const deliveryMode = text(row?.delivery_mode);
    const status = text(row?.status);
    const recipientCount = count(row?.recipient_count);
    const outboxMessageCount = count(row?.outbox_message_count);
    const outboxStatuses = countMap(row?.outbox_statuses);
    if (
      !campaignId
      || !name
      || !channel
      || !deliveryMode
      || !status
      || recipientCount === null
      || outboxMessageCount === null
      || !outboxStatuses
    ) {
      return null;
    }
    parsed.push({
      campaignId,
      name,
      channel,
      deliveryMode,
      status,
      recipientCount,
      outboxMessageCount,
      outboxStatuses,
    });
  }
  return parsed;
}

function parseTickets(value: unknown): TicketAnalytics[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: TicketAnalytics[] = [];
  for (const item of value) {
    const row = record(item);
    const ticketTypeId = row?.ticket_type_id === null ? null : (uuid(row?.ticket_type_id) ?? undefined);
    const code = text(row?.code);
    const name = text(row?.name);
    const capacity = nullableCount(row?.capacity);
    const priceCents = nullableCount(row?.price_cents);
    const currency = text(row?.currency);
    const registrationCount = count(row?.registration_count);
    const paidCount = count(row?.paid_count);
    const checkedInCount = count(row?.checked_in_count);
    const paidRevenueCents = count(row?.paid_revenue_cents);
    if (
      ticketTypeId === undefined
      || !code
      || !name
      || capacity === undefined
      || priceCents === undefined
      || !currency
      || !/^[A-Z]{3}$/.test(currency)
      || registrationCount === null
      || paidCount === null
      || checkedInCount === null
      || paidRevenueCents === null
    ) {
      return null;
    }
    parsed.push({
      ticketTypeId,
      code,
      name,
      capacity,
      priceCents,
      currency,
      registrationCount,
      paidCount,
      checkedInCount,
      paidRevenueCents,
    });
  }
  return parsed;
}

function parseSources(value: unknown): SourceAnalytics[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: SourceAnalytics[] = [];
  for (const item of value) {
    const row = record(item);
    const source = text(row?.source);
    const registrationCount = count(row?.registration_count);
    const paidCount = count(row?.paid_count);
    const checkedInCount = count(row?.checked_in_count);
    if (!source || registrationCount === null || paidCount === null || checkedInCount === null) return null;
    parsed.push({ source, registrationCount, paidCount, checkedInCount });
  }
  return parsed;
}

export function parseEventAnalytics(value: unknown): EventAnalytics | null {
  const row = record(value);
  if (!row) return null;

  const eventId = uuid(row.event_id);
  const eventSlug = text(row.event_slug);
  const eventTitle = text(row.event_title);
  const startsAt = timestamp(row.starts_at);
  const eventCapacity = nullableCount(row.event_capacity);
  const eventPriceCents = count(row.event_price_cents);
  const eventCurrency = text(row.event_currency);
  const activeSelectionCount = count(row.active_selection_count);
  const eligiblePeople = count(row.eligible_people);
  const audienceLimitExceeded = boolean(row.audience_limit_exceeded);
  const campaignCount = count(row.campaign_count);
  const campaignRecipientCount = count(row.campaign_recipient_count);
  const campaignRecipientPeople = count(row.campaign_recipient_people);
  const outboxMessageCount = count(row.outbox_message_count);
  const registrationCount = count(row.registration_count);
  const registeredPeople = count(row.registered_people);
  const paidRegistrationCount = count(row.paid_registration_count);
  const paidPeople = count(row.paid_people);
  const paidRevenueCents = count(row.paid_revenue_cents);
  const checkedInRegistrationCount = count(row.checked_in_registration_count);
  const checkedInPeople = count(row.checked_in_people);
  const matchingParticipantCount = count(row.matching_participant_count);
  const likedProfileCount = count(row.liked_profile_count);
  const likeCount = count(row.like_count);
  const matchCount = count(row.match_count);
  const matchedProfileCount = count(row.matched_profile_count);
  const remainingCapacity = nullableCount(row.remaining_capacity);
  const oversoldBy = nullableCount(row.oversold_by);
  const selections = parseSelections(row.selection_breakdown);
  const campaigns = parseCampaigns(row.campaign_breakdown);
  const outboxStatuses = countMap(row.outbox_status_breakdown);
  const tickets = parseTickets(row.ticket_breakdown);
  const sources = parseSources(row.source_breakdown);

  const requiredCounts = [
    eventPriceCents,
    activeSelectionCount,
    eligiblePeople,
    campaignCount,
    campaignRecipientCount,
    campaignRecipientPeople,
    outboxMessageCount,
    registrationCount,
    registeredPeople,
    paidRegistrationCount,
    paidPeople,
    paidRevenueCents,
    checkedInRegistrationCount,
    checkedInPeople,
    matchingParticipantCount,
    likedProfileCount,
    likeCount,
    matchCount,
    matchedProfileCount,
  ];
  if (
    !eventId
    || !eventSlug
    || !eventTitle
    || !startsAt
    || eventCapacity === undefined
    || !eventCurrency
    || !/^[A-Z]{3}$/.test(eventCurrency)
    || audienceLimitExceeded === null
    || remainingCapacity === undefined
    || oversoldBy === undefined
    || requiredCounts.some((item) => item === null)
    || !selections
    || !campaigns
    || !outboxStatuses
    || !tickets
    || !sources
  ) {
    return null;
  }

  return {
    eventId,
    eventSlug,
    eventTitle,
    startsAt,
    eventCapacity,
    eventPriceCents: eventPriceCents!,
    eventCurrency,
    activeSelectionCount: activeSelectionCount!,
    eligiblePeople: eligiblePeople!,
    audienceLimitExceeded,
    campaignCount: campaignCount!,
    campaignRecipientCount: campaignRecipientCount!,
    campaignRecipientPeople: campaignRecipientPeople!,
    outboxMessageCount: outboxMessageCount!,
    registrationCount: registrationCount!,
    registeredPeople: registeredPeople!,
    paidRegistrationCount: paidRegistrationCount!,
    paidPeople: paidPeople!,
    paidRevenueCents: paidRevenueCents!,
    checkedInRegistrationCount: checkedInRegistrationCount!,
    checkedInPeople: checkedInPeople!,
    matchingParticipantCount: matchingParticipantCount!,
    likedProfileCount: likedProfileCount!,
    likeCount: likeCount!,
    matchCount: matchCount!,
    matchedProfileCount: matchedProfileCount!,
    remainingCapacity,
    oversoldBy,
    selections,
    campaigns,
    outboxStatuses,
    tickets,
    sources,
  };
}
