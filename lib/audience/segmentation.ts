export const SEGMENT_CONTACT_CHANNELS = [
  "email",
  "phone",
  "sms",
  "instagram",
  "linkedin",
  "whatsapp",
  "telegram",
  "other",
] as const;

export type SegmentContactChannel = (typeof SEGMENT_CONTACT_CHANNELS)[number];
export type SegmentGender = "male" | "female";

export type AudienceSegmentFilter = {
  version: 1;
  genders: SegmentGender[];
  cities: string[];
  occupations: string[];
  educations: string[];
  sources: string[];
  sourceReferences: string[];
  importBatchIds: string[];
};

export type CampaignPreviewRow = {
  person_id: string;
  full_name: string;
  city: string | null;
  source: string | null;
  eligibility_status: "eligible" | "excluded";
  person_contact_id: string | null;
  contact_value: string | null;
  exclusion_reasons: string[];
};

export type CampaignPreviewSummary = {
  candidates: number;
  eligible: number;
  excluded: number;
  reasonCounts: Array<{ reason: string; count: number }>;
};

export type CampaignPreview = CampaignPreviewSummary & {
  rows: CampaignPreviewRow[];
};

export const EXCLUSION_REASON_LABELS: Record<string, string> = {
  person_suppressed: "Person is suppressed",
  identity_review_required: "Identity needs review",
  missing_channel: "No contact for this channel",
  channel_not_opted_in: "Channel is not explicitly opted in",
  channel_not_reachable: "Channel is not reachable",
  already_invited: "Already targeted for this event",
  already_registered: "Already registered for this event",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FILTER_VALUES = 100;
const MAX_FILTER_VALUE_LENGTH = 500;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function rawText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(",") : (value ?? "");
}

function normalizeList(value: string | string[] | undefined): string[] | null {
  const entries = rawText(value)
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length > MAX_FILTER_VALUES || entries.some((entry) => entry.length > MAX_FILTER_VALUE_LENGTH)) {
    return null;
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of entries) {
    const key = entry.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(entry);
  }
  return normalized;
}

type SegmentFilterInput = {
  genders?: string | string[];
  cities?: string | string[];
  occupations?: string | string[];
  educations?: string | string[];
  sources?: string | string[];
  sourceReferences?: string | string[];
  importBatchIds?: string | string[];
};

export function normalizeSegmentFilter(input: SegmentFilterInput): AudienceSegmentFilter | null {
  const rawGenders = normalizeList(input.genders);
  const cities = normalizeList(input.cities);
  const occupations = normalizeList(input.occupations);
  const educations = normalizeList(input.educations);
  const sources = normalizeList(input.sources);
  const sourceReferences = normalizeList(input.sourceReferences);
  const importBatchIds = normalizeList(input.importBatchIds);

  if (
    !rawGenders ||
    !cities ||
    !occupations ||
    !educations ||
    !sources ||
    !sourceReferences ||
    !importBatchIds
  ) {
    return null;
  }

  if (rawGenders.some((gender) => gender !== "male" && gender !== "female")) return null;
  if (importBatchIds.some((batchId) => !isUuid(batchId))) return null;

  return {
    version: 1,
    genders: rawGenders as SegmentGender[],
    cities,
    occupations,
    educations,
    sources,
    sourceReferences,
    importBatchIds: importBatchIds.map((batchId) => batchId.toLowerCase()),
  };
}

export function coerceSegmentFilter(value: unknown): AudienceSegmentFilter | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;

  const list = (key: string): string[] | undefined => {
    const candidate = record[key];
    return Array.isArray(candidate) && candidate.every((item) => typeof item === "string")
      ? (candidate as string[])
      : undefined;
  };

  const genders = list("genders");
  const cities = list("cities");
  const occupations = list("occupations");
  const educations = list("educations");
  const sources = list("sources");
  const sourceReferences = list("sourceReferences");
  const importBatchIds = list("importBatchIds");
  if (!genders || !cities || !occupations || !educations || !sources || !sourceReferences || !importBatchIds) {
    return null;
  }

  return normalizeSegmentFilter({
    genders,
    cities,
    occupations,
    educations,
    sources,
    sourceReferences,
    importBatchIds,
  });
}

export function parseSegmentContactChannel(value: unknown): SegmentContactChannel | null {
  return typeof value === "string" && SEGMENT_CONTACT_CHANNELS.includes(value as SegmentContactChannel)
    ? (value as SegmentContactChannel)
    : null;
}

export function summarizeCampaignPreview(rows: CampaignPreviewRow[]): CampaignPreviewSummary {
  const reasonCounts = new Map<string, number>();
  let eligible = 0;
  let excluded = 0;

  for (const row of rows) {
    if (row.eligibility_status === "eligible") eligible += 1;
    else excluded += 1;

    for (const reason of new Set(row.exclusion_reasons)) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }

  return {
    candidates: rows.length,
    eligible,
    excluded,
    reasonCounts: Array.from(reasonCounts, ([reason, count]) => ({ reason, count })).sort(
      (left, right) => right.count - left.count || left.reason.localeCompare(right.reason),
    ),
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parsePreviewRow(value: unknown): CampaignPreviewRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !isUuid(row.person_id) ||
    typeof row.full_name !== "string" ||
    !isNullableString(row.city) ||
    !isNullableString(row.source) ||
    (row.eligibility_status !== "eligible" && row.eligibility_status !== "excluded") ||
    !(row.person_contact_id === null || isUuid(row.person_contact_id)) ||
    !isNullableString(row.contact_value) ||
    !Array.isArray(row.exclusion_reasons) ||
    !row.exclusion_reasons.every((reason) => typeof reason === "string")
  ) {
    return null;
  }

  if (
    (row.eligibility_status === "eligible" &&
      (row.person_contact_id === null || row.contact_value === null || row.exclusion_reasons.length > 0)) ||
    (row.eligibility_status === "excluded" &&
      (row.person_contact_id !== null || row.contact_value !== null || row.exclusion_reasons.length === 0))
  ) {
    return null;
  }

  return row as CampaignPreviewRow;
}

export function parseCampaignPreview(value: unknown): CampaignPreview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.rows)) return null;

  const rows: CampaignPreviewRow[] = [];
  for (const valueRow of record.rows) {
    const parsed = parsePreviewRow(valueRow);
    if (!parsed) return null;
    rows.push(parsed);
  }

  const summary = summarizeCampaignPreview(rows);
  if (
    record.candidate_count !== summary.candidates ||
    record.eligible_count !== summary.eligible ||
    record.excluded_count !== summary.excluded
  ) {
    return null;
  }

  return { ...summary, rows };
}

export function filterListValue(values: readonly string[]): string {
  return values.join(", ");
}

export function exclusionReasonLabel(reason: string): string {
  return EXCLUSION_REASON_LABELS[reason] ?? reason.replaceAll("_", " ");
}
