import type {
  BotRecord,
  Endpoint,
} from "../../../tools/ci/review-gate-reader/bot-identity.ts";

export { codeRabbitLimit } from "./fixtures/coderabbit-limit.ts";

export const endpoints = [
  "issue_comments",
  "reviews",
  "review_comments",
] as const;
export function codexRecord(patch: Partial<BotRecord> = {}): BotRecord {
  return {
    id: 42,
    user: { type: "Bot", id: 199175422, login: "chatgpt-codex-connector[bot]" },
    performed_via_github_app: { id: 1144995, slug: "chatgpt-codex-connector" },
    updated_at: "2026-11-22T05:40:00Z",
    body: "",
    ...patch,
  };
}

export function codeRabbitRecord(endpoint: Endpoint, body: string): BotRecord {
  return {
    id: 43,
    user: { type: "Bot", id: 136622811, login: "coderabbitai[bot]" },
    ...(endpoint === "issue_comments"
      ? { performed_via_github_app: { id: 347564, slug: "coderabbitai" } }
      : {}),
    updated_at: "2026-11-22T05:40:00Z",
    body,
  };
}
