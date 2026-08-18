const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PARTICIPANTS = 5_000;

export type MatchingEventState = Readonly<{
  id: string;
  title: string;
  startsAt: string;
}>;

export type MatchingProfileState = Readonly<{
  publicId: string;
  displayName: string;
  bio: string | null;
  activatedAt: string;
}>;

export type MatchingCandidateState = Readonly<{
  publicId: string;
  displayName: string;
  bio: string | null;
  likedByMe: boolean;
}>;

export type MutualMatchState = Readonly<{
  publicId: string;
  participantPublicId: string;
  displayName: string;
  bio: string | null;
  matchedAt: string;
}>;

export type MatchingParticipantState = Readonly<{
  event: MatchingEventState;
  profile: MatchingProfileState | null;
  candidates: MatchingCandidateState[];
  matches: MutualMatchState[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isDisplayName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 80;
}

function isEventTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.length <= 1_000;
}

function readBio(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.length <= 500 ? value : undefined;
}

export function isMatchingPublicId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function parseEvent(value: unknown): MatchingEventState | null {
  if (!isRecord(value)) return null;
  if (!isMatchingPublicId(value.id) || !isEventTitle(value.title) || !isDateTime(value.startsAt)) return null;
  return { id: value.id, title: value.title, startsAt: value.startsAt };
}

function parseProfile(value: unknown): MatchingProfileState | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const bio = readBio(value.bio);
  if (
    !isMatchingPublicId(value.publicId) ||
    !isDisplayName(value.displayName) ||
    bio === undefined ||
    !isDateTime(value.activatedAt)
  ) return undefined;

  return {
    publicId: value.publicId,
    displayName: value.displayName,
    bio,
    activatedAt: value.activatedAt,
  };
}

function parseCandidates(value: unknown): MatchingCandidateState[] | null {
  if (!Array.isArray(value) || value.length > MAX_PARTICIPANTS) return null;
  const candidates: MatchingCandidateState[] = [];

  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const bio = readBio(candidate.bio);
    if (
      !isMatchingPublicId(candidate.publicId) ||
      !isDisplayName(candidate.displayName) ||
      bio === undefined ||
      typeof candidate.likedByMe !== "boolean"
    ) return null;

    candidates.push({
      publicId: candidate.publicId,
      displayName: candidate.displayName,
      bio,
      likedByMe: candidate.likedByMe,
    });
  }

  return candidates;
}

function parseMatches(value: unknown): MutualMatchState[] | null {
  if (!Array.isArray(value) || value.length > MAX_PARTICIPANTS) return null;
  const matches: MutualMatchState[] = [];

  for (const match of value) {
    if (!isRecord(match)) return null;
    const bio = readBio(match.bio);
    if (
      !isMatchingPublicId(match.publicId) ||
      !isMatchingPublicId(match.participantPublicId) ||
      !isDisplayName(match.displayName) ||
      bio === undefined ||
      !isDateTime(match.matchedAt)
    ) return null;

    matches.push({
      publicId: match.publicId,
      participantPublicId: match.participantPublicId,
      displayName: match.displayName,
      bio,
      matchedAt: match.matchedAt,
    });
  }

  return matches;
}

export function parseMatchingParticipantState(value: unknown): MatchingParticipantState | null {
  if (!isRecord(value)) return null;
  const event = parseEvent(value.event);
  const profile = parseProfile(value.profile);
  const candidates = parseCandidates(value.candidates);
  const matches = parseMatches(value.matches);

  if (!event || profile === undefined || !candidates || !matches) return null;
  if (profile === null && (candidates.length > 0 || matches.length > 0)) return null;

  return { event, profile, candidates, matches };
}
