"use server";

import { redirect } from "next/navigation";

import {
  getAdminAuthConfig,
  validateAdminLoginInput,
  verifyAdminCredentials,
} from "@/lib/admin/auth";
import { setAdminSessionCookie } from "@/lib/admin/session";

export async function loginAdmin(formData: FormData) {
  const validation = validateAdminLoginInput({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!validation.ok) {
    redirect("/admin/login?error=invalid");
  }

  const config = getAdminAuthConfig();
  if (!config) {
    redirect("/admin/login?error=config");
  }

  if (!verifyAdminCredentials(validation.email, validation.password, config)) {
    redirect("/admin/login?error=invalid");
  }

  await setAdminSessionCookie(validation.email);
  redirect("/admin");
}
