import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderAccountScripts } from "../../../src/adapters/github-cli/scripts.ts";

const temporary = realpathSync.native(mkdtempSync(join(tmpdir(), "forge-router-path-")));
const planted = join(temporary, "planted");
const marker = join(temporary, "untrusted-git-ran");
const native = process.env;
const env = Object.fromEntries(Object.entries(native).filter(([key, value]) => value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/^(?:GIT_|GH_|GITHUB_|NODE_OPTIONS$)/i.test(key)));
Object.assign(env, { HOME: temporary, USERPROFILE: temporary, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(temporary, "global"), ROUTER_PATH_MARKER: marker });
function run(program, args, input, environment = env) {
  const result = spawnSync(program, args, { cwd: temporary, env: environment, input, encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  assert.equal(result.status, 0, `fixture command failed (${result.error?.message ?? result.status})`);
  return result.stdout.trim();
}
try {
  run("git", ["init"]);
  run("git", ["config", "forge.githubAccount", "fixture"]);
  const gitExec = run("git", ["--exec-path"]);
  const gitBase = dirname(dirname(dirname(gitExec)));
  const shellPath = process.platform === "win32" ? [join(gitBase, "usr/bin/sh.exe"), join(gitBase, "bin/bash.exe")].find(existsSync) : "/bin/sh";
  assert.ok(shellPath);
  const envPath = process.platform === "win32" ? join(dirname(shellPath), "env.exe") : "/usr/bin/env";
  const gitPath = process.platform === "win32" ? join(gitBase, "cmd/git.exe") : run("/bin/sh", ["-c", "command -v git"]);
  assert.ok(existsSync(gitPath));
  mkdirSync(planted);
  if (process.platform === "win32") {
    copyFileSync(process.execPath, join(planted, "git.exe"));
    for (const name of ["remote", "rev-parse", "config"]) writeFileSync(join(temporary, name), "require('node:fs').writeFileSync(process.env.ROUTER_PATH_MARKER,process.env.GH_TOKEN?'token-seen':'no-token');\n");
  } else {
    writeFileSync(join(planted, "git"), '#!/bin/sh\nif [ -n "${GH_TOKEN-}" ]; then printf token-seen; else printf no-token; fi > "$ROUTER_PATH_MARKER"\n', { mode: 0o700 });
  }
  const key = Object.keys(env).find(name => name.toUpperCase() === "PATH") ?? "PATH";
  env[key] = planted + delimiter + (env[key] ?? "");
  env.ROUTER_PROBE_API = "0";
  const fakeGh = join(temporary, "fake-gh.mjs");
  writeFileSync(fakeGh, `import {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);\nif(args[0]==='auth'){process.stdout.write(Buffer.from('fixture-selected-credential').toString('base64url'));}\nelse {const child=spawnSync('git',['remote','--verbose'],{env:process.env,stdio:'ignore',windowsHide:true,timeout:5000});if(child.status!==0)process.exit(2);process.stdout.write(args[0]==='api'?'fixture':'routed');}\n`);
  const scripts = renderAccountScripts({ account: "fixture", gitPath, ghPath: process.execPath, ghArgs: [fakeGh], envPath, shellPath, environmentNames: Object.keys(env), allowedGhCommands: ["pr view"], accountKey: "forge.githubAccount", marker: "# fixture router", windows: process.platform === "win32" });
  for (const [name, body] of Object.entries(scripts)) {
    const file = join(temporary, name);
    writeFileSync(file, body, { mode: 0o700 });
    run(shellPath, [file, ...(name === "router" ? ["pr", "view"] : ["get"])], name === "credential" ? "protocol=https\nhost=github.com\n\n" : undefined);
    assert.equal(existsSync(marker), false, "ambient PATH Git must never run or receive the selected account credential");
  }
  console.log("PASS router-path");
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
