import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const gated = new Set([
  "block.admit",
  "config.grant",
  "store.reinit",
  "project.init",
]);
const memoryGated = new Set([
  "memory.forget",
  "memory.restore",
  "memory.accept",
  "memory.reject",
  "decision.adopt",
]);

export function approvalReply(
  result,
  source = { harness: "packed-fixture", thread: "packed-owner-chat" },
  quote = "yes",
) {
  assert.equal(result.error?.code, "APPROVAL_REQUIRED");
  const request = result.result?.request?.id;
  assert.equal(typeof request, "string");
  assert.ok(request.length > 0);
  return { request, quote, source };
}

/** True when a memory call claims the owner's words and so needs a relayed reply. */
export function claimsOwner(op, input) {
  return (
    (memoryGated.has(op) ||
      /\.(forget|restore|adopt|accept|reject)$/.test(op)) &&
    input?.approval?.by === "owner" &&
    input.approval.request === undefined
  );
}

/** The relayed retry for a memory call that claimed the owner's words: same input, their quote kept. */
export function relayedMemoryInput(input, first, source) {
  return {
    ...input,
    approval: approvalReply(first, source, input.approval.quote),
  };
}

export function withCliOwnerApproval(call) {
  return (args, expected = 0, ...rest) => {
    const op = args.slice(0, 2).join(".");
    if (expected === 0 && gated.has(op)) {
      const input = args.includes("--input")
        ? JSON.parse(args[args.indexOf("--input") + 1])
        : { digest: args[2] };
      if (!input.approval) {
        const first = call(args, 1, ...rest);
        const approval = approvalReply(first);
        const retried = call(
          [
            ...args.slice(0, 2),
            "--input",
            JSON.stringify({ ...input, approval }),
          ],
          expected,
          ...rest,
        );
        assert.equal(retried.ok, true);
        return retried;
      }
    }
    return call(args, expected, ...rest);
  };
}

/** The same relay works over direct catalog calls and MCP; refusals stay refusals. */
export function withOwnerApproval(call) {
  return (op, input = {}, ...rest) => {
    const retry = (first) =>
      first?.ok === false &&
      first.error.code === "APPROVAL_REQUIRED" &&
      first.result?.request &&
      ((gated.has(op) && !input?.approval) || claimsOwner(op, input))
        ? call(
            op,
            claimsOwner(op, input)
              ? relayedMemoryInput(input, first)
              : { ...input, approval: approvalReply(first) },
            ...rest,
          )
        : first;
    const first = call(op, input, ...rest);
    return typeof first?.then === "function" ? first.then(retry) : retry(first);
  };
}

const agentMarkers = [
  "FORGE_HARNESS",
  "FORGE_AGENT",
  "FORGE_SESSION",
  "CLAUDECODE",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "CLAUDE_CODE_SESSION_ID",
  "T3CODE_CLI_PATH",
  "T3CODE_THREAD_ID",
];
/** CI-style fixtures model a script with no agent session, so the markers a harness sets are removed. */
export function unattendedEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !agentMarkers.includes(key)),
  );
}
/** Writes the owner's device policy that lets those scripts admit and grant without a relayed reply. */
export function writeOwnerPolicy(deviceRoot) {
  mkdirSync(deviceRoot, { recursive: true });
  writeFileSync(
    join(deviceRoot, "owner.json"),
    JSON.stringify({ unattended: ["block.admit", "config.grant"] }),
    { mode: 0o600 },
  );
}
