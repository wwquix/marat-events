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

  const [contactsResult, notesResult, tasksResult, tagsResult, registrationsResult, suppressionResult] = await Promise.all([
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
      .select("id,payment_status,amount_cents,currency,created_at,paid_at,events(title,starts_at)")
      .eq("person_id", personId)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("person_suppression_events")
      .select("id,previous_status,new_status,reason,changed_by,changed_at")
      .eq("person_id", personId)
      .order("changed_at", { ascending: false })
      .limit(100),
  ]);

  if (
    contactsResult.error || notesResult.error || tasksResult.error || tagsResult.error ||
    registrationsResult.error || suppressionResult.error
  ) {
    throw new Error("Unable to load complete person history.");
  }

  const registrations = (registrationsResult.data ?? []) as unknown as RegistrationRow[];
  const registrationIds = registrations.map((row) => row.id);
  const checkInResult = registrationIds.length > 0
    ? await supabase
        .from("registration_check_ins")
        .select("registration_id,checked_in_at,method,checked_in_by")
        .in("registration_id", registrationIds)
        .eq("status", "checked_in")
    : { data: [] as CheckInRow[], error: null };
  if (checkInResult.error) throw new Error("Unable to load attendance history.");

  const person = personData as PersonRow;
  const contacts = (contactsResult.data ?? []) as ContactRow[];
  const notes = (notesResult.data ?? []) as NoteRow[];
  const tasks = (tasksResult.data ?? []) as TaskRow[];
  const tags = (tagsResult.data ?? []) as unknown as TagRow[];
  const checkInByRegistration = new Map(
    ((checkInResult.data ?? []) as CheckInRow[]).map((row) => [row.registration_id, row]),
  );
  const suppressionEvents = (suppressionResult.data ?? []) as SuppressionEventRow[];
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
