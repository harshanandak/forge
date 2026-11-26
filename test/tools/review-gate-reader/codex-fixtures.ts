import type { BotRecord } from "../../../tools/ci/review-gate-reader/bot-identity.ts";
import { codexRecord as baseCodexRecord } from "./bot-fixtures.ts";

export const summary = [
  "<!-- codex-pull-request-review-summary -->",
  '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"b2152f9891bbc2c6892678d5b11131246c77b06a","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->',
  "",
  "<details>",
  "<summary><strong>Codex Review Summary</strong>: \u2705 Completed</summary>",
  "",
  "This comment shows the latest Codex review activity on this pull request.",
  "",
  "| Review | Status | Commit | Review trigger |",
  "| --- | --- | --- | --- |",
  '| \ud83d\udcdd **Code Review** | \u2705 **Completed** <relative-time datetime="2026-11-22T05:35:25.653186Z">2026-11-22T05:35:25.653186Z</relative-time> | `b2152f9` | New commits |',
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

export const suggestionsReceipt = [
  "<!-- codex-review-receipt:v1 -->",
  "",
  "",
  "### \ud83d\udca1 Codex Review",
  "",
  "Here are some automated review suggestions for this pull request.",
  "",
  "**Reviewed commit:** `f9276ede4e`",
  "    ",
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

export const inlineFinding = [
  "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Use the resolved PR base instead of hard-coding main**",
  "",
  "For consumer repositories whose default branch is not `main`, or slices targeting a declared non-default base, this replaces the previous instruction to merge the base with an instruction to merge the wrong branch. The build guide explicitly resolves `<base>` from the slice's declared base or the remote default (`forge-build/pull-request.md:11`) and opens the PR against it, so following this review step can either leave the actual conflict unresolved or introduce unrelated changes from `main`. Keep the conflict/queue-rejection restriction, but apply it to the resolved PR base.",
  "",
  "Useful? React with \ud83d\udc4d\u00a0/ \ud83d\udc4e.",
  "",
  "<!-- codex-code-review-finding:v1 -->",
].join("\n");

export const cleanReceipt = [
  "<!-- codex-review-receipt:v1 -->",
  "",
  "Codex Review: Didn't find any major issues. Hooray!",
  "",
  "**Reviewed commit:** `54bd87f443`",
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

export const displayAt = "2026-11-22T05:35:25.653186Z";
export const summarySha = "b2152f9891bbc2c6892678d5b11131246c77b06a";

export const suggestionsSha = "f9276ede4e" + "0".repeat(30);

export function codexRecord(patch: Partial<BotRecord> = {}): BotRecord {
  return baseCodexRecord({ body: summary, ...patch });
}
