import Link from "next/link";
import { notFound } from "next/navigation";

import { validateAdminId } from "@/lib/admin/events";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import {
  assignPersonTagAction,
  createFollowUpTaskAction,
  createPersonNoteAction,
  removePersonTagAction,
  setFollowUpTaskStatusAction,
  setPersonSuppressionAction,
} from "../actions";

type PersonPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type PersonRow = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  gender: string | null;
  city: string | null;
  occupation: string | null;
  education: string | null;
  source: string | null;
  source_reference: string | null;
  suppression_status: "active" | "suppressed";
  suppression_reason: string | null;
  identity_status: "resolved" | "review_required";
  created_at: string;
  updated_at: string;
};

type ContactRow = {
  id: string;
  channel: string;
  value: string;
  is_primary: boolean;
  consent_status: string;
  contactability_status: string;
  source: string | null;
};

type NoteRow = { id: string; body: string; created_by: string; created_at: string };
type TaskRow = {
  id: string;
  title: string;
  details: string | null;
  status: "open" | "completed" | "cancelled";
  due_at: string | null;
  assigned_to: string | null;
  created_by: string;
  created_at: string;
};
type TagRow = { tag_id: string; person_tags: { id: string; name: string } | { id: string; name: string }[] | null };
type EventRelation = { title: string; starts_at: string };
type RegistrationRow = {
  id: string;
  payment_status: string;
  amount_cents: number;
  currency: string;
  created_at: string;
  paid_at: string | null;
  events: EventRelation | EventRelation[] | null;
};
type CheckInRow = { registration_id: string; checked_in_at: string; method: string; checked_in_by: string };
type SuppressionEventRow = {
  id: string;
  previous_status: string;
  new_status: string;
  reason: string;
  changed_by: string;
  changed_at: string;
};

type CampaignRecipientHistoryRow = {
  id: string;
  campaign_id: string;
  channel: string;
  eligibility: "eligible" | "blocked";
  policy_reason: string;
  created_at: string;
};

type CampaignHistoryRow = {
  id: string;
  event_id: string;
  name: string;
  status: string;
  delivery_mode: "disabled" | "dry_run";
  created_at: string;
};

type EventHistoryRow = {
  id: string;
  title: string;
  starts_at: string;
};

type OutboxHistoryRow = {
  id: string;
  campaign_recipient_id: string;
  status: string;
  last_result_code: string | null;
  updated_at: string;
};

type InvitationHistoryRow = {
  id: string;
  campaign_recipient_id: string;
  status: "active" | "revoked";
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
};

type InvitationAttributionRow = {
  id: string;
  campaign_recipient_id: string;
  invitation_token_id: string;
  payment_status: string;
  created_at: string;
};

type PersonMatchingProfileRow = {
  id: string;
  event_id: string;
  display_name: string;
  created_at: string;
};

type MutualMatchHistoryRow = {
  id: string;
  event_id: string;
  profile_one_id: string;
  profile_two_id: string;
  notification_status: string;
  created_at: string;
};

type MatchProfileRow = {
  id: string;
  display_name: string;
};

const HISTORY_LIMIT = 200;

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function firstRelation<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function notice(result: string): string | null {
  const messages: Record<string, string> = {
    note_created: "Internal note added.",
    task_created: "Follow-up task created.",
    task_completed: "Task completed.",
    task_cancelled: "Task cancelled.",
    tag_assigned: "Tag assigned.",
    tag_removed: "Tag removed.",
    suppression_updated: "Suppression state updated and audited.",
    invalid_note: "Enter a note between 1 and 4,000 characters.",
    invalid_task: "Check the task fields and New York due time.",
    invalid_tag: "Use a short tag containing letters, numbers, spaces, hyphens, or underscores.",
    invalid_suppression: "A suppression change requires an explicit reason.",
    database_error: "The change could not be saved safely.",
  };
  return messages[result] ?? null;
}

export default async function PersonPage({ params, searchParams }: PersonPageProps) {
  const personId = validateAdminId((await params).id);
  if (!personId) notFound();

  const supabase = createSupabaseServerClient();
  const { data: personData, error: personError } = await supabase
    .from("people")
    .select(
      "id,full_name,email,phone,gender,city,occupation,education,source,source_reference,suppression_status,suppression_reason,identity_status,created_at,updated_at",
    )
    .eq("id", personId)
    .maybeSingle();

  if (personError) throw new Error("Unable to load person record.");
  if (!personData) notFound();

  const [
    contactsResult,
    notesResult,
    tasksResult,
    tagsResult,
    registrationsResult,
    suppressionResult,
    campaignRecipientsResult,
    matchingProfilesResult,
  ] = await Promise.all([
    supabase
      .from("person_contacts")
      .select("id,channel,value,is_primary,consent_status,contactability_status,source")
      .eq("person_id", personId)
      .order("is_primary", { ascending: false })
      .order("channel", { ascending: true }),
    supabase
      .from("person_notes")
      .select("id,body,created_by,created_at")
      .eq("person_id", personId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("follow_up_tasks")
      .select("id,title,details,status,due_at,assigned_to,created_by,created_at")
      .eq("person_id", personId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("person_tag_assignments")
      .select("tag_id,person_tags(id,name)")
      .eq("person_id", personId)
      .order("assigned_at", { ascending: true }),
    supabase
      .from("registrations")
      .select("id,payment_status,amount_cents,currency,created_at,paid_at,events(title,starts_at)", { count: "exact" })
      .eq("person_id", personId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(HISTORY_LIMIT),
    supabase
      .from("person_suppression_events")
      .select("id,previous_status,new_status,reason,changed_by,changed_at")
      .eq("person_id", personId)
      .order("changed_at", { ascending: false })
      .limit(100),
    supabase
      .from("campaign_recipients")
      .select("id,campaign_id,channel,eligibility,policy_reason,created_at", { count: "exact" })
      .eq("person_id", personId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(HISTORY_LIMIT),
    supabase
      .from("matching_participant_profiles")
      .select("id,event_id,display_name,created_at,registrations!inner(person_id)", { count: "exact" })
      .eq("registrations.person_id", personId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(HISTORY_LIMIT),
  ]);

  if (
    contactsResult.error || notesResult.error || tasksResult.error || tagsResult.error ||
    registrationsResult.error || suppressionResult.error || campaignRecipientsResult.error || matchingProfilesResult.error
  ) {
    throw new Error("Unable to load complete person history.");
  }

  const registrations = (registrationsResult.data ?? []) as unknown as RegistrationRow[];
  const campaignRecipients = (campaignRecipientsResult.data ?? []) as CampaignRecipientHistoryRow[];
  const matchingProfiles = (matchingProfilesResult.data ?? []) as unknown as PersonMatchingProfileRow[];
  const registrationIds = registrations.map((row) => row.id);
  const campaignIds = [...new Set(campaignRecipients.map((row) => row.campaign_id))];
  const campaignRecipientIds = campaignRecipients.map((row) => row.id);
  const matchingProfileIds = matchingProfiles.map((row) => row.id);

  const [
    checkInResult,
    campaignsResult,
    outboxResult,
    invitationsResult,
    attributionResult,
    mutualMatchesResult,
  ] = await Promise.all([
    registrationIds.length > 0
      ? supabase
          .from("registration_check_ins")
          .select("registration_id,checked_in_at,method,checked_in_by")
          .in("registration_id", registrationIds)
          .eq("status", "checked_in")
      : Promise.resolve({ data: [] as CheckInRow[], error: null }),
    campaignIds.length > 0
      ? supabase
          .from("campaigns")
          .select("id,event_id,name,status,delivery_mode,created_at")
          .in("id", campaignIds)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(HISTORY_LIMIT)
      : Promise.resolve({ data: [] as CampaignHistoryRow[], error: null }),
    campaignRecipientIds.length > 0
      ? supabase
          .from("outbox_messages")
          .select("id,campaign_recipient_id,status,last_result_code,updated_at", { count: "exact" })
          .in("campaign_recipient_id", campaignRecipientIds)
          .order("updated_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(HISTORY_LIMIT)
      : Promise.resolve({ data: [] as OutboxHistoryRow[], count: 0, error: null }),
    campaignRecipientIds.length > 0
      ? supabase
          .from("campaign_invitation_tokens")
          .select("id,campaign_recipient_id,status,expires_at,created_at,revoked_at", { count: "exact" })
          .in("campaign_recipient_id", campaignRecipientIds)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(HISTORY_LIMIT)
      : Promise.resolve({ data: [] as InvitationHistoryRow[], count: 0, error: null }),
    campaignRecipientIds.length > 0
      ? supabase
          .from("registrations")
          .select("id,campaign_recipient_id,invitation_token_id,payment_status,created_at", { count: "exact" })
          .in("campaign_recipient_id", campaignRecipientIds)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(HISTORY_LIMIT)
      : Promise.resolve({ data: [] as InvitationAttributionRow[], count: 0, error: null }),
    matchingProfileIds.length > 0
      ? supabase
          .from("matching_matches")
          .select("id,event_id,profile_one_id,profile_two_id,notification_status,created_at", { count: "exact" })
          .or(
            `profile_one_id.in.(${matchingProfileIds.join(",")}),profile_two_id.in.(${matchingProfileIds.join(",")})`,
          )
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(HISTORY_LIMIT)
      : Promise.resolve({ data: [] as MutualMatchHistoryRow[], count: 0, error: null }),
  ]);

  if (
    checkInResult.error || campaignsResult.error || outboxResult.error || invitationsResult.error ||
    attributionResult.error || mutualMatchesResult.error
  ) {
    throw new Error("Unable to load communication and match history.");
  }

  const campaigns = (campaignsResult.data ?? []) as CampaignHistoryRow[];
  const outboxMessages = (outboxResult.data ?? []) as OutboxHistoryRow[];
  const invitations = (invitationsResult.data ?? []) as InvitationHistoryRow[];
  const invitationAttributions = (attributionResult.data ?? []) as InvitationAttributionRow[];
  const mutualMatches = (mutualMatchesResult.data ?? []) as MutualMatchHistoryRow[];
  const ownMatchingProfileIds = new Set(matchingProfileIds);
  const counterpartProfileIds = [...new Set(mutualMatches.flatMap((match) => {
    if (ownMatchingProfileIds.has(match.profile_one_id) && !ownMatchingProfileIds.has(match.profile_two_id)) {
      return [match.profile_two_id];
    }
    if (ownMatchingProfileIds.has(match.profile_two_id) && !ownMatchingProfileIds.has(match.profile_one_id)) {
      return [match.profile_one_id];
    }
    return [];
  }))];
  const campaignEventIds = [...new Set(campaigns.map((campaign) => campaign.event_id))];
  const matchEventIds = [...new Set(mutualMatches.map((match) => match.event_id))];

  const [campaignEventsResult, matchEventsResult, counterpartProfilesResult] = await Promise.all([
    campaignEventIds.length > 0
      ? supabase
          .from("events")
          .select("id,title,starts_at")
          .in("id", campaignEventIds)
          .order("starts_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(HISTORY_LIMIT)
      : Promise.resolve({ data: [] as EventHistoryRow[], error: null }),
    matchEventIds.length > 0
      ? supabase
          .from("events")
          .select("id,title,starts_at")
          .in("id", matchEventIds)
          .order("starts_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(HISTORY_LIMIT)
      : Promise.resolve({ data: [] as EventHistoryRow[], error: null }),
    counterpartProfileIds.length > 0
      ? supabase
          .from("matching_participant_profiles")
          .select("id,display_name")
          .in("id", counterpartProfileIds)
          .order("display_name", { ascending: true })
          .order("id", { ascending: true })
          .limit(HISTORY_LIMIT)
      : Promise.resolve({ data: [] as MatchProfileRow[], error: null }),
  ]);

  if (campaignEventsResult.error || matchEventsResult.error || counterpartProfilesResult.error) {
    throw new Error("Unable to load communication and match history.");
  }

  const person = personData as PersonRow;
  const contacts = (contactsResult.data ?? []) as ContactRow[];
  const notes = (notesResult.data ?? []) as NoteRow[];
  const tasks = (tasksResult.data ?? []) as TaskRow[];
  const tags = (tagsResult.data ?? []) as unknown as TagRow[];
  const checkInByRegistration = new Map(
    ((checkInResult.data ?? []) as CheckInRow[]).map((row) => [row.registration_id, row]),
  );
  const suppressionEvents = (suppressionResult.data ?? []) as SuppressionEventRow[];
  const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const campaignEventById = new Map(
    ((campaignEventsResult.data ?? []) as EventHistoryRow[]).map((event) => [event.id, event]),
  );
  const matchEventById = new Map(
    ((matchEventsResult.data ?? []) as EventHistoryRow[]).map((event) => [event.id, event]),
  );
  const outboxByRecipientId = new Map(outboxMessages.map((entry) => [entry.campaign_recipient_id, entry]));
  const invitationsByRecipientId = new Map<string, InvitationHistoryRow[]>();
  for (const invitation of invitations) {
    const rows = invitationsByRecipientId.get(invitation.campaign_recipient_id) ?? [];
    rows.push(invitation);
    invitationsByRecipientId.set(invitation.campaign_recipient_id, rows);
  }
  const attributionByInvitationId = new Map<string, InvitationAttributionRow[]>();
  for (const attribution of invitationAttributions) {
    const rows = attributionByInvitationId.get(attribution.invitation_token_id) ?? [];
    rows.push(attribution);
    attributionByInvitationId.set(attribution.invitation_token_id, rows);
  }
  const matchProfileById = new Map<string, MatchProfileRow>([
    ...matchingProfiles.map((profile) => [profile.id, { id: profile.id, display_name: profile.display_name }] as const),
    ...((counterpartProfilesResult.data ?? []) as MatchProfileRow[]).map((profile) => [profile.id, profile] as const),
  ]);
  const campaignHistoryMalformed = campaignRecipients.some((recipient) => {
    const campaign = campaignById.get(recipient.campaign_id);
    return !campaign || !campaignEventById.has(campaign.event_id);
  });
  const matchHistoryMalformed = mutualMatches.some((match) => {
    const belongsToPerson = ownMatchingProfileIds.has(match.profile_one_id) || ownMatchingProfileIds.has(match.profile_two_id);
    return (
      !belongsToPerson ||
      !matchProfileById.has(match.profile_one_id) ||
      !matchProfileById.has(match.profile_two_id) ||
      !matchEventById.has(match.event_id)
    );
  });
  if (campaignHistoryMalformed || matchHistoryMalformed) {
    throw new Error("Unable to load communication and match history.");
  }

  const registrationHistoryTotal = registrationsResult.count ?? registrations.length;
  const campaignHistoryTotal = campaignRecipientsResult.count ?? campaignRecipients.length;
  const outboxHistoryTotal = outboxResult.count ?? outboxMessages.length;
  const invitationHistoryTotal = invitationsResult.count ?? invitations.length;
  const attributionHistoryTotal = attributionResult.count ?? invitationAttributions.length;
  const matchingProfileHistoryTotal = matchingProfilesResult.count ?? matchingProfiles.length;
  const mutualMatchHistoryTotal = mutualMatchesResult.count ?? mutualMatches.length;
  const message = notice(firstParam((await searchParams).result));

  return (
    <section>
      <Link className="text-sm font-medium text-stone-500 hover:text-stone-900" href="/admin/people">← People</Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-stone-900">{person.full_name}</h1>
          <p className="mt-2 text-sm text-stone-600">
            {[person.gender, person.city, person.occupation].filter(Boolean).join(" · ") || "No profile metadata"}
          </p>
        </div>
        <div className="flex gap-2 text-xs font-semibold">
          <span className={`rounded-full px-3 py-1.5 ${person.suppression_status === "suppressed" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
            {person.suppression_status}
          </span>
          <span className="rounded-full bg-stone-100 px-3 py-1.5 text-stone-700">{person.identity_status}</span>
        </div>
      </div>

      {message ? <p className="mt-6 rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700">{message}</p> : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-stone-900">Contacts and safety</h2>
          <div className="mt-4 space-y-3">
            {contacts.length === 0 ? <p className="text-sm text-stone-500">No contacts.</p> : contacts.map((contact) => (
              <div className="rounded-lg border border-stone-100 p-3" key={contact.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-stone-900">{contact.channel}{contact.is_primary ? " · primary" : ""}</p>
                  <p className="text-xs text-stone-500">{contact.consent_status} · {contact.contactability_status}</p>
                </div>
                <p className="mt-1 break-all text-sm text-stone-700">{contact.value}</p>
              </div>
            ))}
          </div>

          <form action={setPersonSuppressionAction} className="mt-5 border-t border-stone-100 pt-4">
            <input name="person_id" type="hidden" value={personId} />
            <input name="status" type="hidden" value={person.suppression_status === "suppressed" ? "active" : "suppressed"} />
            <label className="text-sm font-medium text-stone-700">
              Reason for {person.suppression_status === "suppressed" ? "reactivation" : "suppression"}
              <input className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" maxLength={500} name="reason" required />
            </label>
            <button className={`mt-3 rounded-lg px-3 py-2 text-sm font-semibold ${person.suppression_status === "suppressed" ? "bg-stone-900 text-white" : "border border-red-200 text-red-700"}`} type="submit">
              {person.suppression_status === "suppressed" ? "Reactivate with audit" : "Suppress person"}
            </button>
          </form>
        </section>

        <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-stone-900">Tags</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {tags.map((assignment) => {
              const tag = firstRelation(assignment.person_tags);
              return tag ? (
                <form action={removePersonTagAction} key={assignment.tag_id}>
                  <input name="person_id" type="hidden" value={personId} />
                  <input name="tag_id" type="hidden" value={assignment.tag_id} />
                  <button className="rounded-full bg-stone-100 px-3 py-1.5 text-xs font-medium text-stone-700" title="Remove tag" type="submit">
                    {tag.name} ×
                  </button>
                </form>
              ) : null;
            })}
          </div>
          <form action={assignPersonTagAction} className="mt-4 flex gap-2">
            <input name="person_id" type="hidden" value={personId} />
            <input className="min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm" maxLength={60} name="tag" placeholder="vip, follow-up, host" required />
            <button className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium" type="submit">Add</button>
          </form>

          <h2 className="mt-7 text-lg font-semibold text-stone-900">Source</h2>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-stone-500">Source</dt><dd className="text-stone-800">{person.source ?? "—"}</dd>
            <dt className="text-stone-500">Reference</dt><dd className="break-all text-stone-800">{person.source_reference ?? "—"}</dd>
            <dt className="text-stone-500">Created</dt><dd className="text-stone-800">{formatDateTime(person.created_at)}</dd>
          </dl>
        </section>
      </div>

      <section className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-900">Follow-up tasks</h2>
        <form action={createFollowUpTaskAction} className="mt-4 grid gap-3 md:grid-cols-2">
          <input name="person_id" type="hidden" value={personId} />
          <input className="rounded-lg border border-stone-300 px-3 py-2 text-sm" maxLength={200} name="title" placeholder="Task title" required />
          <input className="rounded-lg border border-stone-300 px-3 py-2 text-sm" maxLength={254} name="assigned_to" placeholder="Assignee (optional)" />
          <input className="rounded-lg border border-stone-300 px-3 py-2 text-sm" name="due_at" type="datetime-local" />
          <textarea className="rounded-lg border border-stone-300 px-3 py-2 text-sm md:col-span-2" maxLength={2000} name="details" placeholder="Details (optional)" rows={2} />
          <button className="w-fit rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white" type="submit">Create task</button>
        </form>
        <div className="mt-5 space-y-3">
          {tasks.map((task) => (
            <div className="rounded-lg border border-stone-100 p-4" key={task.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-stone-900">{task.title}</p>
                  {task.details ? <p className="mt-1 whitespace-pre-wrap text-sm text-stone-600">{task.details}</p> : null}
                  <p className="mt-2 text-xs text-stone-500">
                    {task.status}{task.due_at ? ` · due ${formatDateTime(task.due_at)}` : ""}{task.assigned_to ? ` · ${task.assigned_to}` : ""}
                  </p>
                </div>
                {task.status === "open" ? (
                  <div className="flex gap-2">
                    {(["completed", "cancelled"] as const).map((status) => (
                      <form action={setFollowUpTaskStatusAction} key={status}>
                        <input name="person_id" type="hidden" value={personId} />
                        <input name="task_id" type="hidden" value={task.id} />
                        <input name="status" type="hidden" value={status} />
                        <button className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium" type="submit">{status}</button>
                      </form>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-900">Event and payment history</h2>
        {registrationHistoryTotal > registrations.length ? (
          <p className="mt-2 text-xs text-amber-700">
            Showing the newest {registrations.length} of {registrationHistoryTotal} registrations.
          </p>
        ) : null}
        <div className="mt-4 divide-y divide-stone-100">
          {registrations.length === 0 ? <p className="py-4 text-sm text-stone-500">No registrations.</p> : registrations.map((registration) => {
            const event = firstRelation(registration.events);
            const checkIn = checkInByRegistration.get(registration.id);
            return (
              <Link className="flex flex-wrap items-center justify-between gap-3 py-4 hover:text-stone-950" href={`/admin/registrations/${registration.id}`} key={registration.id}>
                <div>
                  <p className="font-medium text-stone-900">{event?.title ?? "Event"}</p>
                  <p className="mt-1 text-xs text-stone-500">{event ? formatDateTime(event.starts_at) : formatDateTime(registration.created_at)}</p>
                </div>
                <div className="text-right text-sm">
                  <p className="font-medium text-stone-800">{formatMoney(registration.amount_cents, registration.currency)} · {registration.payment_status}</p>
                  <p className="mt-1 text-xs text-stone-500">{checkIn ? `checked in · ${checkIn.method}` : "not checked in"}</p>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-900">Campaign, invitation, and outbox history</h2>
        <p className="mt-2 text-sm text-stone-500">
          Operational states are shown without repeating message destinations or rendered message content.
        </p>
        {campaignHistoryTotal > campaignRecipients.length ? (
          <p className="mt-2 text-xs text-amber-700">
            Campaign scope is truncated to the newest {campaignRecipients.length} of {campaignHistoryTotal} recipient snapshots.
          </p>
        ) : null}
        {outboxHistoryTotal > outboxMessages.length || invitationHistoryTotal > invitations.length || attributionHistoryTotal > invitationAttributions.length ? (
          <p className="mt-2 text-xs text-amber-700">
            Related history is truncated in this campaign scope: outbox {outboxMessages.length}/{outboxHistoryTotal}, invitations {invitations.length}/{invitationHistoryTotal}, attributed registrations {invitationAttributions.length}/{attributionHistoryTotal}.
          </p>
        ) : null}
        <div className="mt-4 divide-y divide-stone-100">
          {campaignRecipients.length === 0 ? (
            <p className="py-4 text-sm text-stone-500">No campaign recipient history.</p>
          ) : campaignRecipients.map((recipient) => {
            const campaign = campaignById.get(recipient.campaign_id)!;
            const event = campaignEventById.get(campaign.event_id)!;
            const outbox = outboxByRecipientId.get(recipient.id);
            const recipientInvitations = invitationsByRecipientId.get(recipient.id) ?? [];

            return (
              <article className="py-4" key={recipient.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Link className="font-medium text-stone-900 hover:underline" href={`/admin/campaigns/${campaign.id}`}>
                      {campaign.name}
                    </Link>
                    <p className="mt-1 text-xs text-stone-500">
                      {event.title} · {formatDateTime(event.starts_at)}
                    </p>
                    <p className="mt-1 text-xs text-stone-500">
                      {recipient.channel} · {recipient.eligibility} · {recipient.policy_reason} · {campaign.delivery_mode}
                    </p>
                  </div>
                  <div className="text-right text-sm">
                    <p className="font-medium text-stone-800">Campaign {campaign.status}</p>
                    <p className="mt-1 text-xs text-stone-500">
                      Outbox {outbox?.status ?? "not queued"}
                      {outbox?.last_result_code ? ` · ${outbox.last_result_code}` : ""}
                      {outbox ? ` · updated ${formatDateTime(outbox.updated_at)}` : ""}
                    </p>
                  </div>
                </div>

                <div className="mt-3 rounded-lg bg-stone-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Invitation links</p>
                  {recipientInvitations.length === 0 ? (
                    <p className="mt-2 text-sm text-stone-500">No invitation link issued in the visible history.</p>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {recipientInvitations.map((invitation) => {
                        const attributedRegistrations = attributionByInvitationId.get(invitation.id) ?? [];
                        return (
                          <div className="text-sm text-stone-700" key={invitation.id}>
                            <p>
                              {invitation.status} · issued {formatDateTime(invitation.created_at)} · expires {formatDateTime(invitation.expires_at)}
                              {invitation.revoked_at ? ` · revoked ${formatDateTime(invitation.revoked_at)}` : ""}
                            </p>
                            {attributedRegistrations.length === 0 ? (
                              <p className="mt-1 text-xs text-stone-500">No attributed registration in the visible history.</p>
                            ) : attributedRegistrations.map((registration) => (
                              <Link
                                className="mt-1 block text-xs font-medium text-stone-600 hover:underline"
                                href={`/admin/registrations/${registration.id}`}
                                key={registration.id}
                              >
                                Attributed registration · {registration.payment_status} · {formatDateTime(registration.created_at)}
                              </Link>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-stone-900">Mutual match history</h2>
        <p className="mt-2 text-sm text-stone-500">
          Only confirmed mutual matches are shown. One-sided reactions and counts are intentionally unavailable here.
        </p>
        {matchingProfileHistoryTotal > matchingProfiles.length ? (
          <p className="mt-2 text-xs text-amber-700">
            Match scope is truncated to the newest {matchingProfiles.length} of {matchingProfileHistoryTotal} participant profiles.
          </p>
        ) : null}
        {mutualMatchHistoryTotal > mutualMatches.length ? (
          <p className="mt-2 text-xs text-amber-700">
            Showing the newest {mutualMatches.length} of {mutualMatchHistoryTotal} mutual matches in the visible profile scope.
          </p>
        ) : null}
        <div className="mt-4 divide-y divide-stone-100">
          {mutualMatches.length === 0 ? (
            <p className="py-4 text-sm text-stone-500">No confirmed mutual matches.</p>
          ) : mutualMatches.map((match) => {
            const ownProfileId = ownMatchingProfileIds.has(match.profile_one_id)
              ? match.profile_one_id
              : match.profile_two_id;
            const counterpartProfileId = ownProfileId === match.profile_one_id
              ? match.profile_two_id
              : match.profile_one_id;
            const counterpart = matchProfileById.get(counterpartProfileId)!;
            const event = matchEventById.get(match.event_id)!;

            return (
              <article className="flex flex-wrap items-center justify-between gap-3 py-4" key={match.id}>
                <div>
                  <p className="font-medium text-stone-900">Matched with {counterpart.display_name}</p>
                  <p className="mt-1 text-xs text-stone-500">{event.title} · {formatDateTime(event.starts_at)}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-stone-700">{formatDateTime(match.created_at)}</p>
                  <Link className="mt-1 block text-xs font-medium text-stone-500 hover:underline" href={`/admin/matching/${event.id}`}>
                    Matching administration · {match.notification_status}
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-stone-900">Internal notes</h2>
          <form action={createPersonNoteAction} className="mt-4">
            <input name="person_id" type="hidden" value={personId} />
            <textarea className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm" maxLength={4000} name="body" required rows={4} />
            <button className="mt-2 rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white" type="submit">Add note</button>
          </form>
          <div className="mt-5 space-y-3">
            {notes.map((note) => (
              <article className="rounded-lg bg-stone-50 p-3" key={note.id}>
                <p className="whitespace-pre-wrap text-sm text-stone-700">{note.body}</p>
                <p className="mt-2 text-xs text-stone-500">{note.created_by} · {formatDateTime(note.created_at)}</p>
              </article>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-stone-900">Suppression audit</h2>
          <div className="mt-4 space-y-3">
            {suppressionEvents.length === 0 ? <p className="text-sm text-stone-500">No suppression changes.</p> : suppressionEvents.map((entry) => (
              <article className="rounded-lg bg-stone-50 p-3" key={entry.id}>
                <p className="text-sm font-medium text-stone-800">{entry.previous_status} → {entry.new_status}</p>
                <p className="mt-1 text-sm text-stone-600">{entry.reason}</p>
                <p className="mt-2 text-xs text-stone-500">{entry.changed_by} · {formatDateTime(entry.changed_at)}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </section>
  );
}
