import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { classifyBotAuthor } from "../../../tools/ci/review-gate-reader/bot-identity.ts";
import { parseBotMessage } from "../../../tools/ci/review-gate-reader/codex-messages.ts";
import { ok } from "../../../tools/ci/review-gate-reader/result.ts";
import {
  codeRabbitLimit,
  codeRabbitRecord,
  codexRecord,
  endpoints,
} from "./bot-fixtures.ts";

setDefaultTimeout(1000);

const refusal = <R extends string>(reason: R, where: string) => ({
  ok: false as const,
  reason,
  where,
});
const comment = "issue_comments";
const { performed_via_github_app: _app, ...withoutApp } = codexRecord();
const { user } = withoutApp;
const pinned = codexRecord();
const nullApp = codexRecord({ performed_via_github_app: null });

test.each([
  ["I1 pinned Codex issue comment", comment, pinned, "codex"],
  ["I2 absent App", "reviews", withoutApp, "codex"],
  ["I2 null App", "reviews", nullApp, "codex"],
  ["I2 pinned App", "reviews", pinned, "codex"],
  ["I2 absent App", "review_comments", withoutApp, "codex"],
  ["I2 null App", "review_comments", nullApp, "codex"],
  ["I2 pinned App", "review_comments", pinned, "codex"],
  [
    "I3 pinned CodeRabbit issue comment",
    comment,
    codeRabbitRecord(comment, ""),
    "coderabbit",
  ],
  [
    "I3 CodeRabbit review without App",
    "reviews",
    codeRabbitRecord("reviews", ""),
    "coderabbit",
  ],
] as const)("%s on %s", (_name, endpoint, record, bot) => {
  expect(classifyBotAuthor(record, endpoint)).toEqual(ok({ kind: "bot", bot }));
});

test.each([
  ["I4 wrong type", { type: "User" }],
  ["I5 wrong login", { login: "someone" }],
  ["I5 wrong id", { id: 5 }],
  ["I5 crossed pins", { id: 136622811 }],
] as const)("%s", (_name, patch) => {
  const record = codexRecord({ user: { ...user, ...patch } });
  expect(classifyBotAuthor(record, comment)).toEqual(
    refusal("bot_identity_mismatch", "issue_comments/42"),
  );
});

const pinnedApp = { id: 1144995, slug: "chatgpt-codex-connector" };
const appRecord = (id: number, slug: string) =>
  codexRecord({ performed_via_github_app: { id, slug } });
const wrongId = appRecord(999, pinnedApp.slug);
const wrongSlug = appRecord(pinnedApp.id, "coderabbitai");

test.each([
  ["I6 wrong App id", comment, wrongId],
  ["I6 wrong App slug", comment, wrongSlug],
  ["I6 absent App", comment, withoutApp],
  ["I6 null App", comment, nullApp],
  ["I7 wrong present App", "reviews", wrongId],
  ["I7 wrong present slug", "review_comments", wrongSlug],
] as const)("%s", (_name, endpoint, record) => {
  expect(classifyBotAuthor(record, endpoint)).toEqual(
    refusal("bot_identity_mismatch", `${endpoint}/42`),
  );
});

test.each(endpoints)("I8 refuses another bot on %s", (endpoint) => {
  const user = { type: "Bot", id: 41898282, login: "github-actions[bot]" };
  expect(classifyBotAuthor({ ...withoutApp, user }, endpoint)).toEqual(
    refusal("other_bot_unsupported", `${endpoint}/42`),
  );
});

test("I9 a human copying a bot body stays human", () => {
  const user = { type: "User", id: 5, login: "someone" };
  const record = { ...withoutApp, user, body: codeRabbitLimit };
  expect(parseBotMessage(record, comment)).toEqual(ok({ kind: "human" }));
});

test.each(endpoints)("R1 refuses pinned CodeRabbit on %s", (endpoint) => {
  for (const body of [
    codeRabbitLimit,
    "<!-- coderabbit-ai-generated:v1 -->",
    "",
  ]) {
    expect(parseBotMessage(codeRabbitRecord(endpoint, body), endpoint)).toEqual(
      refusal("bot_format_unsupported", `${endpoint}/43`),
    );
  }
});

test("E1 imports do not fetch or read a clock", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response());
  const clockSpy = spyOn(Date, "now").mockReturnValue(0);
  const importRoot = "../../../tools/ci/review-gate-reader";
  try {
    for (const name of ["bot-identity", "codex-messages"]) {
      await import(`${importRoot}/${name}.ts?import-hygiene`);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(clockSpy).toHaveBeenCalledTimes(0);
  } finally {
    fetchSpy.mockRestore();
    clockSpy.mockRestore();
  }
});
