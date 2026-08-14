import { redirect } from "next/navigation";

import { getAdminSession } from "@/lib/admin/session";

import { loginAdmin } from "./actions";

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function AdminLoginPage({ searchParams }: LoginPageProps) {
  const existingSession = await getAdminSession();
  if (existingSession) {
    redirect("/admin");
  }

  const { error } = await searchParams;
  const errorMessage =
    error === "config"
      ? "Admin authentication is not configured for this environment."
      : error === "invalid"
        ? "Invalid email or password."
        : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-6 py-12">
      <section className="w-full rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-medium text-stone-500">Marat Events</p>
        <h1 className="mt-2 text-2xl font-semibold text-stone-900">Admin sign in</h1>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          This area is restricted to event operations.
        </p>

        {errorMessage ? (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {errorMessage}
          </div>
        ) : null}

        <form action={loginAdmin} className="mt-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-stone-700" htmlFor="email">
              Email
            </label>
            <input
              autoComplete="username"
              className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5 text-stone-900 outline-none focus:border-stone-600"
              id="email"
              name="email"
              required
              type="email"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700" htmlFor="password">
              Password
            </label>
            <input
              autoComplete="current-password"
              className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5 text-stone-900 outline-none focus:border-stone-600"
              id="password"
              maxLength={256}
              name="password"
              required
              type="password"
            />
          </div>

          <button
            className="w-full rounded-lg bg-stone-900 px-4 py-2.5 font-medium text-white hover:bg-stone-800"
            type="submit"
          >
            Sign in
          </button>
        </form>
      </section>
    </main>
  );
}
