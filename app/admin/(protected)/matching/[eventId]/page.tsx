import Link from "next/link";
import { notFound } from "next/navigation";

import { validateAdminId } from "@/lib/admin/events";
import { loadCompleteRange } from "@/lib/audience/load";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { issueMatchingTokenAction, revokeMatchingTokenAction } from "../actions";

const MAX_EVENT_PARTICIPANTS = 5_000;
const ADMIN_PAGE_SIZE = 100;

type PageProps = {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type EventRow = {
  id: string;
  title: string;
  starts_at: string;
};

type RegistrationRow = {
  id: string;
  full_name: string;
  email: string;
  created_at: string;
};

type CheckInRow = {
  registration_id: string;
  checked_in_at: string;
};

type TokenRow = {
  id: string;
  registration_id: string;
  issued_at: string;
  expires_at: string;
};

type ProfileRow = {
  registration_id: string;
  display_name: string;
  status: "active" | "inactive";
  activated_at: string;
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function readPage(value: string): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function resultMessage(result: string): string | null {
  if (result === "token_revoked") return "Matching access revoked and the profile hidden.";
  if (result === "token_issue_failed") return "Access could not be issued. The guest must be paid and actively checked in.";
  if (result === "token_revoke_failed") return "Access could not be revoked safely.";
  return null;
}

function pageHref(eventId: string, query: string, page: number): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return `/admin/matching/${eventId}${suffix}`;
}

export default async function MatchingAdminPage({ params, searchParams }: PageProps) {
  const eventId = validateAdminId((await params).eventId);
  if (!eventId) notFound();

  const resolvedSearchParams = await searchParams;
  const query = firstParam(resolvedSearchParams.q).trim().slice(0, 100).toLocaleLowerCase("en-US");
  const requestedPage = readPage(firstParam(resolvedSearchParams.page));
  const result = firstParam(resolvedSearchParams.result);
  const supabase = createSupabaseServerClient();

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id,title,starts_at")
    .eq("id", eventId)
    .maybeSingle();

  if (eventError) throw new Error("Unable to load matching event.");
  if (!event) notFound();

  let registrations: RegistrationRow[];
  let checkIns: CheckInRow[];
  let tokens: TokenRow[];
  let profiles: ProfileRow[];

  try {
    [registrations, checkIns, tokens, profiles] = await Promise.all([
      loadCompleteRange<RegistrationRow>({
        maxTotal: MAX_EVENT_PARTICIPANTS,
        fetchRange: async (from, to) => {
          const response = await supabase
            .from("registrations")
            .select("id,full_name,email,created_at", { count: "exact" })
            .eq("event_id", eventId)
            .eq("payment_status", "paid")
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to);
          return { data: response.data as RegistrationRow[] | null, count: response.count, error: response.error };
        },
      }),
      loadCompleteRange<CheckInRow>({
        maxTotal: MAX_EVENT_PARTICIPANTS,
        fetchRange: async (from, to) => {
          const response = await supabase
            .from("registration_check_ins")
            .select("registration_id,checked_in_at", { count: "exact" })
            .eq("event_id", eventId)
            .eq("status", "checked_in")
            .order("checked_in_at", { ascending: true })
            .order("registration_id", { ascending: true })
            .range(from, to);
          return { data: response.data as CheckInRow[] | null, count: response.count, error: response.error };
        },
      }),
      loadCompleteRange<TokenRow>({
        maxTotal: MAX_EVENT_PARTICIPANTS,
        fetchRange: async (from, to) => {
          const response = await supabase
            .from("matching_participant_tokens")
            .select("id,registration_id,issued_at,expires_at", { count: "exact" })
            .eq("event_id", eventId)
            .eq("status", "active")
            .order("issued_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to);
          return { data: response.data as TokenRow[] | null, count: response.count, error: response.error };
        },
      }),
      loadCompleteRange<ProfileRow>({
        maxTotal: MAX_EVENT_PARTICIPANTS,
        fetchRange: async (from, to) => {
          const response = await supabase
            .from("matching_participant_profiles")
            .select("registration_id,display_name,status,activated_at", { count: "exact" })
            .eq("event_id", eventId)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to);
          return { data: response.data as ProfileRow[] | null, count: response.count, error: response.error };
        },
      }),
    ]);
  } catch {
    throw new Error("Unable to load complete matching state.");
  }

  const typedEvent = event as EventRow;
  const checkInByRegistration = new Map(checkIns.map((row) => [row.registration_id, row]));
  const tokenByRegistration = new Map(tokens.map((row) => [row.registration_id, row]));
  const profileByRegistration = new Map(profiles.map((row) => [row.registration_id, row]));
  const eligible = registrations.filter((registration) => checkInByRegistration.has(registration.id));
  const filtered = eligible.filter((registration) => {
    if (!query) return true;
    return (
      registration.full_name.toLocaleLowerCase("en-US").includes(query) ||
      registration.email.toLocaleLowerCase("en-US").includes(query)
    );
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / ADMIN_PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);
  const start = (currentPage - 1) * ADMIN_PAGE_SIZE;
  const visible = filtered.slice(start, start + ADMIN_PAGE_SIZE);
  const notice = resultMessage(result);

  return (
    <section>
      <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href={`/admin/events/${eventId}`}>
        ← Event administration
      </Link>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">Matching · {typedEvent.title}</h1>
      <p className="mt-2 text-sm text-stone-600">
        {formatDateTime(typedEvent.starts_at)} · {eligible.length} paid, checked-in guests eligible
      </p>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-500">
        Issuing access opens the new bearer link for manual delivery. The raw token is not stored, and no provider send occurs.
      </p>

      {notice ? (
        <p className="mt-6 rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700 shadow-sm">
          {notice}
        </p>
      ) : null}

      <form className="mt-6 flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:flex-row" method="get">
        <input
          className="min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm"
          defaultValue={query}
          maxLength={100}
          name="q"
          placeholder="Search checked-in guest by name or email"
        />
        <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700" type="submit">
          Search
        </button>
      </form>

      <div className="mt-6 space-y-3">
        {visible.length === 0 ? (
          <p className="rounded-xl border border-stone-200 bg-white p-8 text-center text-sm text-stone-500">
            No eligible guests match.
          </p>
        ) : visible.map((registration) => {
          const checkIn = checkInByRegistration.get(registration.id);
          const token = tokenByRegistration.get(registration.id);
          const profile = profileByRegistration.get(registration.id);
          return (
            <article className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm" key={registration.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-stone-900">{registration.full_name}</p>
                  <p className="mt-1 text-sm text-stone-500">{registration.email}</p>
                  <p className="mt-2 text-xs text-emerald-700">
                    Checked in {checkIn ? formatDateTime(checkIn.checked_in_at) : "—"}
                  </p>
                  {profile ? (
                    <p className="mt-1 text-xs text-stone-500">
                      Profile: {profile.status} · {profile.display_name} · activated {formatDateTime(profile.activated_at)}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-stone-500">Profile not activated</p>
                  )}
                  {token ? (
                    <p className="mt-1 text-xs text-stone-500">Access expires {formatDateTime(token.expires_at)}</p>
                  ) : (
                    <p className="mt-1 text-xs text-amber-700">No active access token</p>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  <form action={issueMatchingTokenAction}>
                    <input name="event_id" type="hidden" value={eventId} />
                    <input name="registration_id" type="hidden" value={registration.id} />
                    <button className="rounded-lg bg-stone-900 px-3 py-2 text-xs font-semibold text-white" type="submit">
                      {token ? "Reissue access" : "Issue access"}
                    </button>
                  </form>
                  {token ? (
                    <form action={revokeMatchingTokenAction}>
                      <input name="event_id" type="hidden" value={eventId} />
                      <input name="token_id" type="hidden" value={token.id} />
                      <button className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700" type="submit">
                        Revoke access
                      </button>
                    </form>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {totalPages > 1 ? (
        <nav className="mt-6 flex items-center justify-between gap-3 text-sm" aria-label="Matching guest pages">
          {currentPage > 1 ? (
            <Link className="rounded-lg border border-stone-300 bg-white px-3 py-2" href={pageHref(eventId, query, currentPage - 1)}>
              Previous
            </Link>
          ) : <span />}
          <span className="text-stone-600">Page {currentPage} of {totalPages}</span>
          {currentPage < totalPages ? (
            <Link className="rounded-lg border border-stone-300 bg-white px-3 py-2" href={pageHref(eventId, query, currentPage + 1)}>
              Next
            </Link>
          ) : <span />}
        </nav>
      ) : null}
    </section>
  );
}
