export default function AdminHomePage() {
  return (
    <section>
      <h1 className="text-3xl font-semibold tracking-tight text-stone-900">Event operations</h1>
      <p className="mt-2 max-w-2xl text-stone-600">
        Admin authentication is active. Event and ticket administration is the next Phase 1 task.
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <article className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-stone-500">Phase 1.2</p>
          <p className="mt-1 text-lg font-semibold text-stone-900">Identity hardening</p>
          <p className="mt-2 text-sm text-stone-600">Complete and verified on staging.</p>
        </article>

        <article className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-stone-500">Phase 1.3</p>
          <p className="mt-1 text-lg font-semibold text-stone-900">Admin authentication</p>
          <p className="mt-2 text-sm text-stone-600">Protected session established.</p>
        </article>

        <article className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-stone-500">Up next</p>
          <p className="mt-1 text-lg font-semibold text-stone-900">Events & tickets</p>
          <p className="mt-2 text-sm text-stone-600">Create, edit, publish and hide from this admin area.</p>
        </article>
      </div>
    </section>
  );
}
