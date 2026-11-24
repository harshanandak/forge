import { expect, test } from "bun:test";
import { SECRET_PATTERNS } from "../../src/contract/errors.ts";
import { HOST_KEY_PATTERN, TOKEN_PATTERN } from "../../src/contract/ids.ts";

const timeout = 30_000;

test(
  "C1 client docs carry safe examples for the three clients, hooks and recovery",
  async () => {
    const source = Bun.file(new URL("../../docs/clients.md", import.meta.url));
    expect(await source.exists()).toBe(true);
    const doc = await source.text();
    for (const value of [
      "Claude Code",
      "Codex",
      "OpenCode",
      "FORGE_HUB_TOKEN",
      "forge-hub",
      "FORGE_HUB_URL",
      "FORGE_HUB_HOST_KEY_FILE",
      "2.1.295",
      '"onFailure": "block"',
      "bin/session-start.mjs",
      "bin/pre-tool.mjs",
      "bin/stop.mjs",
      "local guard",
      "server boundary",
      "fail-closed",
      "sessionId",
      "inbox",
      "redelivered",
      "127.0.0.1",
      "T3 agent link",
      "port forwarding",
    ])
      expect(doc).toContain(value);
    expect(doc).toMatch(/retry.*(?:ask|reply|send)/i);
    expect(doc).not.toContain("UserPromptSubmit");
    for (const pattern of [HOST_KEY_PATTERN, TOKEN_PATTERN, ...SECRET_PATTERNS])
      expect(doc).not.toMatch(pattern);
  },
  timeout,
);
