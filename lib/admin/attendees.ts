const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export type PaymentStatusFilter = "all" | "pending" | "paid" | "failed" | "refunded";
export type GenderFilter = "all" | "male" | "female";

export type AttendeeFilters = {
  payment: PaymentStatusFilter;
  gender: GenderFilter;
  ticketId: string | null;
  source: string | null;
  query: string;
};

export type SearchableAttendee = {
  fullName: string;
  email: string;
  phone: string | null;
  personFullName?: string | null;
  personEmail?: string | null;
  personPhone?: string | null;
};

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeQuery(value: string | undefined): string {
  if (!value) return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 100);
}

export function parseAttendeeFilters(
  params: Record<string, string | string[] | undefined>,
): AttendeeFilters {
  const paymentValue = firstQueryValue(params.payment);
  const genderValue = firstQueryValue(params.gender);
  const ticketValue = firstQueryValue(params.ticket);
  const sourceValue = firstQueryValue(params.source);

  const payment: PaymentStatusFilter =
    paymentValue === "pending" ||
    paymentValue === "paid" ||
    paymentValue === "failed" ||
    paymentValue === "refunded"
      ? paymentValue
      : "all";

  const gender: GenderFilter =
    genderValue === "male" || genderValue === "female" ? genderValue : "all";

  const ticketId = ticketValue && UUID_PATTERN.test(ticketValue) ? ticketValue : null;
  const source =
    sourceValue && sourceValue !== "all" && SOURCE_PATTERN.test(sourceValue) ? sourceValue : null;

  return {
    payment,
    gender,
    ticketId,
    source,
    query: normalizeQuery(firstQueryValue(params.q)),
  };
}

export function attendeeMatchesSearch(attendee: SearchableAttendee, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase("en-US");
  if (!needle) return true;

  const values = [
    attendee.fullName,
    attendee.email,
    attendee.phone,
    attendee.personFullName,
    attendee.personEmail,
    attendee.personPhone,
  ];

  return values.some(
    (value) => typeof value === "string" && value.toLocaleLowerCase("en-US").includes(needle),
  );
}

export function formatAdminDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(parsed);
}

export function formatAdminMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amountCents / 100);
}
