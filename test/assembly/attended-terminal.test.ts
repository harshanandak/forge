import { expect, test } from "bun:test";
import {
  agentSession,
  attendedTerminal,
  unattendedOps,
} from "../../src/assembly/approval.ts";

const markers = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "T3CODE_CLI_PATH",
  "T3CODE_THREAD_ID",
  "FORGE_AGENT",
  "FORGE_SESSION",
] as const;

test("a typed confirmation needs two terminals and no agent session", () => {
  expect(attendedTerminal({}, true, true)).toBe(true);
  expect(attendedTerminal({}, false, true)).toBe(false);
  expect(attendedTerminal({}, true, false)).toBe(false);
  expect(attendedTerminal({ FORGE_AGENT: " " }, true, true)).toBe(true);
  expect(attendedTerminal({ FORGE_HARNESS: "local-cli" }, true, true)).toBe(
    true,
  );
}, 30_000);

test("each agent marker alone is an agent session, for the prompt and for the policy", () => {
  for (const marker of markers) {
    expect(agentSession({ [marker]: "x" })).toBe(true);
    expect(attendedTerminal({ [marker]: "x" }, true, true)).toBe(false);
  }
  expect(agentSession({ FORGE_HARNESS: "codex" })).toBe(true);
  expect(agentSession({})).toBe(false);
}, 30_000);

test("FORGE_HARNESS=local-cli never turns an agent into a human", () => {
  for (const marker of markers) {
    const env = { FORGE_HARNESS: "local-cli", [marker]: "x" };
    expect(agentSession(env)).toBe(true);
    expect(attendedTerminal(env, true, true)).toBe(false);
  }
}, 30_000);

test("one malformed owner.json member voids the whole policy", () => {
  const ok = unattendedOps('{"unattended":["block.admit","config.grant"]}');
  expect([...ok.ops].sort()).toEqual(["block.admit", "config.grant"]);
  expect(ok.problem).toBeUndefined();
  expect(unattendedOps(undefined).ops.size).toBe(0);
  for (const text of [
    '{"unattended":["block.admit",42]}',
    '{"unattended":["block.admit","block.admit"]}',
    '{"unattended":["block.admit","store.reinit"]}',
    '{"unattended":["block.admit"],"extra":true}',
    '{"unattended":"block.admit"}',
    '["block.admit"]',
    "not json",
  ]) {
    const voided = unattendedOps(text);
    expect(voided.ops.size).toBe(0);
    expect(voided.problem).toContain("owner.json");
  }
}, 30_000);
