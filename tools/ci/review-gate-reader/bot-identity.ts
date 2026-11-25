import { fail, ok, type Result } from "./result.ts";

export type Endpoint = "issue_comments" | "reviews" | "review_comments";
export type BotRecord = {
  id: number;
  user: { type: string; id: number; login: string };
  performed_via_github_app?: { id: number; slug: string } | null;
  body: string;
  updated_at: string;
  commit_id?: string;
};

const pins = Object.freeze({
  codex: Object.freeze({
    id: 199175422,
    login: "chatgpt-codex-connector[bot]",
    appId: 1144995,
    slug: "chatgpt-codex-connector",
  }),
  coderabbit: Object.freeze({
    id: 136622811,
    login: "coderabbitai[bot]",
    appId: 347564,
    slug: "coderabbitai",
  }),
});

type Author = { kind: "human" } | { kind: "bot"; bot: keyof typeof pins };

export function classifyBotAuthor(
  record: BotRecord,
  endpoint: Endpoint,
): Result<Author> {
  const { user, performed_via_github_app: app } = record;
  const where = `${endpoint}/${record.id}`;
  for (const bot of ["codex", "coderabbit"] as const) {
    const pin = pins[bot];
    if (user.id !== pin.id && user.login !== pin.login) continue;
    const appMatches = app
      ? app.id === pin.appId && app.slug === pin.slug
      : endpoint !== "issue_comments";
    if (
      user.type !== "Bot" ||
      user.id !== pin.id ||
      user.login !== pin.login ||
      !appMatches
    )
      return fail("bot_identity_mismatch", where);
    return ok({ kind: "bot", bot });
  }
  return user.type === "Bot"
    ? fail("other_bot_unsupported", where)
    : ok({ kind: "human" });
}
