export type MatchingAccessDecision =
  | "valid"
  | "invalid_token"
  | "revoked"
  | "expired"
  | "unpaid"
  | "not_checked_in";

export type MatchingTokenEligibility = Readonly<{
  tokenFound: boolean;
  tokenStatus: "active" | "revoked";
  expiresAt: Date | null;
  paymentStatus: string;
  checkedIn: boolean;
}>;

export type MatchingLikeOutcome = "liked" | "matched";

export type MatchingLikeDecision =
  | MatchingLikeOutcome
  | "self_like"
  | "cross_event"
  | "target_unavailable";

export type MatchingLikeContext = Readonly<{
  sourceProfileId: string;
  sourceEventId: string;
  targetProfileId: string;
  targetEventId: string;
  targetActive: boolean;
  reverseLikeExists: boolean;
}>;

export function decideMatchingAccess(
  eligibility: MatchingTokenEligibility,
  now: Date,
): MatchingAccessDecision {
  if (!eligibility.tokenFound) return "invalid_token";
  if (eligibility.tokenStatus === "revoked") return "revoked";
  if (!eligibility.expiresAt || eligibility.expiresAt.getTime() <= now.getTime()) return "expired";
  if (eligibility.paymentStatus !== "paid") return "unpaid";
  if (!eligibility.checkedIn) return "not_checked_in";
  return "valid";
}

export function decideMatchingLike(context: MatchingLikeContext): MatchingLikeDecision {
  if (!context.targetActive) return "target_unavailable";
  if (context.sourceEventId !== context.targetEventId) return "cross_event";
  if (context.sourceProfileId === context.targetProfileId) return "self_like";
  return context.reverseLikeExists ? "matched" : "liked";
}

export function canonicalMatchingPair(firstProfileId: string, secondProfileId: string): readonly [string, string] {
  if (!firstProfileId || !secondProfileId || firstProfileId === secondProfileId) {
    throw new Error("A matching pair requires two distinct profiles.");
  }

  return firstProfileId < secondProfileId
    ? [firstProfileId, secondProfileId]
    : [secondProfileId, firstProfileId];
}

export function isMatchingLikeOutcome(value: unknown): value is MatchingLikeOutcome {
  return value === "liked" || value === "matched";
}
