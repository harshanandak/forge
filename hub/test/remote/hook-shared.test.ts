import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as contract from "../../src/contract/hooks.ts";
import { MCP_SERVER_NAME } from "../../src/contract/mcp.ts";
import * as shared from "../../src/hooks/shared.ts";
import { FakeHostBridge } from "../fakes/fake-host.ts";
import { fakeCore, fail, person } from "./fixtures.ts";

const timeout = 30_000;
const hub = fileURLToPath(new URL("../../", import.meta.url));
const paths = ["pre-tool.ts", "session-start.ts", "shared.ts", "stop.ts"];
const declarations = /(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g;

test(
  "P16 standalone hook constants equal the frozen API",
  () => {
    expect<readonly string[]>(shared.HOOK_READ_TOOLS).toEqual(
      contract.HOOK_READ_TOOLS,
    );
    expect<readonly string[]>(
      shared.hookForgeToolNames(MCP_SERVER_NAME),
    ).toEqual(contract.hookForgeToolNames(MCP_SERVER_NAME));
    expect(shared.HOOK_PATHS).toEqual(contract.HOOK_PATHS);
    expect(shared.HOOK_TIMEOUT_MS).toBe(contract.HOOK_TIMEOUT_MS);
    expect(shared.HOOK_STOP_TIMEOUT_MS).toBe(contract.HOOK_STOP_TIMEOUT_MS);
    expect(shared.HOOK_STOP_TEXT_MAX).toBe(contract.HOOK_STOP_TEXT_MAX);
  },
  timeout,
);

test(
  "Y2 and U2 hook sources contain only the four files and standalone imports",
  async () => {
    const files = await readdir(join(hub, "src", "hooks"));
    expect(files.toSorted()).toEqual(paths);
    for (const path of files) {
      const text = await readFile(join(hub, "src", "hooks", path), "utf8");
      for (const [, specifier] of text.matchAll(declarations)) {
        expect(
          specifier?.startsWith("node:") ||
            (path !== "shared.ts" && specifier === "./shared.js"),
        ).toBe(true);
      }
    }
    expect(Object.keys(contract.HOOK_PATHS)).toEqual([
      "session",
      "mode",
      "stop",
    ]);
  },
  timeout,
);

test(
  "Y3 sources never import a launcher or use an entry guard",
  async () => {
    for (const root of ["src", "test"]) {
      for await (const path of new Bun.Glob("**/*.ts").scan(join(hub, root))) {
        const text = await readFile(join(hub, root, path), "utf8");
        expect(text.includes("import.meta" + ".main")).toBe(false);
        for (const [, specifier] of text.matchAll(declarations)) {
          expect(specifier).not.toMatch(
            /(?:^|\/)(?:forge-hub|session-start|pre-tool|stop)\.mjs$/,
          );
        }
      }
    }
  },
  timeout,
);

test(
  "F1 FakeHostBridge returns mode session id and preserves host-only calls",
  () => {
    const fake = fakeCore();
    const caller = { person, hostInstanceId: "hst_a" };
    const bridge = new FakeHostBridge(fake, caller);
    expect(bridge.mode("s1")).toEqual({ mode: "normal", sessionId: "ses_a" });
    expect(fake.calls).toEqual([
      ["hookMode", caller, { host: "claude", hostSessionId: "s1" }],
    ]);
    fake.hookSession = () => fail("SESSION_UNKNOWN");
    expect(() => bridge.start("s1")).toThrow("SESSION_UNKNOWN");
  },
  timeout,
);
