import { afterEach, expect, test } from "bun:test";
import {
  localContext,
  localSession,
  type Assembly,
} from "../../../src/assembly/index.ts";
import {
  harnessIdentity,
  sessionIdentity,
} from "../../../src/assembly/identity.ts";
import { validateAmbientContext } from "../../../src/generated/validators.ts";

test("session device schema accepts 256 characters and refuses 257", () => {
  expect(
    validateAmbientContext({ session: { id: "chat", device: "d".repeat(256) } })
      .ok,
  ).toBe(true);
  expect(
    validateAmbientContext({ session: { id: "chat", device: "d".repeat(257) } })
      .ok,
  ).toBe(false);
}, 10000);

const keys = [
  "FORGE_SESSION",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_COMPANION_SESSION_ID",
] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
function environment(values: Record<string, string> = {}) {
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
}
afterEach(() => {
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("explicit and singleton native sessions are trimmed; empty values fall through", () => {
  environment({ FORGE_SESSION: "  shared  ", CODEX_THREAD_ID: "native" });
  expect(localSession("fallback")).toBe("shared");
  environment({ FORGE_SESSION: "  ", CODEX_THREAD_ID: " thread " });
  const thread = localSession("fallback");
  environment({ CODEX_THREAD_ID: "thread" });
  expect(localSession("fallback")).toBe(thread);
  environment({ CLAUDE_CODE_SESSION_ID: "thread" });
  expect(localSession("fallback")).not.toBe(thread);
  environment({ CODEX_COMPANION_SESSION_ID: "plugin" });
  expect(localSession(" fallback ")).toBe("fallback");
}, 10000);

test("ambient context never uses a filesystem path as the holder device", () => {
  const assembly = {
    root: "/project",
    deviceRoot: "/private/home/.forge",
  } as Assembly;
  const context = localContext(
    assembly,
    { kind: "human", id: "local-cli" },
    " session ",
  );
  expect(context.session?.device).toBeUndefined();
  expect(context.session?.id).toBe("session");
}, 10000);

test("each harness session fences both nesting directions and supports the Codex thread fallback", () => {
  environment({ CODEX_THREAD_ID: "thread" });
  const codex = localSession("fallback");
  environment({ CLAUDE_CODE_SESSION_ID: "claude" });
  const claude = localSession("fallback");
  environment({ CODEX_THREAD_ID: "thread", CLAUDE_CODE_SESSION_ID: "claude" });
  const nested = localSession("fallback");
  expect(nested).not.toBe(codex);
  expect(nested).not.toBe(claude);
  environment({
    CODEX_THREAD_ID: "thread",
    CODEX_SESSION_ID: "alias",
    CLAUDE_CODE_SESSION_ID: "claude",
  });
  expect(localSession("fallback")).not.toBe(nested);
  environment({
    CLAUDE_CODE_SESSION_ID: "claude",
    CODEX_SESSION_ID: "alias",
    CODEX_THREAD_ID: "thread",
  });
  const all = localSession("fallback");
  environment({
    CODEX_THREAD_ID: " thread ",
    CODEX_SESSION_ID: " alias ",
    CLAUDE_CODE_SESSION_ID: " claude ",
  });
  expect(localSession("fallback")).toBe(all);
  environment({ CODEX_THREAD_ID: "a:b", CLAUDE_CODE_SESSION_ID: "c" });
  const delimited = localSession("fallback");
  environment({ CODEX_THREAD_ID: "a", CLAUDE_CODE_SESSION_ID: "b:c" });
  expect(localSession("fallback")).not.toBe(delimited);
}, 10000);

test("Codex native subagents share the root session despite different thread ids", () => {
  const parent = { CODEX_SESSION_ID: "root", CODEX_THREAD_ID: "parent-thread" };
  const child = { CODEX_SESSION_ID: " root ", CODEX_THREAD_ID: "child-thread" };
  const root = sessionIdentity(parent, "fallback");
  expect(sessionIdentity(child, "fallback")).toBe(root);
  expect(sessionIdentity({ CODEX_SESSION_ID: "root" }, "fallback")).toBe(root);
  expect(
    sessionIdentity({ ...child, CODEX_SESSION_ID: "other-root" }, "fallback"),
  ).not.toBe(root);
  const nested = sessionIdentity(
    { ...parent, CLAUDE_CODE_SESSION_ID: "claude" },
    "fallback",
  );
  expect(nested).not.toBe(root);
  expect(nested).not.toBe(
    sessionIdentity({ CLAUDE_CODE_SESSION_ID: "claude" }, "fallback"),
  );
  expect(
    sessionIdentity({ ...child, CLAUDE_CODE_SESSION_ID: "claude" }, "fallback"),
  ).toBe(nested);
  expect(
    sessionIdentity(
      { CODEX_SESSION_ID: "  ", CODEX_THREAD_ID: "thread" },
      "fallback",
    ),
  ).toBe(sessionIdentity({ CODEX_THREAD_ID: "thread" }, "fallback"));
}, 10000);

test("native keys name harnesses readably; companion ids contribute neither key nor harness", () => {
  const raw = "same-native-value";
  const keys = [
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
  ];
  const sessions = keys.map((key) =>
    sessionIdentity({ [key]: raw }, "fallback"),
  );
  expect(sessions).toEqual([
    "codex:same-native-value",
    "codex:same-native-value",
    "claude-code:same-native-value",
  ]);
  expect(
    sessionIdentity(
      { CODEX_SESSION_ID: "chat-1", CLAUDE_CODE_SESSION_ID: "chat-2" },
      "fallback",
    ),
  ).toBe("codex:chat-1+claude-code:chat-2");
  expect(
    sessionIdentity({ CODEX_SESSION_ID: "a+claude-code:b" }, "fallback"),
  ).not.toBe(
    sessionIdentity(
      { CODEX_SESSION_ID: "a", CLAUDE_CODE_SESSION_ID: "b" },
      "fallback",
    ),
  );
  expect(sessionIdentity({ CODEX_COMPANION_SESSION_ID: raw }, "fallback")).toBe(
    "fallback",
  );
  expect(harnessIdentity({ CODEX_COMPANION_SESSION_ID: raw })).toBe(
    "local-cli",
  );
  expect(
    harnessIdentity({ CODEX_THREAD_ID: "thread", CODEX_SESSION_ID: "alias" }),
  ).toBe("codex");
  expect(
    harnessIdentity({
      CODEX_THREAD_ID: "thread",
      CLAUDE_CODE_SESSION_ID: "claude",
    }),
  ).toBe("codex+claude-code");
  expect(
    harnessIdentity({
      FORGE_HARNESS: " custom ",
      CODEX_THREAD_ID: "thread",
      CLAUDE_CODE_SESSION_ID: "claude",
    }),
  ).toBe("custom");
}, 10000);
