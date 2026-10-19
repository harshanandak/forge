import { expect, test } from "bun:test";
import { createGithubCommandPort } from "../../../src/adapters/github-cli/index.ts";
import type { ProcessPort } from "../../../src/ports/process.ts";

test("token-bearing GitHub children resolve Git through the pinned installation and isolate configuration", async () => {
  let child: Readonly<Record<string, string>> = {};
  const process: ProcessPort = {
    capability: "forge.process/v1",
    resolve: () => ({ kind: "resolved", path: "/trusted/gh" }),
    run(_executable, _args, options) {
      child = options.env;
      return Promise.resolve({ exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 0 });
    },
  };
  const account = createGithubCommandPort(process);
  const options = {
    cwd: "/clone", timeoutMs: 1000, maxOutputBytes: 100,
    env: { PATH: "/planted:/ambient", GH_TOKEN: Buffer.from("selected-fixture").toString("base64url"), GH_CONFIG_DIR: "/native/accounts", EDITOR: "/planted/editor", GH_PAGER: "/planted/pager", BROWSER: "/planted/browser" },
    trustedGitPath: "/trusted/git-install/git",
    trustedConfigPath: "/clone/.git/owned-config",
  };
  await account.run("/trusted/gh", ["pr", "view"], options);
  expect(child.PATH, "an ambient first-PATH Git must never receive the selected token").toBe("/trusted/git-install");
  expect(child.GH_CONFIG_DIR).toBe(options.trustedConfigPath);
  for (const name of ["EDITOR", "GH_EDITOR", "VISUAL", "PAGER", "GH_PAGER", "BROWSER", "GH_BROWSER"]) expect(child[name]).toBe("");
}, 1000);
