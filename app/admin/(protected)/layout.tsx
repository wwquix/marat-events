import type { ReactNode } from "react";
import Link from "next/link";

import { requireAdminSession } from "@/lib/admin/session";

import { logoutAdmin } from "../actions";

export const dynamic = "force-dynamic";

export default async function ProtectedAdminLayout({ children }: { children: ReactNode }) {
  const session = await requireAdminSession();

  return (
    <div className="min-h-screen bg-stone-100">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="text-sm font-medium text-stone-500">Marat Events</p>
            <p className="font-semibold text-stone-900">Admin</p>
          </div>

          <nav aria-label="Admin sections" className="order-3 flex w-full flex-wrap gap-x-4 gap-y-2 text-sm font-medium text-stone-600 lg:order-none lg:w-auto">
            <Link className="hover:text-stone-950" href="/admin">Events</Link>
            <Link className="hover:text-stone-950" href="/admin/people">People</Link>
            <Link className="hover:text-stone-950" href="/admin/audience/segments">Audience</Link>
            <Link className="hover:text-stone-950" href="/admin/campaigns">Campaigns</Link>
            <Link className="hover:text-stone-950" href="/admin/outbox">Outbox</Link>
          </nav>

          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-stone-600 sm:inline">{session.email}</span>
            <form action={logoutAdmin}>
              <button
                className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
                type="submit"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
