import assert from "node:assert/strict";
import test from "node:test";

import { buildCsv, csvCell, csvDownloadFilename } from "../lib/admin/csv";

test("CSV cells quote delimiters and embedded quotes", () => {
  assert.equal(csvCell('Jane, "JJ"'), '"Jane, ""JJ"""');
});

test("CSV cells neutralize spreadsheet formulas including leading whitespace", () => {
  assert.equal(csvCell("=2+2"), '"\'=2+2"');
  assert.equal(csvCell("  @SUM(A1:A2)"), '"\'  @SUM(A1:A2)"');
  assert.equal(csvCell("+123"), '"\'+123"');
  assert.equal(csvCell("-10"), '"\'-10"');
});

test("CSV output uses UTF-8 BOM, CRLF and deterministic columns", () => {
  const csv = buildCsv(
    ["name", "email"],
    [
      ["Юрий", "vigiyiri@gmail.com"],
      ["Jane", "jane@example.com"],
    ],
  );

  assert.equal(
    csv,
    '\uFEFF"name","email"\r\n"Юрий","vigiyiri@gmail.com"\r\n"Jane","jane@example.com"\r\n',
  );
});

test("CSV download filename is safe and deterministic", () => {
  assert.equal(csvDownloadFilename("demo-marats-future-event"), "demo-marats-future-event-attendees.csv");
  assert.equal(csvDownloadFilename("../Unsafe Event"), "Unsafe-Event-attendees.csv");
});
