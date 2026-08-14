export const dynamic = "force-static";

export default function SuccessPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-16">
      <section className="max-w-xl space-y-4 rounded-2xl bg-white p-8 shadow-sm ring-1 ring-stone-200">
        <h1 className="text-2xl font-semibold text-stone-900">Thank you</h1>
        <p className="text-stone-700">
          Your payment is being confirmed. This page does not confirm payment or registration.
        </p>
      </section>
    </main>
  );
}
