import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  ADMIN_SESSION_TTL_SECONDS,
  createAdminSessionToken,
  getAdminAuthConfig,
  verifyAdminSessionToken,
  type AdminSession,
} from "@/lib/admin/auth";

const ADMIN_SESSION_COOKIE = "marat_admin_session";

export async function getAdminSession(): Promise<AdminSession | null> {
  const config = getAdminAuthConfig();
  if (!config) {
    return null;
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }

  return verifyAdminSessionToken(token, config);
}

export async function requireAdminSession(): Promise<AdminSession> {
  const session = await getAdminSession();
  if (!session) {
    redirect("/admin/login");
  }

  return session;
}

export async function setAdminSessionCookie(email: string): Promise<void> {
  const config = getAdminAuthConfig();
  if (!config) {
    throw new Error("Admin authentication is not configured.");
  }

  const cookieStore = await cookies();
  cookieStore.set(ADMIN_SESSION_COOKIE, createAdminSessionToken(email, config), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_SESSION_TTL_SECONDS,
  });
}

export async function clearAdminSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
