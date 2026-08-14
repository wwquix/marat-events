import Link from "next/link";

import { EventForm } from "../forms";

type NewEventPageProps = {
  searchParams: Promise<{ error?: string }>;
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: "Check the event fields and try again.",
  slug_exists: "That event slug is already in use.",
  database: "The event could not be saved. Try again.",
  published_event_in_past: "A published event must be scheduled in the future.",
};

export default async function NewEventPage({ searchParams }: NewEventPageProps) {
  const { error } = await searchParams;
  const errorMessage = error ? ERROR_MESSAGES[error] : null;

  return (
    <section className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-stone-500">Events</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">Create event</h1>
        </div>
        <Link className="text-sm font-medium text-stone-600 hover:text-stone-900" href="/admin">
          Back to events
        </Link>
      </div>

      {errorMessage ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      <div className="mt-6 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <EventForm />
      </div>
    </section>
  );
}
