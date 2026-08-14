"use client";

export default function EventErrorBoundary() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-16">
      <section className="max-w-xl rounded-2xl bg-white p-8 shadow-sm ring-1 ring-stone-200">
        <h1 className="text-2xl font-semibold text-stone-900">Event unavailable</h1>
        <p className="mt-3 text-stone-700">Please try again later.</p>
      </section>
    </main>
  );
}

