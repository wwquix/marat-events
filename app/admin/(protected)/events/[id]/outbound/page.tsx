import Link from "next/link";
import { notFound } from "next/navigation";

import { formatAdminDateTime } from "@/lib/admin/attendees";
import { validateAdminId } from "@/lib/admin/events";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { createOutboundDryRunAction, enqueueInvitationCampaignAction } from "./actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
type Campaign = { id: string; name: string; target_channel: string; created_at: string };
type DryRun = { id: string; campaign_id: string; requested_at: string; total_count: number; allowed_count: number; blocked_count: number; delayed_count: number; already_queued_count: number };
type Message = { id: string; campaign_id: string; channel: string; status: string; available_at: string; attempts: number; last_error_code: string | null };
type DryRunResult = { id: string; channel: string; decision: string; decision_code: string; decision_reason: string; next_available_at: string | null; already_queued: boolean; person: { full_name: string } | null; contact: { value: string } | null };

function first(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }

export default async function EventOutboundPage({ params, searchParams }: Props) {
  const eventId = validateAdminId((await params).id);
  if (!eventId) notFound();
  const search = await searchParams;
  const campaignId = validateAdminId(first(search.campaign)) ?? null;
  const requestedRunId = validateAdminId(first(search.run)) ?? null;
  const supabase = createSupabaseServerClient();
  const [{ data: event }, { data: campaigns, error: campaignError }, { data: dryRuns, error: dryRunError }, { data: messages, error: messageError }] = await Promise.all([
    supabase.from("events").select("id,title").eq("id", eventId).maybeSingle(),
    supabase.from("invitation_campaigns").select("id,name,target_channel,created_at").eq("event_id", eventId).order("created_at", { ascending: false }),
    supabase.from("outbound_dry_runs").select("id,campaign_id,requested_at,total_count,allowed_count,blocked_count,delayed_count,already_queued_count").eq("event_id", eventId).order("requested_at", { ascending: false }).limit(20),
    supabase.from("outbound_messages").select("id,campaign_id,channel,status,available_at,attempts,last_error_code").eq("event_id", eventId).order("created_at", { ascending: false }).limit(100),
  ]);
  if (!event) notFound();
  if (campaignError || dryRunError || messageError) throw new Error("Unable to load outbound operations.");
  const typedCampaigns = (campaigns ?? []) as Campaign[];
  const typedRuns = (dryRuns ?? []) as DryRun[];
  const typedMessages = (messages ?? []) as Message[];
  const selected = campaignId ? typedCampaigns.find((campaign) => campaign.id === campaignId) ?? null : typedCampaigns[0] ?? null;
  const visibleRuns = typedRuns.filter((run) => !selected || run.campaign_id === selected.id);
  const selectedRun = (requestedRunId ? visibleRuns.find((run) => run.id === requestedRunId) : undefined) ?? visibleRuns[0] ?? null;
  const { data: dryRunResults, error: dryRunResultsError } = selectedRun
    ? await supabase.from("outbound_dry_run_results").select("id,channel,decision,decision_code,decision_reason,next_available_at,already_queued,person:people(full_name),contact:person_contacts(value)").eq("dry_run_id", selectedRun.id).order("created_at", { ascending: true })
    : { data: [], error: null };
  if (dryRunResultsError) throw new Error("Unable to load dry-run details.");
  const typedResults = (dryRunResults ?? []) as DryRunResult[];
  const result = first(search.result);

  return <section>
    <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href={`/admin/events/${eventId}`}>← {event.title}</Link>
    <div className="mt-3"><p className="text-sm font-medium text-stone-500">Phase 2.4 · Safe outbound</p><h1 className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">Outbound operations</h1><p className="mt-2 max-w-3xl text-stone-600">Dry runs use the database policy engine and persist their decisions. Enqueue creates provider-independent queue rows only; this release sends nothing.</p></div>
    {result ? <p className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">{result === "dry_run_created" ? "Dry run recorded." : result === "enqueued" ? "Queue rows created or reused safely." : "The operation was blocked. Refresh and review the current campaign state."}</p> : null}
    <div className="mt-6 grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside><h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Campaigns</h2><div className="mt-3 space-y-2">{typedCampaigns.map((campaign) => <Link className={`block rounded-lg border p-3 text-sm ${selected?.id === campaign.id ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 bg-white text-stone-700"}`} href={`/admin/events/${eventId}/outbound?campaign=${campaign.id}`} key={campaign.id}><span className="font-medium">{campaign.name}</span><span className="mt-1 block text-xs opacity-70">{campaign.target_channel}</span></Link>)}</div></aside>
      <div>{selected ? <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm"><h2 className="font-semibold text-stone-900">{selected.name}</h2><p className="mt-1 text-sm text-stone-500">{selected.target_channel} · created {formatAdminDateTime(selected.created_at)}</p><div className="mt-5 flex flex-wrap gap-3"><form action={createOutboundDryRunAction}><input name="event_id" type="hidden" value={eventId}/><input name="campaign_id" type="hidden" value={selected.id}/><button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-800">Run DRY_RUN</button></form><form action={enqueueInvitationCampaignAction}><input name="event_id" type="hidden" value={eventId}/><input name="campaign_id" type="hidden" value={selected.id}/><button className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white">Enqueue safely</button></form></div></div> : <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Create an audience campaign first.</p>}
      <h2 className="mt-8 font-semibold text-stone-900">Recent dry runs</h2><div className="mt-3 overflow-x-auto rounded-xl border border-stone-200 bg-white"><table className="min-w-full text-sm"><thead className="bg-stone-50 text-left text-xs uppercase text-stone-500"><tr><th className="p-3">When</th><th className="p-3">Total</th><th className="p-3">Allowed</th><th className="p-3">Delayed</th><th className="p-3">Blocked</th><th className="p-3">Queued</th></tr></thead><tbody>{visibleRuns.map((run) => <tr className="border-t border-stone-100" key={run.id}><td className="p-3"><Link className="underline" href={`/admin/events/${eventId}/outbound?campaign=${run.campaign_id}&run=${run.id}`}>{formatAdminDateTime(run.requested_at)}</Link></td><td className="p-3">{run.total_count}</td><td className="p-3">{run.allowed_count}</td><td className="p-3">{run.delayed_count}</td><td className="p-3">{run.blocked_count}</td><td className="p-3">{run.already_queued_count}</td></tr>)}</tbody></table></div>
      {selectedRun ? <div className="mt-8"><h2 className="font-semibold text-stone-900">DRY_RUN details</h2><p className="mt-1 text-sm text-stone-500">{formatAdminDateTime(selectedRun.requested_at)} · persisted run {selectedRun.id}</p><div className="mt-3 overflow-x-auto rounded-xl border border-stone-200 bg-white"><table className="min-w-full text-sm"><thead className="bg-stone-50 text-left text-xs uppercase text-stone-500"><tr><th className="p-3">Person</th><th className="p-3">Contact</th><th className="p-3">Decision</th><th className="p-3">Reason</th><th className="p-3">Next available</th><th className="p-3">Queued</th></tr></thead><tbody>{typedResults.map((row) => <tr className="border-t border-stone-100" key={row.id}><td className="p-3">{row.person?.full_name ?? "Unavailable"}</td><td className="p-3">{row.channel}{row.contact ? ` · ${row.contact.value}` : ""}</td><td className="p-3">{row.decision}<span className="mt-1 block text-xs text-stone-500">{row.decision_code}</span></td><td className="p-3">{row.decision_reason}</td><td className="p-3">{row.next_available_at ? formatAdminDateTime(row.next_available_at) : "—"}</td><td className="p-3">{row.already_queued ? "Already queued" : "No"}</td></tr>)}</tbody></table></div></div> : null}
      <h2 className="mt-8 font-semibold text-stone-900">Queue status</h2><div className="mt-3 overflow-x-auto rounded-xl border border-stone-200 bg-white"><table className="min-w-full text-sm"><thead className="bg-stone-50 text-left text-xs uppercase text-stone-500"><tr><th className="p-3">Channel</th><th className="p-3">Status</th><th className="p-3">Available</th><th className="p-3">Attempts</th><th className="p-3">Error</th></tr></thead><tbody>{typedMessages.filter((message) => !selected || message.campaign_id === selected.id).map((message) => <tr className="border-t border-stone-100" key={message.id}><td className="p-3">{message.channel}</td><td className="p-3">{message.status}</td><td className="p-3">{formatAdminDateTime(message.available_at)}</td><td className="p-3">{message.attempts}</td><td className="p-3">{message.last_error_code ?? "—"}</td></tr>)}</tbody></table></div></div>
    </div>
  </section>;
}
