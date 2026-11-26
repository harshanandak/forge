import {
  classifyBotAuthor,
  type BotRecord,
  type Endpoint,
} from "./bot-identity.ts";
import { fail, ok, type Result } from "./result.ts";
import { bool, parseStrictJson, str } from "./strict-json.ts";

const summaryMarker = "<!-- codex-pull-request-review-summary -->";
const receiptMarker = "<!-- codex-review-receipt:v1 -->";
const malformedSummaryOpening =
  /^[ \t]*<!--[ \t]*codex-pull-request-review-summary[ \t]*-->/i;
const summaryBody = (state: string, displayRow: string) =>
  [
    summaryMarker,
    state,
    "",
    "<details>",
    "<summary><strong>Codex Review Summary</strong>: \u2705 Completed</summary>",
    "",
    "This comment shows the latest Codex review activity on this pull request.",
    "",
    "| Review | Status | Commit | Review trigger |",
    "| --- | --- | --- | --- |",
    displayRow,
    "",
    "",
    "",
    "<details> <summary>\u2139\ufe0f About Codex in GitHub</summary>",
    "<br/>",
    "",
    "[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you",
    "- Open a pull request for review",
    "- Mark a draft as ready",
    '- Comment "@codex review" or "@codex security review".',
    "",
    "Codex reacts with \ud83d\udc40 while any review is running, comments if it has suggestions, and reacts with \ud83d\udc4d once all reviews finish with no findings.",
    "",
    "</details>",
    "",
    "</details>",
  ].join("\n");

const suggestionsHead = [
  receiptMarker,
  "",
  "",
  "### \ud83d\udca1 Codex Review",
  "",
  "Here are some automated review suggestions for this pull request.",
  "",
].join("\n");
const cleanHead = [
  receiptMarker,
  "",
  "Codex Review: Didn't find any major issues. Hooray!",
  "",
].join("\n");
const commitLabel = "**Reviewed commit:** `";
const suggestionsSuffix = "\n    ";
const receiptFooter = [
  "",
  "<details> <summary>\u2139\ufe0f About Codex in GitHub</summary>",
  "<br/>",
  "",
  "[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you",
  "- Open a pull request for review",
  "- Mark a draft as ready",
  '- Comment "@codex review".',
  "",
  "If Codex has suggestions, it will comment; otherwise it will react with \ud83d\udc4d.",
  "",
  "",
  "",
  "",
  'Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".',
  "            ",
  "</details>",
].join("\n");

const stateLine = /^<!-- codex-review-state:v(\d+) (.*) -->$/;
const displayLine =
  /^\| \ud83d\udcdd \*\*Code Review\*\* \| \u2705 \*\*Completed\*\* <relative-time datetime="([^"]*)">([^<]*)<\/relative-time> \| `([0-9a-f]{7})` \| (New commits|PR opened|Manual request) \|$/;
const sha40 = /^[0-9a-f]{40}$/;
const sha10 = /^[0-9a-f]{10}$/;
const utc6 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const isNull = (value: unknown): value is null => value === null;
const nullableText = (value: unknown): value is string | null =>
  isNull(value) || str(value);
const nullableBool = (value: unknown): value is boolean | null =>
  isNull(value) || bool(value);
const stateSchema = {
  code_review: {
    commit_sha: str,
    has_any_findings: bool,
    has_unresolved_findings: bool,
    status: str,
  },
  security_review: {
    commit_sha: nullableText,
    has_any_findings: nullableBool,
    has_unresolved_findings: nullableBool,
    status: nullableText,
  },
};

type CodexSummary = {
  kind: "summary";
  commitSha: string;
  any: boolean;
  unresolved: boolean;
  status: "completed";
  displayAt: string;
  trigger: string;
};

type CodexMessage =
  CodexSummary | { kind: "neutral" } | { kind: "receipt"; sha10: string };

function validDate(value: string): boolean {
  if (!utc6.test(value)) return false;
  const millis = Date.parse(value);
  return (
    Number.isFinite(millis) &&
    new Date(millis).toISOString() === `${value.slice(0, -4)}Z`
  );
}

function parseSummary(record: BotRecord, where: string): Result<CodexSummary> {
  const lines = record.body.split("\n");
  const state = lines[1] ?? "";
  const display = lines[10] ?? "";
  const versionMatch = stateLine.exec(state);
  if (!versionMatch || record.body !== summaryBody(state, display))
    return fail("bot_format_malformed", where);
  const [, version, json = ""] = versionMatch;
  if (version !== "1") return fail("bot_version_unsupported", where);
  const row = displayLine.exec(display);
  if (!row) return fail("bot_format_malformed", where);

  const parsed = parseStrictJson(json, stateSchema);
  if (!parsed.ok || JSON.stringify(parsed.value) !== json)
    return fail("bot_state_invalid", where);
  const { code_review: code, security_review: security } = parsed.value;
  const {
    commit_sha: commitSha,
    has_any_findings: any,
    has_unresolved_findings: unresolved,
    status,
  } = code;
  if (
    status !== "completed" ||
    Object.values(security).some((value) => value !== null)
  )
    return fail("bot_format_unsupported", where);
  if (!sha40.test(commitSha)) return fail("bot_head_invalid", where);

  const [, displayAt = "", displayAtText = "", displayHead, trigger = ""] = row;
  const updatedAt = record.updated_at.replace(
    /(?:\.(\d+))?Z$/,
    (_suffix, fraction: string | undefined) =>
      `.${(fraction ?? "").padEnd(6, "0")}Z`,
  );
  if (
    !validDate(displayAt) ||
    !validDate(displayAtText) ||
    !validDate(updatedAt)
  )
    return fail("bot_state_invalid", where);
  const displayIsLater = record.updated_at.includes(".")
    ? displayAt > updatedAt
    : displayAt.slice(0, 19) > updatedAt.slice(0, 19);
  if (
    (!any && unresolved) ||
    displayHead !== commitSha.slice(0, 7) ||
    displayAt !== displayAtText ||
    displayIsLater
  )
    return fail("bot_state_conflict", where);
  return ok({
    kind: "summary",
    commitSha,
    any,
    unresolved,
    status,
    displayAt,
    trigger,
  });
}

function parseReceipt(
  record: BotRecord,
  endpoint: Endpoint,
  where: string,
): Result<CodexMessage> {
  const { body } = record;
  const suggestions = body.startsWith(suggestionsHead);
  if (
    endpoint === "review_comments" ||
    (suggestions && endpoint !== "reviews") ||
    (body.startsWith(cleanHead) && endpoint !== "issue_comments")
  )
    return fail("bot_format_unsupported", where);
  const head = endpoint === "reviews" ? suggestionsHead : cleanHead;
  const prefix = `${head}\n${commitLabel}`;
  const suffix = `\u0060${endpoint === "reviews" ? suggestionsSuffix : ""}\n${receiptFooter}`;
  if (!body.startsWith(prefix) || !body.endsWith(suffix))
    return fail("bot_format_malformed", where);
  const headSlot = body.slice(prefix.length, -suffix.length);
  if (/[\r\n`]/.test(headSlot)) return fail("bot_format_malformed", where);
  if (!sha10.test(headSlot)) return fail("bot_head_invalid", where);
  if (endpoint === "issue_comments") return ok({ kind: "neutral" });
  if (
    !record.commit_id ||
    !sha40.test(record.commit_id) ||
    !record.commit_id.startsWith(headSlot)
  )
    return fail("bot_head_invalid", where);
  return ok({ kind: "receipt", sha10: headSlot });
}

export function parseCodexMessage(
  record: BotRecord,
  endpoint: Endpoint,
): Result<CodexMessage> {
  const { body } = record;
  const where = `${endpoint}/${record.id}`;
  if (body.startsWith(summaryMarker) && endpoint === "issue_comments")
    return parseSummary(record, where);
  if (endpoint === "issue_comments" && malformedSummaryOpening.test(body))
    return fail("bot_format_malformed", where);
  if (body.startsWith(receiptMarker))
    return parseReceipt(record, endpoint, where);
  return fail("bot_format_unsupported", where);
}

export function parseBotMessage(
  record: BotRecord,
  endpoint: Endpoint,
): Result<CodexMessage | { kind: "human" }> {
  const author = classifyBotAuthor(record, endpoint);
  if (!author.ok) return author;
  if (author.value.kind === "human") return ok(author.value);
  if (author.value.bot === "codex") return parseCodexMessage(record, endpoint);
  return fail("bot_format_unsupported", `${endpoint}/${record.id}`);
}
