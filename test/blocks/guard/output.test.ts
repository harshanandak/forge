import { setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import { checkOutput } from "../../../src/adapters/fs/guard-files.ts";

setDefaultTimeout(10_000);

test("post-tool hook withholds historical and registered credentials without returning them", () => {
  const canary = ["fixture", "output", "credential", "only"].join("-");
  for (const tool_response of [
    `CLERK_SECRET_KEY=${canary}`,
    { content: [{ text: canary }] },
    { nested: { accessToken: canary } },
  ]) {
    const result = checkOutput(
      { hook_event_name: "PostToolUse", tool_response },
      [canary],
    );
    assert.equal(result.decision, "block");
    assert.ok(!JSON.stringify(result).includes(canary));
  }
});

test("benign output and already-redacted results are allowed; malformed events fail closed", () => {
  assert.deepEqual(
    checkOutput(
      {
        hook_event_name: "PostToolUse",
        tool_response: { content: [{ text: '{ "count": 2 }' }] },
      },
      [],
    ),
    {},
  );
  assert.deepEqual(
    checkOutput(
      {
        hook_event_name: "PostToolUse",
        tool_response: { accessToken: "[REDACTED]" },
      },
      [],
    ),
    {},
  );
  assert.equal(checkOutput({}, []).decision, "block");
  assert.equal(
    checkOutput({ hook_event_name: "PostToolUse", tool_response: "ok" }, [{}])
      .decision,
    "block",
  );
});

test("stale credentials in escaped historical assignments are blocked without a current registration", () => {
  const stale = ["fixture", "historical", "credential"].join(" ");
  for (const output of [
    `prefix \\"ACCESS_TOKEN\\":\\"${stale}\\"`,
    `prefix \\\\"CRON_SECRET\\\\":\\\\"${stale}\\\\"`,
  ]) {
    assert.equal(
      checkOutput(
        { hook_event_name: "PostToolUse", tool_response: { output } },
        [],
      ).decision,
      "block",
    );
  }
});

test("textual assignments allow a complete redaction marker and block a marker with an attached value", () => {
  const event = { hook_event_name: "PostToolUse" };
  assert.deepEqual(
    checkOutput({ ...event, tool_response: "API_TOKEN=[REDACTED]" }, []),
    {},
  );
  assert.equal(
    checkOutput(
      { ...event, tool_response: "API_TOKEN=[REDACTED]fixture-unredacted" },
      [],
    ).decision,
    "block",
  );
});
