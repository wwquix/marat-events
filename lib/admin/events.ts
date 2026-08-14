const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const NEW_YORK_TIME_ZONE = "America/New_York";

export type EventStatus = "draft" | "published" | "hidden";
export type TicketStatus = "active" | "sold_out" | "hidden";
export type TicketAudience = "male" | "female" | "any";

export type AdminEventInput = {
  slug: string;
  title: string;
  description: string;
  venue: string;
  startsAt: string;
  capacity: number | null;
  status: EventStatus;
};

export type AdminTicketInput = {
  code: string;
  name: string;
  audience: TicketAudience;
  priceCents: number;
  currency: string;
  capacity: number | null;
  status: TicketStatus;
};

export type ExistingEventForPolicy = {
  slug: string;
  status: string;
};

export type ExistingTicketForPolicy = {
  code: string;
  audience: string;
  priceCents: number;
  currency: string;
};

export type AdminMutationError =
  | "invalid"
  | "capacity_below_paid"
  | "locked_after_payment"
  | "published_event_in_past";

function parseOptionalCapacity(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,6}$/.test(text)) {
    return undefined;
  }

  const capacity = Number(text);
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 100000) {
    return undefined;
  }

  return capacity;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value.trim() : null;
}

export function parseMoneyToCents(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(text)) {
    return null;
  }

  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

export function formatCentsForInput(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

function localPartsForDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NEW_YORK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
}

export function utcToNewYorkLocalInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid timestamp.");
  }
  return localPartsForDate(date);
}

export function newYorkLocalInputToUtc(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!match) {
    return null;
  }

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);

  if (
    year < 2020 ||
    year > 2200 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59
  ) {
    return null;
  }

  const desiredWallClockMs = Date.UTC(year, month - 1, day, hour, minute);
  let candidateMs = desiredWallClockMs;

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const candidate = new Date(candidateMs);
    const localText = localPartsForDate(candidate);
    const localMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localText);
    if (!localMatch) {
      return null;
    }

    const localWallClockMs = Date.UTC(
      Number(localMatch[1]),
      Number(localMatch[2]) - 1,
      Number(localMatch[3]),
      Number(localMatch[4]),
      Number(localMatch[5]),
    );
    const delta = desiredWallClockMs - localWallClockMs;
    if (delta === 0) {
      return candidate.toISOString();
    }
    candidateMs += delta;
  }

  const finalCandidate = new Date(candidateMs);
  return localPartsForDate(finalCandidate) === text ? finalCandidate.toISOString() : null;
}

export function validateAdminEventInput(value: unknown): { ok: true; value: AdminEventInput } | { ok: false } {
  if (!value || typeof value !== "object") {
    return { ok: false };
  }

  const input = value as Record<string, unknown>;
  const slug = readString(input, "slug");
  const title = readString(input, "title");
  const description = readString(input, "description");
  const venue = readString(input, "venue");
  const startsAt = newYorkLocalInputToUtc(input.starts_at);
  const capacity = parseOptionalCapacity(input.capacity);
  const status = readString(input, "status");

  if (
    !slug ||
    slug.length > 120 ||
    !SLUG_PATTERN.test(slug) ||
    !title ||
    title.length > 160 ||
    description === null ||
    description.length > 5000 ||
    !venue ||
    venue.length > 240 ||
    !startsAt ||
    capacity === undefined ||
    (status !== "draft" && status !== "published" && status !== "hidden")
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      slug,
      title,
      description,
      venue,
      startsAt,
      capacity,
      status,
    },
  };
}

export function validateAdminTicketInput(value: unknown): { ok: true; value: AdminTicketInput } | { ok: false } {
  if (!value || typeof value !== "object") {
    return { ok: false };
  }

  const input = value as Record<string, unknown>;
  const code = readString(input, "code");
  const name = readString(input, "name");
  const audience = readString(input, "audience");
  const priceCents = parseMoneyToCents(input.price);
  const currency = readString(input, "currency")?.toUpperCase() ?? null;
  const capacity = parseOptionalCapacity(input.capacity);
  const status = readString(input, "status");

  if (
    !code ||
    code.length > 80 ||
    !SLUG_PATTERN.test(code) ||
    !name ||
    name.length > 160 ||
    (audience !== "male" && audience !== "female" && audience !== "any") ||
    priceCents === null ||
    priceCents <= 0 ||
    !currency ||
    !CURRENCY_PATTERN.test(currency) ||
    capacity === undefined ||
    (status !== "active" && status !== "sold_out" && status !== "hidden")
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      code,
      name,
      audience,
      priceCents,
      currency,
      capacity,
      status,
    },
  };
}

export function validateAdminId(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value.trim()) ? value.trim() : null;
}

export function validateEventMutation(
  existing: ExistingEventForPolicy,
  next: AdminEventInput,
  paidRegistrationCount: number,
  nowMs = Date.now(),
): AdminMutationError | null {
  if (next.capacity !== null && next.capacity < paidRegistrationCount) {
    return "capacity_below_paid";
  }

  if (next.status === "published" && Date.parse(next.startsAt) <= nowMs) {
    return "published_event_in_past";
  }

  if (paidRegistrationCount > 0 && (next.slug !== existing.slug || next.status === "draft")) {
    return "locked_after_payment";
  }

  return null;
}

export function validateTicketMutation(
  existing: ExistingTicketForPolicy,
  next: AdminTicketInput,
  paidRegistrationCount: number,
): AdminMutationError | null {
  if (next.capacity !== null && next.capacity < paidRegistrationCount) {
    return "capacity_below_paid";
  }

  if (
    paidRegistrationCount > 0 &&
    (next.code !== existing.code ||
      next.audience !== existing.audience ||
      next.priceCents !== existing.priceCents ||
      next.currency !== existing.currency)
  ) {
    return "locked_after_payment";
  }

  return null;
}
