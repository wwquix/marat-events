import { notFound } from "next/navigation";

import { parseMatchingParticipantState } from "@/lib/matching/state";
import { hashMatchingToken, normalizeMatchingToken } from "@/lib/matching/token";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import {
  activateMatchingParticipantAction,
  likeMatchingParticipantAction,
} from "./actions";

type MatchingPageProps = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function resultMessage(result: string): string | null {
  if (result === "activated") return "Your matching profile is active.";
  if (result === "liked") return "Like saved privately.";
  if (result === "matched") return "It is a mutual match.";
  if (result === "activation_invalid") return "Check the profile fields and try again.";
  if (result === "activation_failed") return "The profile could not be activated safely.";
  if (result === "like_invalid" || result === "like_failed") return "The like could not be saved safely.";
  return null;
}

export default async function MatchingPage({ params, searchParams }: MatchingPageProps) {
  const token = normalizeMatchingToken((await params).token);
  if (!token) notFound();

  const tokenHash = hashMatchingToken(token);
  const { data, error } = await createSupabaseServerClient().rpc("get_matching_participant_state", {
    p_token_hash: tokenHash,
  });
  if (error) notFound();

  const state = parseMatchingParticipantState(data);
  if (!state) throw new Error("Unable to load matching state.");

  const result = firstParam((await searchParams).result);
  const notice = resultMessage(result);

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-6 py-12">
      <header className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-stone-500">Marat Events matching</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-stone-900">{state.event.title}</h1>
        <p className="mt-2 text-sm text-stone-600">{formatDateTime(state.event.startsAt)}</p>
        <p className="mt-4 text-xs leading-5 text-stone-500">
          This private link is a bearer credential. Do not share it. A one-sided like is visible only to you.
        </p>
      </header>

      {notice ? (
        <p className="mt-6 rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700 shadow-sm">
          {notice}
        </p>
      ) : null}

      {!state.profile ? (
        <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-stone-900">Activate your profile</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            You remain invisible until you explicitly activate. Only your display name and optional bio are shown.
          </p>
          <form action={activateMatchingParticipantAction} className="mt-5 space-y-4">
            <input name="token" type="hidden" value={token} />
            <label className="block text-sm font-medium text-stone-800">
              Display name
              <input
                autoComplete="name"
                className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2"
                maxLength={80}
                name="display_name"
                required
              />
            </label>
            <label className="block text-sm font-medium text-stone-800">
              Short bio (optional)
              <textarea
                className="mt-2 min-h-28 w-full rounded-lg border border-stone-300 px-3 py-2"
                maxLength={500}
                name="bio"
              />
            </label>
            <button className="rounded-lg bg-stone-900 px-4 py-3 text-sm font-semibold text-white" type="submit">
              Activate matching
            </button>
          </form>
        </section>
      ) : (
        <>
          <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">Profile active</p>
            <h2 className="mt-2 text-2xl font-semibold text-stone-900">{state.profile.displayName}</h2>
            {state.profile.bio ? <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-stone-600">{state.profile.bio}</p> : null}
          </section>

          <section className="mt-8">
            <h2 className="text-2xl font-semibold text-stone-900">Participants</h2>
            <p className="mt-2 text-sm text-stone-600">Only active, paid, checked-in participants from this event appear.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {state.candidates.length === 0 ? (
                <p className="rounded-xl border border-stone-200 bg-white p-6 text-sm text-stone-500 sm:col-span-2">
                  No other active participants are available yet.
                </p>
              ) : state.candidates.map((candidate) => (
                <article className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm" key={candidate.publicId}>
                  <h3 className="text-lg font-semibold text-stone-900">{candidate.displayName}</h3>
                  {candidate.bio ? <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-stone-600">{candidate.bio}</p> : null}
                  <form action={likeMatchingParticipantAction} className="mt-4">
                    <input name="token" type="hidden" value={token} />
                    <input name="target_public_id" type="hidden" value={candidate.publicId} />
                    <button
                      className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500"
                      disabled={candidate.likedByMe}
                      type="submit"
                    >
                      {candidate.likedByMe ? "Liked" : "Like privately"}
                    </button>
                  </form>
                </article>
              ))}
            </div>
          </section>

          <section className="mt-8">
            <h2 className="text-2xl font-semibold text-stone-900">Mutual matches</h2>
            <div className="mt-4 space-y-3">
              {state.matches.length === 0 ? (
                <p className="rounded-xl border border-stone-200 bg-white p-6 text-sm text-stone-500">
                  Mutual matches will appear here. Incoming one-sided likes are never disclosed.
                </p>
              ) : state.matches.map((match) => (
                <article className="rounded-xl border border-emerald-200 bg-emerald-50 p-5" key={match.publicId}>
                  <h3 className="font-semibold text-emerald-950">{match.displayName}</h3>
                  {match.bio ? <p className="mt-2 whitespace-pre-wrap text-sm text-emerald-900">{match.bio}</p> : null}
                  <p className="mt-2 text-xs text-emerald-800">Matched {formatDateTime(match.matchedAt)}</p>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
