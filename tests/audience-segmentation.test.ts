import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  evaluateAudienceSegment,
  loadCompleteAudienceRpcRows,
  validateAudienceSegmentCriteria,
  type AudienceSegmentCandidate,
  type AudienceSegmentCriteria,
} from "../lib/audience/segments";

const EVENT_ID = "00000000-0000-4000-8000-000000000010";
const IMPORT_ID = "00000000-0000-4000-8000-000000000020";

function cappedRpcFetcher<T>(rows: T[], cap: number, requests: Array<[number, number]>) {
  return async (fromInclusive: number, toInclusive: number) => {
    requests.push([fromInclusive, toInclusive]);
    const cappedTo = Math.min(toInclusive, fromInclusive + cap - 1);
    return {
      data: rows.slice(fromInclusive, cappedTo + 1),
      count: rows.length,
      error: null,
    };
  };
}

const EMPTY_CRITERIA: AudienceSegmentCriteria = {
  gender: null,
  city: null,
  source: null,
  importBatchId: null,
  contactChannel: null,
  consentRequirement: "any",
  contactabilityRequirement: "any",
  priorRegistrationEventId: null,
  priorRegistrationPaymentStatus: "any",
};

function candidate(
  personId: string,
  overrides: Partial<AudienceSegmentCandidate> = {},
): AudienceSegmentCandidate {
  return {
    personId,
    fullName: `Person ${personId}`,
    gender: null,
    city: null,
    source: null,
    importBatchId: null,
    suppressionStatus: "active",
    identityStatus: "resolved",
    contacts: [],
    priorRegistrations: [],
    ...overrides,
  };
}

test("criteria validation is explicit and rejects dependent rules without their scope", () => {
  assert.deepEqual(
    validateAudienceSegmentCriteria({ contactChannel: null, consentRequirement: "opted_in" }),
    { ok: false, issues: ["contact_channel_required"] },
  );
  assert.deepEqual(
    validateAudienceSegmentCriteria({ priorRegistrationEventId: null, priorRegistrationPaymentStatus: "paid" }),
    { ok: false, issues: ["prior_registration_event_required"] },
  );

  const valid = validateAudienceSegmentCriteria({
    gender: "female",
    city: " New   York ",
    source: "August import",
    importBatchId: IMPORT_ID,
    contactChannel: "email",
    consentRequirement: "opted_in",
    contactabilityRequirement: "reachable",
    priorRegistrationEventId: EVENT_ID,
    priorRegistrationPaymentStatus: "paid",
  });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.value.city, "New York");
});

test("typed criteria evaluate current audience data with stable reason codes", () => {
  const criteria: AudienceSegmentCriteria = {
    gender: "female",
    city: "New York",
    source: "invite-list",
    importBatchId: IMPORT_ID,
    contactChannel: "email",
    consentRequirement: "opted_in",
    contactabilityRequirement: "reachable",
    priorRegistrationEventId: EVENT_ID,
    priorRegistrationPaymentStatus: "paid",
  };
  const matching = candidate("a", {
    gender: "female",
    city: " new york ",
    source: "INVITE-LIST",
    importBatchId: IMPORT_ID,
    contacts: [{ channel: "email", consentStatus: "opted_in", contactabilityStatus: "reachable" }],
    priorRegistrations: [{ eventId: EVENT_ID, paymentStatus: "paid" }],
  });
  const excluded = candidate("b", {
    gender: "male",
    city: "Boston",
    source: "other",
    importBatchId: null,
    contacts: [{ channel: "email", consentStatus: "unknown", contactabilityStatus: "unknown" }],
    priorRegistrations: [{ eventId: EVENT_ID, paymentStatus: "pending" }],
  });
  const result = evaluateAudienceSegment({ candidates: [matching, excluded], criteria });

  assert.deepEqual(result[0].reasonCodes, ["included_criteria_match"]);
  assert.deepEqual(result[1].reasonCodes, [
    "excluded_gender",
    "excluded_city",
    "excluded_source",
    "excluded_import_batch",
    "excluded_consent",
    "excluded_contactability",
    "excluded_prior_registration",
  ]);
});

test("manual exclude wins and manual include overrides criteria only", () => {
  const candidates = [
    candidate("manual-exclude", { suppressionStatus: "suppressed" }),
    candidate("manual-include", { city: "Boston" }),
  ];
  const result = evaluateAudienceSegment({
    candidates,
    criteria: { ...EMPTY_CRITERIA, city: "New York" },
    overrides: [
      { personId: "manual-exclude", decision: "exclude" },
      { personId: "manual-include", decision: "include" },
    ],
  });

  assert.deepEqual(result.find((row) => row.personId === "manual-exclude")?.reasonCodes, ["excluded_manual"]);
  assert.deepEqual(result.find((row) => row.personId === "manual-include"), {
    personId: "manual-include",
    fullName: "Person manual-include",
    included: true,
    reasonCodes: ["included_manual_override"],
    overrideDecision: "include",
  });
});

test("one contact must satisfy consent and contactability together", () => {
  const splitSignals = candidate("split", {
    contacts: [
      { channel: "email", consentStatus: "opted_in", contactabilityStatus: "unknown" },
      { channel: "email", consentStatus: "unknown", contactabilityStatus: "reachable" },
    ],
  });
  const result = evaluateAudienceSegment({
    candidates: [splitSignals],
    criteria: {
      ...EMPTY_CRITERIA,
      contactChannel: "email",
      consentRequirement: "opted_in",
      contactabilityRequirement: "reachable",
    },
  });
  assert.equal(result[0].included, false);
  assert.deepEqual(result[0].reasonCodes, ["excluded_contact_policy_combination"]);

  const optedOutReachable = candidate("opted-out-reachable", {
    contacts: [
      { channel: "email", consentStatus: "opted_out", contactabilityStatus: "reachable" },
      { channel: "email", consentStatus: "unknown", contactabilityStatus: "unknown" },
    ],
  });
  const safeResult = evaluateAudienceSegment({
    candidates: [optedOutReachable],
    criteria: {
      ...EMPTY_CRITERIA,
      contactChannel: "email",
      contactabilityRequirement: "reachable",
    },
  });
  assert.equal(safeResult[0].included, false);
  assert.deepEqual(safeResult[0].reasonCodes, ["excluded_contactability"]);
});

test("manual include never overrides live suppression, ambiguous identity or required-channel safety", () => {
  const candidates = [
    candidate("suppressed", { suppressionStatus: "suppressed" }),
    candidate("ambiguous", { identityStatus: "review_required" }),
    candidate("missing"),
    candidate("opted-out", {
      contacts: [{ channel: "email", consentStatus: "opted_out", contactabilityStatus: "reachable" }],
    }),
    candidate("unknown-consent", {
      contacts: [{ channel: "email", consentStatus: "unknown", contactabilityStatus: "reachable" }],
    }),
    candidate("unreachable", {
      contacts: [{ channel: "email", consentStatus: "opted_in", contactabilityStatus: "unreachable" }],
    }),
  ];
  const overrides = candidates.map((row) => ({ personId: row.personId, decision: "include" as const }));
  const result = evaluateAudienceSegment({
    candidates,
    criteria: EMPTY_CRITERIA,
    overrides,
    requiredChannel: "email",
  });

  assert.deepEqual(result.map((row) => [row.personId, row.included, row.reasonCodes[0]]), [
    ["ambiguous", false, "excluded_identity_review_required"],
    ["missing", false, "excluded_required_channel_missing"],
    ["opted-out", false, "excluded_required_channel_opted_out"],
    ["suppressed", false, "excluded_suppressed"],
    ["unknown-consent", false, "excluded_required_channel_consent_unknown"],
    ["unreachable", false, "excluded_required_channel_unreachable"],
  ]);
});

test("unknown consent remains visible in discovery and fails closed for a required channel", () => {
  const unknown = candidate("unknown", {
    contacts: [{ channel: "email", consentStatus: "unknown", contactabilityStatus: "unknown" }],
  });
  const criteria = { ...EMPTY_CRITERIA, contactChannel: "email" as const };

  const discovery = evaluateAudienceSegment({ candidates: [unknown], criteria });
  assert.equal(discovery[0].included, true);
  assert.deepEqual(discovery[0].reasonCodes, ["included_consent_unknown", "included_contactability_unknown"]);

  const delivery = evaluateAudienceSegment({ candidates: [unknown], criteria, requiredChannel: "email" });
  assert.equal(delivery[0].included, false);
  assert.deepEqual(delivery[0].reasonCodes, ["excluded_required_channel_consent_unknown"]);
});

test("evaluation ordering is stable by normalized name then person id", () => {
  const results = evaluateAudienceSegment({
    candidates: [
      candidate("2", { fullName: " zoe " }),
      candidate("3", { fullName: "Amy" }),
      candidate("1", { fullName: "amy" }),
    ],
    criteria: EMPTY_CRITERIA,
  });
  assert.deepEqual(results.map((row) => row.personId), ["1", "3", "2"]);
});

test("segmentation RPC paging survives the hosted 1,000-row cap", async () => {
  const cases = [
    {
      total: 1_550,
      expectedRanges: [
        [0, 999],
        [1_000, 1_549],
      ],
    },
    {
      total: 5_000,
      expectedRanges: [
        [0, 999],
        [1_000, 1_999],
        [2_000, 2_999],
        [3_000, 3_999],
        [4_000, 4_999],
      ],
    },
  ];

  for (const testCase of cases) {
    const source = Array.from({ length: testCase.total }, (_, index) => `person-${index + 1}`);
    const requests: Array<[number, number]> = [];
    const loaded = await loadCompleteAudienceRpcRows(cappedRpcFetcher(source, 1_000, requests));

    assert.deepEqual(loaded, source);
    assert.deepEqual(requests, testCase.expectedRanges);
  }
});

test("segmentation RPC paging rejects a result above 5,000", async () => {
  const source = Array.from({ length: 5_001 }, (_, index) => index + 1);
  const requests: Array<[number, number]> = [];
  await assert.rejects(
    loadCompleteAudienceRpcRows(cappedRpcFetcher(source, 1_000, requests)),
    /invalid exact count/,
  );
  assert.deepEqual(requests, [[0, 999]]);
});

test("segmentation RPC paging fails closed on count drift and premature empty pages", async () => {
  let driftCall = 0;
  await assert.rejects(
    loadCompleteAudienceRpcRows(async (fromInclusive, toInclusive) => {
      driftCall += 1;
      return {
        data: Array.from(
          { length: toInclusive - fromInclusive + 1 },
          (_, index) => fromInclusive + index,
        ),
        count: driftCall === 1 ? 1_550 : 1_549,
        error: null,
      };
    }),
    /exact count changed/,
  );

  let emptyCall = 0;
  await assert.rejects(
    loadCompleteAudienceRpcRows(async (fromInclusive, toInclusive) => {
      emptyCall += 1;
      return {
        data:
          emptyCall === 1
            ? Array.from(
                { length: toInclusive - fromInclusive + 1 },
                (_, index) => fromInclusive + index,
              )
            : [],
        count: 1_550,
        error: null,
      };
    }),
    /empty page before exact total/,
  );
});

test("both segmentation server loaders use exact-count deterministic RPC ranges", () => {
  const source = readFileSync(
    path.join(process.cwd(), "lib", "audience", "segments", "server.ts"),
    "utf8",
  );
  assert.match(source, /\.rpc\(functionName, args, \{ count: "exact" \}\)/);
  assert.match(source, /\.order\("person_id", \{ ascending: true \}\)/);
  assert.match(source, /\.range\(fromInclusive, toInclusive\)/);
  assert.match(source, /loadSegmentRpcRows\("get_audience_segment_candidates"/);
  assert.match(source, /loadSegmentRpcRows\("preview_event_audience_selection"/);
  assert.doesNotMatch(source, /createSupabaseServerClient\(\)\.rpc/);
});

test("segmentation schema is private, typed and exposes one service-role-only selection evaluator", () => {
  const sql = readFileSync(
    path.join(process.cwd(), "supabase", "migrations", "20260818195406_phase_2_segmentation.sql"),
    "utf8",
  );

  for (const table of [
    "audience_segments",
    "event_audience_selections",
    "event_audience_selection_overrides",
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"));
    assert.match(sql, new RegExp(`grant select, insert, update, delete on table public\\.${table} to service_role`, "i"));
  }
  assert.doesNotMatch(sql, /create\s+policy/i);
  assert.match(sql, /status in \('draft', 'archived'\)/i);
  assert.match(sql, /decision in \('include', 'exclude'\)/i);
  assert.match(sql, /contact_channel in \('email', 'phone', 'sms', 'instagram', 'linkedin', 'whatsapp', 'telegram'\)/i);
  assert.match(sql, /create or replace function public\.preview_event_audience_selection\([\s\S]*p_selection_id uuid[\s\S]*p_limit integer default 5001/i);
  assert.match(sql, /revoke execute on function public\.get_audience_segment_candidates\(integer, uuid\)[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.get_audience_segment_candidates\(integer, uuid\)[\s\S]*to service_role/i);
  assert.match(sql, /select distinct[\s\S]*existing_contact\.channel[\s\S]*existing_contact\.consent_status[\s\S]*existing_contact\.contactability_status/i);
  assert.match(sql, /existing_registration\.event_id = p_prior_registration_event_id/i);
  assert.match(sql, /security invoker[\s\S]*set search_path = ''/i);
  assert.match(sql, /usable_contact_consent_status[\s\S]*usable_contact_contactability_status/i);
  assert.match(sql, /manual_decision = 'exclude'[\s\S]*selection_status = 'archived'[\s\S]*candidate_suppression_status = 'suppressed'/i);
  assert.match(sql, /consent_status = 'opted_in'[\s\S]*contactability_status = 'reachable'/i);
  assert.match(sql, /order by lower\(classified\.candidate_full_name\), classified\.candidate_person_id/i);
  assert.match(sql, /limit least\(greatest\(coalesce\(p_limit, 5001\), 1\), 5001\)/i);
  assert.match(sql, /revoke execute on function public\.preview_event_audience_selection\(uuid, integer\)[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.preview_event_audience_selection\(uuid, integer\)[\s\S]*to service_role/i);
});

test("every segmentation mutation rechecks the admin session", () => {
  const source = readFileSync(
    path.join(process.cwd(), "app", "admin", "(protected)", "audience", "segments", "actions.ts"),
    "utf8",
  );
  for (const actionName of [
    "createAudienceSegmentAction",
    "updateAudienceSegmentAction",
    "createEventAudienceSelectionAction",
    "updateEventAudienceSelectionAction",
    "setEventAudienceSelectionOverrideAction",
  ]) {
    const start = source.indexOf(`export async function ${actionName}`);
    assert.notEqual(start, -1);
    const next = source.indexOf("export async function", start + 1);
    const actionBody = source.slice(start, next === -1 ? undefined : next);
    assert.match(actionBody, /await requireAdminSession\(\)/);
  }
});
