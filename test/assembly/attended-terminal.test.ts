import { expect, test } from "bun:test";
import { attendedTerminal } from "../../src/assembly/approval.ts";

test("a typed confirmation needs two terminals and no agent session", () => {
  expect(attendedTerminal({}, true, true)).toBe(true);
  expect(attendedTerminal({}, false, true)).toBe(false);
  expect(attendedTerminal({}, true, false)).toBe(false);
  for (const env of [
    { CLAUDE_CODE_SESSION_ID: "s" },
    { CODEX_THREAD_ID: "t" },
    { CODEX_SESSION_ID: "s" },
    { FORGE_HARNESS: "codex" },
    { FORGE_AGENT: "bot" },
  ])
    expect(attendedTerminal(env, true, true)).toBe(false);
  expect(attendedTerminal({ FORGE_AGENT: " " }, true, true)).toBe(true);
}, 30_000);
