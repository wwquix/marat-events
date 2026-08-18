import Link from "next/link";
import { notFound } from "next/navigation";

import { validateAdminId } from "@/lib/admin/events";
import { checkInOutcomeMessage, isCheckInOutcome } from "@/lib/checkin/policy";
import { loadCompleteRange } from "@/lib/audience/load";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import {
  issueCheckInTokenAction,
  manualCheckInAction,
  processTokenCheckInAction,
  revokeCheckInTokenAction,
} from "../actions";

const MAX_EVENT_REGISTRATIONS = 5_000;
const OPERATOR_PAGE_SIZE = 100;

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
  id: string;
  registration_id: string;
  method: "token" | "manual";
  status: "checked_in" | "voided";
  checked_in_at: string;
  checked_in_by: string;
};

type TokenRow = {
  id: string;
  registration_id: string;
  status: "active" | "revoked";
  expires_at: string | null;
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
  if (isCheckInOutcome(result)) return checkInOutcomeMessage(result);
  if (result === "token_revoked") return "Check-in token revoked.";
  if (result === "token_issue_failed") return "Token could not be issued. Only paid registrations are eligible.";
  if (result === "token_revoke_failed") return "Token could not be revoked.";
  if (result === "check_in_failed") return "Check-in could not be processed safely.";
  return null;
}

function pageHref(eventId: string, query: string, page: number): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return `/admin/check-in/${eventId}${suffix}`;
}

export default async function CheckInPage({ params, searchParams }: PageProps) {
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

  if (eventError) throw new Error("Unable to load check-in event.");
  if (!event) notFound();

  let registrations: RegistrationRow[];
  let checkIns: CheckInRow[];
  let tokens: TokenRow[];

  try {
    [registrations, checkIns, tokens] = await Promise.all([
      loadCompleteRange<RegistrationRow>({
        maxTotal: MAX_EVENT_REGISTRATIONS,
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
        maxTotal: MAX_EVENT_REGISTRATIONS,
        fetchRange: async (from, to) => {
          const response = await supabase
            .from("registration_check_ins")
            .select("id,registration_id,method,status,checked_in_at,checked_in_by", { count: "exact" })
            .eq("event_id", eventId)
            .eq("status", "checked_in")
            .order("checked_in_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to);
          return { data: response.data as CheckInRow[] | null, count: response.count, error: response.error };
        },
      }),
      loadCompleteRange<TokenRow>({
        maxTotal: MAX_EVENT_REGISTRATIONS,
        fetchRange: async (from, to) => {
          const response = await supabase
            .from("registration_check_in_tokens")
            .select("id,registration_id,status,expires_at", { count: "exact" })
            .eq("event_id", eventId)
            .eq("status", "active")
            .order("issued_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to);
          return { data: response.data as TokenRow[] | null, count: response.count, error: response.error };
        },
      }),
    ]);
  } catch {
    throw new Error("Unable to load complete check-in state.");
  }

  const typedEvent = event as EventRow;
  const checkInByRegistration = new Map(checkIns.map((row) => [row.registration_id, row]));
  const tokenByRegistration = new Map(tokens.map((row) => [row.registration_id, row]));
  const filtered = registrations.filter((registration) => {
    if (!query) return true;
    return (
      registration.full_name.toLocaleLowerCase("en-US").includes(query) ||
      registration.email.toLocaleLowerCase("en-US").includes(query)
    );
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / OPERATOR_PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);
  const start = (currentPage - 1) * OPERATOR_PAGE_SIZE;
  const visible = filtered.slice(start, start + OPERATOR_PAGE_SIZE);
  const notice = resultMessage(result);

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href={`/admin/events/${eventId}`}>
            ← Event administration
          </Link>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">Check-in · {typedEvent.title}</h1>
          <p className="mt-2 text-sm text-stone-600">
            {formatDateTime(typedEvent.starts_at)} · {checkIns.length} of {registrations.length} paid guests checked in
          </p>
        </div>
      </div>

      {notice ? (
        <p className="mt-6 rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700 shadow-sm">
          {notice}
        </p>
      ) : null}

      <form action={processTokenCheckInAction} className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <input name="event_id" type="hidden" value={eventId} />
        <label className="block text-sm font-medium text-stone-800">
          Scan result or token
          <input
            autoComplete="off"
            autoFocus
            className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-3 font-mono text-sm"
            maxLength={2048}
            name="token"
            placeholder="Paste token, QR value, or ticket URL"
            required
          />
        </label>
        <button className="mt-3 w-full rounded-lg bg-stone-900 px-4 py-3 text-sm font-semibold text-white sm:w-auto" type="submit">
          Process check-in
        </button>
      </form>

      <form className="mt-6 flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:flex-row" method="get">
        <input
          className="min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm"
          defaultValue={query}
          maxLength={100}
          name="q"
          placeholder="Manual fallback: search paid guest by name or email"
        />
        <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700" type="submit">
          Search
        </button>
      </form>

      <div className="mt-6 space-y-3">
        {visible.length === 0 ? (
          <p className="rounded-xl border border-stone-200 bg-white p-8 text-center text-sm text-stone-500">No paid guests match.</p>
        ) : visible.map((registration) => {
          const checkIn = checkInByRegistration.get(registration.id);
          const token = tokenByRegistration.get(registration.id);
          return (
            <article className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm" key={registration.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-stone-900">{registration.full_name}</p>
                  <p className="mt-1 text-sm text-stone-500">{registration.email}</p>
                  {checkIn ? (
                    <p className="mt-2 text-xs font-medium text-emerald-700">
                      Checked in {formatDateTime(checkIn.checked_in_at)} · {checkIn.method}
                    </p>
                  ) : token ? (
                    <p className="mt-2 text-xs text-stone-500">
                      Active token expires {token.expires_at ? formatDateTime(token.expires_at) : "—"}
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-amber-700">No active check-in token</p>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {!checkIn ? (
                    <form action={manualCheckInAction}>
                      <input name="event_id" type="hidden" value={eventId} />
                      <input name="registration_id" type="hidden" value={registration.id} />
                      <button className="rounded-lg bg-stone-900 px-3 py-2 text-xs font-semibold text-white" type="submit">
                        Manual check-in
                      </button>
                    </form>
                  ) : null}

                  <form action={issueCheckInTokenAction}>
                    <input name="event_id" type="hidden" value={eventId} />
                    <input name="registration_id" type="hidden" value={registration.id} />
                    <button className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700" type="submit">
                      {token ? "Reissue ticket" : "Issue ticket"}
                    </button>
                  </form>

                  {token ? (
                    <form action={revokeCheckInTokenAction}>
                      <input name="event_id" type="hidden" value={eventId} />
                      <input name="token_id" type="hidden" value={token.id} />
                      <button className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700" type="submit">
                        Revoke token
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
        <nav className="mt-6 flex items-center justify-between gap-3 text-sm" aria-label="Check-in guest pages">
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
