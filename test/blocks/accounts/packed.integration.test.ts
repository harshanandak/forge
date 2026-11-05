import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { packedConsumer } from "../../integration/packed-consumer.ts";

test("installed accounts: one approval catches wrong authors and binds every clone", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-accounts-"));
  const home = join(root, "home"),
    bin = join(home, "bin"),
    temp = join(root, "tmp");
  for (const dir of [home, bin, temp]) mkdirSync(dir, { recursive: true });
  const node = Bun.which("node");
  if (!node) throw new Error("Node required");
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    PATH: bin + delimiter + (process.env.PATH ?? process.env.Path ?? ""),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    FORGE_DEVICE_ROOT: join(home, "device"),
    FORGE_SESSION: "accounts-fixture",
  };
  for (const name of ["SystemRoot", "SYSTEMROOT", "PATHEXT", "COMSPEC"])
    if (process.env[name]) env[name] = process.env[name]!;
  const fake = join(bin, "fake.cjs");
  writeFileSync(
    fake,
    `
const a = process.argv.slice(2);
if (Object.keys(process.env).some(k => /^(GH_TOKEN|GITHUB_TOKEN|NODE_OPTIONS|GIT_AUTHOR_EMAIL)$/i.test(k))) process.exit(9);
if (a[0] === 'auth' && a[1] === 'status') {
  if (process.env.FAKE_TEXT === '1' && a.includes('--json')) { process.stderr.write('unknown flag: --json'); process.exit(1); }
  if (!a.includes('--json')) process.stdout.write('github.com\\n  ✓ Logged in to github.com account alice (keyring)\\n  - Active account: false\\n  ✓ Logged in to github.com account bob (keyring)\\n  - Active account: true\\n');
  else console.log(JSON.stringify({hosts:{'github.com':[{state:'success',active:false,host:'github.com',login:'alice',tokenSource:'keyring',gitProtocol:'https'},{state:'success',active:true,host:'github.com',login:'bob',tokenSource:'keyring',gitProtocol:'https'}]}}));
} else if (a[0] === 'api' && /^users\\/(alice|bob)$/.test(a[1])) {
  console.log(JSON.stringify({id:a[1].endsWith('alice')?101:202,name:a[1].slice(6)}));
} else process.exit(8);
`,
  );
  const gh = join(bin, process.platform === "win32" ? "gh.cmd" : "gh");
  writeFileSync(
    gh,
    process.platform === "win32"
      ? `@echo off\r\n"${node}" "${fake}" %*\r\n`
      : `#!/bin/sh\nexec '${node.replaceAll("'", "'\\''")}' '${fake.replaceAll("'", "'\\''")}' "$@"\n`,
  );
  chmodSync(gh, 0o700);
  const forge = join(
    packedConsumer(),
    "node_modules/forge-workflow/dist/bin/forge.js",
  );
  function run(command: string, args: string[], cwd: string, extra = {}) {
    const out = spawnSync(command, args, {
      cwd,
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    });
    expect(out.error).toBeUndefined();
    return out;
  }
  function git(cwd: string, ...args: string[]) {
    const out = run("git", args, cwd);
    expect(out.status, out.stderr).toBe(0);
    return out.stdout.trim();
  }
  function cli(cwd: string, verb: string, input = {}, extra = {}) {
    const out = run(
      node!,
      [forge, "accounts", verb, "--json", "--input", JSON.stringify(input)],
      cwd,
      extra,
    );
    return { status: out.status, ...JSON.parse(out.stdout) };
  }
  function clone(name: string) {
    const path = join(root, name);
    mkdirSync(path);
    git(path, "init", "-b", "main");
    git(path, "remote", "add", "origin", "https://github.com/alice/app.git");
    git(
      path,
      "-c",
      "user.name=Alice",
      "-c",
      "user.email=101+alice@users.noreply.github.com",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    );
    git(path, "update-ref", "refs/remotes/origin/main", "HEAD");
    mkdirSync(join(path, ".forge"));
    writeFileSync(
      join(path, ".forge/config.yaml"),
      JSON.stringify({
        schemaVersion: "forge.config/1",
        blocks: { accounts: { source: { builtin: "forge/accounts" } } },
      }),
    );
    return path;
  }
  try {
    const repo = clone("first");
    git(repo, "config", "user.email", "202+bob@users.noreply.github.com");
    git(
      repo,
      "-c",
      "user.name=Bob",
      "commit",
      "--allow-empty",
      "-m",
      "wrong author",
    );
    const wrong = git(repo, "rev-parse", "HEAD");
    const plan = cli(
      repo,
      "plan",
      {},
      {
        GH_TOKEN: "fixture-secret-never-forward",
        NODE_OPTIONS: "",
        GIT_AUTHOR_EMAIL: "wrong@example.test",
      },
    );
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    expect(plan.result.proposal.login).toBe("alice");
    expect(plan.result.reason).toContain("owns the remote");
    expect(plan.result.ask).toContain("bob");
    expect(plan.result.ask).toContain("unpushed");
    expect(plan.result.hazards.length).toBeGreaterThanOrEqual(2);
    expect(cli(repo, "use", { login: "alice" }).ok).toBe(false);
    expect(
      cli(repo, "use", { login: "alice", approval: { quote: "yes" } }).ok,
    ).toBe(false);
    const approval = { quote: "yes", source: "t3:fixture/message:1" };
    const used = cli(repo, "use", { login: "alice", approval });
    expect(used.ok, JSON.stringify(used)).toBe(true);
    const audit = readFileSync(
      join(home, ".forge/accounts/audit.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      audit.some(
        (row) =>
          row.id === used.result.appliedFrom &&
          row.approval?.quote === "yes" &&
          row.approval?.source === approval.source,
      ),
    ).toBe(true);
    expect(git(repo, "config", "user.useConfigOnly")).toBe("true");
    git(repo, "commit", "--allow-empty", "-m", "bound author");
    expect(git(repo, "log", "-1", "--format=%ae")).toBe(
      "101+alice@users.noreply.github.com",
    );
    const check = cli(repo, "check", { service: "github" });
    expect(check.ok).toBe(false);
    expect(check.error.message).toContain(wrong);
    expect(check.error.message).toContain("alice");
    const second = clone("second");
    const inherited = cli(second, "check", { service: "github" });
    expect(inherited.ok, JSON.stringify(inherited)).toBe(true);
    expect(inherited.result.appliedFrom).toBe(used.result.appliedFrom);
    expect(git(second, "config", "user.email")).toBe(
      "101+alice@users.noreply.github.com",
    );
    const other = clone("other");
    git(other, "remote", "set-url", "origin", "git@github.com:bob/other.git");
    expect(cli(other, "check", { service: "github" }).error.code).toBe(
      "ACCOUNT_UNBOUND",
    );
    expect(cli(other, "decline", {}).ok).toBe(false);
    expect(cli(other, "decline", { approval }).ok).toBe(true);
    expect(cli(other, "plan").result.declined).toBe(true);
    writeFileSync(
      join(repo, ".git/forge/accounts.gitconfig"),
      "[user]\nemail=changed@example.test\n",
    );
    expect(cli(repo, "check", { service: "github" }).error.code).toBe(
      "ACCOUNT_INTEGRITY",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
