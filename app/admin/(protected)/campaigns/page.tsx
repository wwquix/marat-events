import { randomUUID } from "node:crypto";

import Link from "next/link";

import {
  createCampaignPreviewAction,
  createMessageTemplateVersionAction,
} from "@/app/admin/(protected)/campaigns/actions";
import { loadCompleteRange } from "@/lib/audience/load";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  delivery_mode: string;
  recipient_count: number;
  channel: string;
  created_at: string;
};

type SelectionRow = {
  id: string;
  name: string;
  required_channel: string;
  event_id: string;
};

type TemplateVersionRow = {
  id: string;
  version: number;
  channel: string;
  template_id: string;
};

const MAX_CAMPAIGN_INPUTS = 5_000;
const CAMPAIGN_PAGE_SIZE = 50;

const ERROR_MESSAGES: Record<string, string> = {
  invalid_template: "Check the template fields, channel, variables, and placeholders.",
  template_blocked: "The template version was not created. No campaign data changed.",
  invalid_campaign: "Check the campaign, selection, template, and sending-window fields.",
  campaign_blocked: "The campaign preview was blocked by an audience, policy, or database invariant.",
};

const SAVED_MESSAGES: Record<string, string> = {
  template_created: "Template version created. Existing versions remain immutable.",
};

function firstParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function readPage(value: string | null): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown date"
    : new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export default async function CampaignsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const errorCode = firstParam(params.error);
  const savedCode = firstParam(params.saved);
  const requestedPage = readPage(firstParam(params.page));
  const supabase = createSupabaseServerClient();
  const campaignCountResult = await supabase
    .from("campaigns")
    .select("id", { count: "exact", head: true });
  if (campaignCountResult.error || campaignCountResult.count === null) {
    throw new Error("Unable to load campaign operations.");
  }

  const totalPages = Math.max(1, Math.ceil(campaignCountResult.count / CAMPAIGN_PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);
  const from = (currentPage - 1) * CAMPAIGN_PAGE_SIZE;
  const to = from + CAMPAIGN_PAGE_SIZE - 1;

  const [campaignResult, selections, versions] = await Promise.all([
    supabase
      .from("campaigns")
      .select("id,name,status,delivery_mode,recipient_count,channel,created_at")
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
    loadCompleteRange<SelectionRow>({
      maxTotal: MAX_CAMPAIGN_INPUTS,
      fetchRange: async (rangeFrom, rangeTo) => {
        const response = await supabase
          .from("event_audience_selections")
          .select("id,name,required_channel,event_id", { count: "exact" })
          .eq("status", "draft")
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(rangeFrom, rangeTo);
        return { data: response.data as SelectionRow[] | null, count: response.count, error: response.error };
      },
    }),
    loadCompleteRange<TemplateVersionRow>({
      maxTotal: MAX_CAMPAIGN_INPUTS,
      fetchRange: async (rangeFrom, rangeTo) => {
        const response = await supabase
          .from("message_template_versions")
          .select("id,version,channel,template_id", { count: "exact" })
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(rangeFrom, rangeTo);
        return { data: response.data as TemplateVersionRow[] | null, count: response.count, error: response.error };
      },
    }),
  ]);

  if (campaignResult.error) throw new Error("Unable to load campaign operations.");

  const campaigns = (campaignResult.data ?? []) as CampaignRow[];
  const errorMessage = errorCode ? ERROR_MESSAGES[errorCode] : null;
  const savedMessage = savedCode ? SAVED_MESSAGES[savedCode] : null;

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-stone-500">Phase 2.4 · Provider-independent foundation</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">Campaigns and outbox</h1>
          <p className="mt-2 max-w-3xl text-stone-600">
            Create immutable previews, then evaluate policy through a durable outbox. Only disabled and dry-run modes
            exist; neither mode contacts a provider.
          </p>
        </div>
        <div className="flex gap-2">
          <Link className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium" href="/admin">
            Admin
          </Link>
          <Link className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium" href="/admin/outbox">
            View outbox
          </Link>
        </div>
      </div>

      {errorMessage ? (
        <p className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{errorMessage}</p>
      ) : null}
      {savedMessage ? (
        <p className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {savedMessage}
        </p>
      ) : null}

      <div className="mt-7 grid gap-6 xl:grid-cols-2">
        <form action={createMessageTemplateVersionAction} className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <input name="request_id" type="hidden" value={randomUUID()} />
          <h2 className="text-lg font-semibold text-stone-900">Create template version</h2>
          <p className="mt-1 text-sm text-stone-600">Versions are immutable and contain plain placeholder text only.</p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-stone-700">
              Template key
              <input className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" name="template_key" placeholder="event-invitation" required />
            </label>
            <label className="text-sm font-medium text-stone-700">
              Display name
              <input className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" name="name" placeholder="Event invitation" required />
            </label>
            <label className="text-sm font-medium text-stone-700">
              Channel
              <select className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" name="channel" defaultValue="email">
                <option value="email">email</option>
                <option value="sms">sms</option>
                <option value="whatsapp">whatsapp</option>
                <option value="telegram">telegram</option>
                <option value="instagram">instagram</option>
              </select>
            </label>
            <label className="text-sm font-medium text-stone-700">
              Variables (comma separated)
              <input className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" name="variables" defaultValue="full_name,event_title,event_date,event_time,venue" />
            </label>
          </div>

          <label className="mt-4 block text-sm font-medium text-stone-700">
            Email subject (leave blank for non-email channels)
            <input className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" name="subject_template" placeholder="Invitation: {{event_title}}" />
          </label>
          <label className="mt-4 block text-sm font-medium text-stone-700">
            Body
            <textarea className="mt-1.5 min-h-36 w-full rounded-lg border border-stone-300 px-3 py-2" name="body_template" defaultValue={"Hi {{full_name}},\n\nJoin {{event_title}} at {{venue}} on {{event_date}} at {{event_time}}."} required />
          </label>
          <button className="mt-4 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white" type="submit">
            Create immutable version
          </button>
        </form>

        <form action={createCampaignPreviewAction} className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <input name="request_id" type="hidden" value={randomUUID()} />
          <h2 className="text-lg font-semibold text-stone-900">Create campaign preview</h2>
          <p className="mt-1 text-sm text-stone-600">
            Materialization calls the authoritative audience evaluator and rechecks current consent, suppression,
            identity, destination, and contactability under one database transaction.
          </p>

          <label className="mt-4 block text-sm font-medium text-stone-700">
            Campaign name
            <input className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" name="name" required />
          </label>
          <label className="mt-4 block text-sm font-medium text-stone-700">
            Event audience selection
            <select className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" name="selection_id" required defaultValue="">
              <option disabled value="">Select a frozen audience selection</option>
              {selections.map((selection) => (
                <option key={selection.id} value={selection.id}>
                  {selection.name} · {selection.required_channel}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-4 block text-sm font-medium text-stone-700">
            Template version
            <select className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" name="template_version_id" required defaultValue="">
              <option disabled value="">Select an immutable template version</option>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.channel} · version {version.version} · {version.template_id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-stone-700">
              Delivery mode
              <select className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" name="delivery_mode" defaultValue="dry_run">
                <option value="dry_run">dry_run</option>
                <option value="disabled">disabled</option>
              </select>
            </label>
            <label className="text-sm font-medium text-stone-700">
              Allowed weekdays (Sun=0)
              <input className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" name="allowed_weekdays" defaultValue="1,2,3,4,5" required />
            </label>
            <label className="text-sm font-medium text-stone-700">
              Window start · New York
              <input className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" name="sending_window_start" type="time" defaultValue="09:00" required />
            </label>
            <label className="text-sm font-medium text-stone-700">
              Window end · New York
              <input className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" name="sending_window_end" type="time" defaultValue="17:00" required />
            </label>
          </div>

          <button className="mt-4 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white disabled:bg-stone-400" type="submit" disabled={selections.length === 0 || versions.length === 0}>
            Create policy preview
          </button>
          {selections.length === 0 || versions.length === 0 ? (
            <p className="mt-2 text-xs text-amber-700">Create a draft audience selection and a matching template channel first.</p>
          ) : null}
        </form>
      </div>

      <div className="mt-9">
        <h2 className="text-lg font-semibold text-stone-900">Recent campaigns</h2>
        <div className="mt-3 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
          {campaigns.length === 0 ? (
            <p className="p-6 text-sm text-stone-500">No campaign previews yet.</p>
          ) : (
            <div className="divide-y divide-stone-100">
              {campaigns.map((campaign) => (
                <Link className="grid gap-2 px-4 py-3 hover:bg-stone-50 sm:grid-cols-[1fr_auto] sm:items-center" href={`/admin/campaigns/${campaign.id}`} key={campaign.id}>
                  <div>
                    <p className="font-medium text-stone-900">{campaign.name}</p>
                    <p className="mt-0.5 text-xs text-stone-500">
                      {formatDate(campaign.created_at)} · {campaign.channel} · {campaign.delivery_mode} · {campaign.recipient_count} recipients
                    </p>
                  </div>
                  <span className="text-sm font-medium text-stone-600">{campaign.status} →</span>
                </Link>
              ))}
            </div>
          )}
        </div>
        {totalPages > 1 ? (
          <nav aria-label="Campaign pages" className="mt-5 flex items-center justify-between text-sm">
            {currentPage > 1 ? (
              <Link className="rounded-lg border border-stone-300 bg-white px-3 py-2" href={`/admin/campaigns?page=${currentPage - 1}`}>
                Previous
              </Link>
            ) : <span />}
            <span className="text-stone-600">Page {currentPage} of {totalPages}</span>
            {currentPage < totalPages ? (
              <Link className="rounded-lg border border-stone-300 bg-white px-3 py-2" href={`/admin/campaigns?page=${currentPage + 1}`}>
                Next
              </Link>
            ) : <span />}
          </nav>
        ) : null}
      </div>
    </section>
  );
}
