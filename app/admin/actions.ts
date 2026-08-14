"use server";

import { redirect } from "next/navigation";

import { clearAdminSessionCookie, requireAdminSession } from "@/lib/admin/session";

export async function logoutAdmin() {
  await requireAdminSession();
  await clearAdminSessionCookie();
  redirect("/admin/login");
}
