import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const personPage = readFileSync(
  path.join(process.cwd(), "app", "admin", "(protected)", "people", "[id]", "page.tsx"),
  "utf8",
);

test("CRM campaign history is bounded, deterministic, and avoids repeated message PII", () => {
  assert.match(personPage, /const HISTORY_LIMIT = 200/);
  for (const table of ["campaign_recipients", "campaigns", "outbox_messages", "campaign_invitation_tokens"]) {
    assert.match(personPage, new RegExp(`\\.from\\("${table}"\\)`));
  }

  assert.match(
    personPage,
    /from\("campaign_recipients"\)[\s\S]*?order\("created_at", \{ ascending: false \}\)[\s\S]*?order\("id", \{ ascending: false \}\)[\s\S]*?limit\(HISTORY_LIMIT\)/,
  );
  assert.match(
    personPage,
    /from\("campaign_invitation_tokens"\)[\s\S]*?\{ count: "exact" \}[\s\S]*?order\("created_at", \{ ascending: false \}\)[\s\S]*?order\("id", \{ ascending: false \}\)[\s\S]*?limit\(HISTORY_LIMIT\)/,
  );
  assert.match(personPage, /Outbox \{outbox\?\.status \?\? "not queued"\}/);
  assert.match(personPage, /Campaign scope is truncated/);
  assert.doesNotMatch(personPage, /token_hash/);
  assert.doesNotMatch(personPage, /destination_snapshot/);
  assert.doesNotMatch(personPage, /rendered_(?:subject|body)/);
});

test("CRM match history reads mutual matches only and never queries one-sided likes", () => {
  assert.match(
    personPage,
    /from\("matching_matches"\)[\s\S]*?\{ count: "exact" \}[\s\S]*?order\("created_at", \{ ascending: false \}\)[\s\S]*?order\("id", \{ ascending: false \}\)[\s\S]*?limit\(HISTORY_LIMIT\)/,
  );
  assert.match(personPage, /profile_one_id/);
  assert.match(personPage, /profile_two_id/);
  assert.match(personPage, /Matched with \{counterpart\.display_name\}/);
  assert.match(personPage, /Only confirmed mutual matches are shown/);
  assert.match(personPage, /Match scope is truncated/);
  assert.doesNotMatch(personPage, /matching_likes/);
  assert.doesNotMatch(personPage, /like(?:r|d)_profile_id/);
});
