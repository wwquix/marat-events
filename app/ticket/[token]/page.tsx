import { notFound } from "next/navigation";
import QRCode from "qrcode";

import { checkInQrValue, normalizeCheckInToken, hashCheckInToken } from "@/lib/checkin/token";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type TicketPageProps = {
  params: Promise<{ token: string }>;
};

type TokenRow = {
  id: string;
  registration_id: string;
  event_id: string;
  status: "active" | "revoked";
  expires_at: string | null;
};

type EventRow = {
  id: string;
  title: string;
  venue: string;
  starts_at: string;
};

type RegistrationRow = {
  id: string;
  event_id: string;
  payment_status: string;
};

type CheckInRow = {
  checked_in_at: string;
};

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

export default async function TicketPage({ params }: TicketPageProps) {
  const token = normalizeCheckInToken((await params).token);
  if (!token) notFound();

  const supabase = createSupabaseServerClient();
  const { data: tokenData, error: tokenError } = await supabase
    .from("registration_check_in_tokens")
    .select("id,registration_id,event_id,status,expires_at")
    .eq("token_hash", hashCheckInToken(token))
    .maybeSingle();

  if (tokenError) throw new Error("Unable to load ticket.");
  if (!tokenData) notFound();
  const ticket = tokenData as TokenRow;

  const [eventResult, registrationResult, checkInResult] = await Promise.all([
    supabase.from("events").select("id,title,venue,starts_at").eq("id", ticket.event_id).maybeSingle(),
    supabase
      .from("registrations")
      .select("id,event_id,payment_status")
      .eq("id", ticket.registration_id)
      .maybeSingle(),
    supabase
      .from("registration_check_ins")
      .select("checked_in_at")
      .eq("registration_id", ticket.registration_id)
      .eq("status", "checked_in")
      .maybeSingle(),
  ]);

  if (eventResult.error || registrationResult.error || checkInResult.error) {
    throw new Error("Unable to load ticket state.");
  }
  if (!eventResult.data || !registrationResult.data) notFound();

  const event = eventResult.data as EventRow;
  const registration = registrationResult.data as RegistrationRow;
  const checkIn = checkInResult.data as CheckInRow | null;
  if (event.id !== registration.event_id || event.id !== ticket.event_id) notFound();

  // This server component must evaluate bearer-token expiry at request time.
  // eslint-disable-next-line react-hooks/purity
  const requestTime = Date.now();
  const expired = Boolean(ticket.expires_at && new Date(ticket.expires_at).getTime() <= requestTime);
  const eligible = ticket.status === "active" && !expired && registration.payment_status === "paid";
  const qrDataUrl = eligible && !checkIn
    ? await QRCode.toDataURL(checkInQrValue(token), {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 320,
      })
    : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-6 py-12">
      <section className="w-full rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-stone-500">Marat Events ticket</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-stone-900">{event.title}</h1>
        <p className="mt-3 text-stone-600">{formatDateTime(event.starts_at)}</p>
        <p className="mt-1 text-sm text-stone-500">{event.venue}</p>

        {checkIn ? (
          <div className="mt-8 rounded-xl bg-emerald-50 px-4 py-5 text-emerald-800">
            <p className="font-semibold">Checked in</p>
            <p className="mt-1 text-sm">{formatDateTime(checkIn.checked_in_at)}</p>
          </div>
        ) : qrDataUrl ? (
          <div className="mt-8">
            {/* The QR contains only an opaque bearer token, never attendee or payment data. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="Opaque event check-in QR code" className="mx-auto h-72 w-72" src={qrDataUrl} />
            <p className="mt-4 text-sm text-stone-600">Present this code to the event operator.</p>
          </div>
        ) : (
          <div className="mt-8 rounded-xl bg-amber-50 px-4 py-5 text-amber-900">
            <p className="font-semibold">Ticket unavailable</p>
            <p className="mt-1 text-sm">The token is revoked, expired, or the registration is not eligible.</p>
          </div>
        )}

        <p className="mt-8 text-xs leading-5 text-stone-500">
          This link is a bearer credential. Do not share it. It contains no email, phone number, payment details, or raw database ID.
        </p>
      </section>
    </main>
  );
}
