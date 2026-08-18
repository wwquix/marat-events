import Link from "next/link";

import { loadCompleteRange } from "@/lib/audience/load";
import { normalizePeopleSearch } from "@/lib/crm/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const MAX_PEOPLE = 5_000;
const PAGE_SIZE = 100;

type PeoplePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type PersonRow = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  gender: string | null;
  city: string | null;
  source: string | null;
  suppression_status: "active" | "suppressed";
  identity_status: "resolved" | "review_required";
  created_at: string;
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function readPage(value: string): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function listPath(query: string, suppression: string, identity: string, page: number): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (suppression !== "all") params.set("suppression", suppression);
  if (identity !== "all") params.set("identity", identity);
  if (page > 1) params.set("page", String(page));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return `/admin/people${suffix}`;
}

export default async function PeoplePage({ searchParams }: PeoplePageProps) {
  const resolved = await searchParams;
  const query = normalizePeopleSearch(firstParam(resolved.q));
  const suppression = ["active", "suppressed"].includes(firstParam(resolved.suppression))
    ? firstParam(resolved.suppression)
    : "all";
  const identity = ["resolved", "review_required"].includes(firstParam(resolved.identity))
    ? firstParam(resolved.identity)
    : "all";
  const requestedPage = readPage(firstParam(resolved.page));
  const supabase = createSupabaseServerClient();

  let people: PersonRow[];
  try {
    people = await loadCompleteRange<PersonRow>({
      maxTotal: MAX_PEOPLE,
      fetchRange: async (from, to) => {
        const response = await supabase
          .from("people")
          .select(
            "id,full_name,email,phone,gender,city,source,suppression_status,identity_status,created_at",
            { count: "exact" },
          )
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to);
        return { data: response.data as PersonRow[] | null, count: response.count, error: response.error };
      },
    });
  } catch {
    throw new Error("Unable to load complete people index.");
  }

  const filtered = people.filter((person) => {
    if (suppression !== "all" && person.suppression_status !== suppression) return false;
    if (identity !== "all" && person.identity_status !== identity) return false;
    if (!query) return true;
    return [person.full_name, person.email, person.phone, person.city]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase("en-US").includes(query));
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-stone-500">Central audience</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">People</h1>
          <p className="mt-2 text-sm text-stone-600">{filtered.length} of {people.length} people match</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700" href="/admin/audience/import">
            Imports
          </Link>
          <Link className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700" href="/admin/audience/segments">
            Segments
          </Link>
        </div>
      </div>

      <form className="mt-6 grid gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm md:grid-cols-4" method="get">
        <label className="text-sm font-medium text-stone-700 md:col-span-2">
          Search
          <input className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" defaultValue={query} maxLength={100} name="q" placeholder="Name, email, phone, or city" />
        </label>
        <label className="text-sm font-medium text-stone-700">
          Suppression
          <select className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" defaultValue={suppression} name="suppression">
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="suppressed">Suppressed</option>
          </select>
        </label>
        <label className="text-sm font-medium text-stone-700">
          Identity
          <select className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2" defaultValue={identity} name="identity">
            <option value="all">All</option>
            <option value="resolved">Resolved</option>
            <option value="review_required">Review required</option>
          </select>
        </label>
        <div className="flex gap-2 md:col-span-4">
          <button className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white" type="submit">Apply</button>
          <Link className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700" href="/admin/people">Reset</Link>
        </div>
      </form>

      <div className="mt-6 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
        {visible.length === 0 ? (
          <p className="p-8 text-center text-sm text-stone-500">No people match these filters.</p>
        ) : (
          <div className="divide-y divide-stone-100">
            {visible.map((person) => (
              <Link className="flex flex-wrap items-center justify-between gap-3 p-4 hover:bg-stone-50" href={`/admin/people/${person.id}`} key={person.id}>
                <div>
                  <p className="font-semibold text-stone-900">{person.full_name}</p>
                  <p className="mt-1 text-xs text-stone-500">
                    {[person.gender, person.city, person.source].filter(Boolean).join(" · ") || "No public profile metadata"}
                  </p>
                </div>
                <div className="flex gap-2 text-xs font-medium">
                  <span className={`rounded-full px-2 py-1 ${person.suppression_status === "suppressed" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
                    {person.suppression_status}
                  </span>
                  <span className={`rounded-full px-2 py-1 ${person.identity_status === "review_required" ? "bg-amber-50 text-amber-700" : "bg-stone-100 text-stone-700"}`}>
                    {person.identity_status}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {totalPages > 1 ? (
        <nav aria-label="People pages" className="mt-6 flex items-center justify-between text-sm">
          {page > 1 ? <Link className="rounded-lg border border-stone-300 bg-white px-3 py-2" href={listPath(query, suppression, identity, page - 1)}>Previous</Link> : <span />}
          <span className="text-stone-600">Page {page} of {totalPages}</span>
          {page < totalPages ? <Link className="rounded-lg border border-stone-300 bg-white px-3 py-2" href={listPath(query, suppression, identity, page + 1)}>Next</Link> : <span />}
        </nav>
      ) : null}
    </section>
  );
}
