import { expect, setDefaultTimeout, test } from "bun:test";
import { parseBotMessage } from "../../../tools/ci/review-gate-reader/codex-messages.ts";
import { fail, ok } from "../../../tools/ci/review-gate-reader/result.ts";
import { codeRabbitRecord, endpoints } from "./bot-fixtures.ts";
import {
  cleanReceipt,
  codexRecord,
  displayAt,
  inlineFinding,
  suggestionsReceipt,
  suggestionsSha,
  summary,
  summarySha,
} from "./codex-fixtures.ts";

setDefaultTimeout(1000);

const comment = "issue_comments";
const expectedSummary = {
  kind: "summary",
  commitSha: summarySha,
  any: false,
  unresolved: false,
  status: "completed",
  displayAt,
  trigger: "New commits",
} as const;
const anyFlag = '"has_any_findings":false';
const unresolvedFlag = '"has_unresolved_findings":false';
const withFlags = (any: boolean, unresolved: boolean) =>
  summary
    .replace(anyFlag, `"has_any_findings":${any}`)
    .replace(unresolvedFlag, `"has_unresolved_findings":${unresolved}`);

test("C1 parses the exact completed summary", () => {
  expect<unknown>(parseBotMessage(codexRecord(), comment)).toEqual(
    ok(expectedSummary),
  );
});

test.each([
  [true, "PR opened"],
  [false, "Manual request"],
] as const)("C2 preserves flags and trigger %s %s", (unresolved, trigger) => {
  const body = withFlags(true, unresolved).replace("New commits", trigger);
  expect<unknown>(parseBotMessage(codexRecord({ body }), comment)).toEqual(
    ok({ ...expectedSummary, any: true, unresolved, trigger }),
  );
});

const sha7 = summarySha.slice(0, 7);
const codeKey = '{"code_review":{';
const footerText = "Codex reacts with";
const stateVersion = "codex-review-state:v1";

test.each([
  ["C3 contradictory flags", withFlags(false, true), "bot_state_conflict"],
  [
    "C4 reordered keys",
    summary.replace(
      `${anyFlag},${unresolvedFlag}`,
      `${unresolvedFlag},${anyFlag}`,
    ),
    "bot_state_invalid",
  ],
  [
    "C4 duplicate key",
    summary.replace(anyFlag, `${anyFlag},${anyFlag}`),
    "bot_state_invalid",
  ],
  [
    "C4 extra key",
    summary.replace(codeKey, `${codeKey}"extra":0,`),
    "bot_state_invalid",
  ],
  [
    "C4 string flag",
    summary.replace(anyFlag, '"has_any_findings":"true"'),
    "bot_state_invalid",
  ],
  [
    "C4 prototype key",
    summary.replace(codeKey, `${codeKey}"__proto__":null,`),
    "bot_state_invalid",
  ],
  ["C4 missing key", summary.replace(`${anyFlag},`, ""), "bot_state_invalid"],
  [
    "C4 state whitespace",
    summary.replace(codeKey, `${codeKey} `),
    "bot_state_invalid",
  ],
  [
    "C5 unknown version",
    summary.replace(stateVersion, "codex-review-state:v2"),
    "bot_version_unsupported",
  ],
  [
    "C5 version suffix",
    summary.replace(stateVersion, "codex-review-state:v1x"),
    "bot_format_malformed",
  ],
  [
    "C5 version case",
    summary.replace(stateVersion, "codex-review-state:V1"),
    "bot_format_malformed",
  ],
  [
    "C5 missing version digits",
    summary.replace(stateVersion, "codex-review-state:v"),
    "bot_format_malformed",
  ],
  [
    "C6 other displayed SHA7",
    summary.replace("`" + sha7 + "`", "`b2152fb`"),
    "bot_state_conflict",
  ],
  [
    "C6 distinct dates",
    summary.replace(`>${displayAt}</`, ">2026-11-22T05:35:25.653187Z</"),
    "bot_state_conflict",
  ],
  [
    "C7 uppercase SHA40",
    summary.replace(summarySha, summarySha.toUpperCase()),
    "bot_head_invalid",
  ],
  [
    "C7 short SHA40",
    summary.replace(summarySha, summarySha.slice(1)),
    "bot_head_invalid",
  ],
  [
    "C7 five fractional digits",
    summary.replaceAll(".653186Z", ".65318Z"),
    "bot_state_invalid",
  ],
  [
    "C7 impossible calendar date",
    summary.replaceAll("2026-11-22", "2026-02-30"),
    "bot_state_invalid",
  ],
  [
    "C7 unknown trigger",
    summary.replace("New commits", "Whatever"),
    "bot_format_malformed",
  ],
  [
    "C8 summary marker case",
    summary.replace(
      "codex-pull-request-review-summary",
      "Codex-pull-request-review-summary",
    ),
    "bot_format_malformed",
  ],
  [
    "C8 summary marker spacing",
    summary.replace(
      "<!-- codex-pull-request-review-summary",
      "<!--  codex-pull-request-review-summary",
    ),
    "bot_format_malformed",
  ],
  ["C8 trailing LF", summary + "\n", "bot_format_malformed"],
  ["C8 CRLF", summary.replaceAll("\n", "\r\n"), "bot_format_malformed"],
  ["C8 leading space", " " + summary, "bot_format_malformed"],
  [
    "C8 changed footer",
    summary.replace(footerText, "Codex reacted with"),
    "bot_format_malformed",
  ],
  [
    "C9 in-progress state",
    summary.replace('"completed"', '"in_progress"'),
    "bot_format_unsupported",
  ],
  [
    "C9 non-null security state",
    summary.replace('"commit_sha":null', `"commit_sha":"${summarySha}"`),
    "bot_format_unsupported",
  ],
  [
    "C13 uppercase SHA10",
    cleanReceipt.replace("54bd87f443", "54BD87F443"),
    "bot_head_invalid",
  ],
  [
    "C13 short SHA10",
    cleanReceipt.replace("54bd87f443", "54bd87f44"),
    "bot_head_invalid",
  ],
  [
    "C13 changed receipt footer",
    cleanReceipt.replace("</details>", "</DETAILS>"),
    "bot_format_malformed",
  ],
  ["C13 trailing LF", cleanReceipt + "\n", "bot_format_malformed"],
  ["C15 empty body", "", "bot_format_unsupported"],
  ["C15 unknown old notice", "Codex is reviewing", "bot_format_unsupported"],
] as const)("%s", (_name, body, reason) => {
  expect<unknown>(parseBotMessage(codexRecord({ body }), comment)).toEqual({
    ok: false,
    reason,
    where: `${comment}/42`,
  });
});

test("C6 rejects a display date one microsecond after updated_at", () => {
  const record = codexRecord({ updated_at: "2026-11-22T05:35:25.653185Z" });
  expect<unknown>(parseBotMessage(record, comment)).toEqual({
    ok: false,
    reason: "bot_state_conflict",
    where: "issue_comments/42",
  });
});

test.each([
  ["equal to", displayAt],
  ["one microsecond before", "2026-11-22T05:35:25.653187Z"],
] as const)("C6 accepts a display date %s updated_at", (_name, updated_at) => {
  const record = codexRecord({ updated_at });
  expect<unknown>(parseBotMessage(record, comment)).toEqual(
    ok(expectedSummary),
  );
});

test("C6 accepts a fractional display date in the updated_at second", () => {
  const record = codexRecord({ updated_at: "2026-11-22T05:35:25Z" });
  expect<unknown>(parseBotMessage(record, comment)).toEqual(
    ok(expectedSummary),
  );
});

test("C6 rejects a display date in the second after updated_at", () => {
  const record = codexRecord({
    body: summary.replaceAll(displayAt, "2026-11-22T05:35:26.000000Z"),
    updated_at: "2026-11-22T05:35:25Z",
  });
  expect<unknown>(parseBotMessage(record, comment)).toEqual({
    ok: false,
    reason: "bot_state_conflict",
    where: "issue_comments/42",
  });
});

test("C15 refuses inline findings and summaries on the wrong stream", () => {
  expect(
    parseBotMessage(codexRecord({ body: inlineFinding }), "review_comments"),
  ).toEqual({
    ok: false,
    reason: "bot_format_unsupported",
    where: "review_comments/42",
  });
  expect<unknown>(parseBotMessage(codexRecord(), "reviews")).toEqual({
    ok: false,
    reason: "bot_format_unsupported",
    where: "reviews/42",
  });
});

test.each(endpoints)(
  "R1 refuses an exact summary copied by CodeRabbit on %s",
  (endpoint) => {
    const record = codeRabbitRecord(endpoint, summary);
    expect<unknown>(parseBotMessage(record, endpoint)).toEqual({
      ok: false,
      reason: "bot_format_unsupported",
      where: `${endpoint}/${record.id}`,
    });
  },
);

test("I9 a human copying the exact Codex summary stays human", () => {
  const user = { type: "User", id: 5, login: "someone" };
  expect<unknown>(parseBotMessage(codexRecord({ user }), comment)).toEqual(
    ok({ kind: "human" }),
  );
});

const suggestions = codexRecord({
  body: suggestionsReceipt,
  commit_id: suggestionsSha,
});

test.each([
  [
    "C10/R2 suggestions receipt",
    suggestions,
    "reviews",
    { kind: "receipt", sha10: "f9276ede4e" },
  ],
  [
    "C12/R2 clean receipt",
    codexRecord({ body: cleanReceipt }),
    comment,
    { kind: "neutral" },
  ],
] as const)("%s", (_name, record, endpoint, expected) => {
  expect<unknown>(parseBotMessage(record, endpoint)).toEqual(ok(expected));
});

test.each([
  [
    "C11 suggestions receipt on another head",
    { ...suggestions, commit_id: "0".repeat(40) },
    "reviews",
    "bot_head_invalid",
  ],
  [
    "C11 suggestions receipt with an abbreviated commit_id",
    { ...suggestions, commit_id: "f9276ede4e" },
    "reviews",
    "bot_head_invalid",
  ],
  [
    "C11 suggestions receipt on issue comments",
    suggestions,
    comment,
    "bot_format_unsupported",
  ],
  [
    "C11 suggestions receipt on review comments",
    suggestions,
    "review_comments",
    "bot_format_unsupported",
  ],
  [
    "C12 clean receipt on reviews",
    codexRecord({ body: cleanReceipt }),
    "reviews",
    "bot_format_unsupported",
  ],
  [
    "C13 changed suggestions padding",
    { ...suggestions, body: suggestionsReceipt.replace("\n    \n", "\n   \n") },
    "reviews",
    "bot_format_malformed",
  ],
] as const)("%s", (_name, record, endpoint, reason) => {
  expect(parseBotMessage(record, endpoint)).toEqual(
    fail(reason, `${endpoint}/${record.id}`),
  );
});

test.each(endpoints)("R1 refuses CodeRabbit copies on %s", (endpoint) => {
  for (const body of [suggestionsReceipt, cleanReceipt]) {
    const record = codeRabbitRecord(endpoint, body);
    expect(parseBotMessage(record, endpoint)).toEqual(
      fail("bot_format_unsupported", `${endpoint}/${record.id}`),
    );
  }
});
