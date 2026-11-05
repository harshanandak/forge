import assert from "node:assert/strict";

const gated = new Set(["block.admit", "config.grant", "store.reinit"]);

export function approvalReply(
  result,
  source = { harness: "packed-fixture", thread: "packed-owner-chat" },
) {
  assert.equal(result.error?.code, "APPROVAL_REQUIRED");
  const request = result.result?.request?.id;
  assert.equal(typeof request, "string");
  return { request, quote: "yes", source };
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
        if (!first.ok && first.error.code === "APPROVAL_REQUIRED")
          return call(
            [
              ...args.slice(0, 2),
              "--input",
              JSON.stringify({ ...input, approval: approvalReply(first) }),
            ],
            expected,
            ...rest,
          );
        return first;
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
      gated.has(op) &&
      !input?.approval
        ? call(op, { ...input, approval: approvalReply(first) }, ...rest)
        : first;
    const first = call(op, input, ...rest);
    return typeof first?.then === "function" ? first.then(retry) : retry(first);
  };
}
