import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { packedConsumer } from "../../integration/packed-consumer.ts";

type Reply = {
  ok: boolean;
  result: {
    proposal: { login: string };
    reason: string;
    ask: string;
    hazards: string[];
    appliedFrom: string;
    declined?: boolean;
  };
  error: { code: string; message: string };
};
type Audit = {
  id: string;
  kind: string;
  repo: string;
  approval?: { quote: string; source: string };
};

function setup() {
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
    APPDATA: join(home, "appdata"),
    GH_CONFIG_DIR: join(home, "gh"),
    XDG_CONFIG_HOME: join(home, "xdg"),
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
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2), e = process.env;
const flag = (name) => fs.existsSync(path.join(__dirname, name));
const ids = { alice: 101, bob: 202, constructor: 303, mallory: 404 };
if (Object.keys(e).some(k => /^(GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_REPO|NODE_OPTIONS|GIT_AUTHOR_EMAIL|GIT_CONFIG_COUNT)$/i.test(k))) process.exit(9);
if (a[0] === 'api') {
  const who = /^ghp_fixture_(alice|bob|constructor)_9d3f1c$/.exec(e.GH_TOKEN || '')?.[1];
  const dir = e.GH_CONFIG_DIR && path.resolve(e.GH_CONFIG_DIR);
  if (!who || e.GH_HOST !== 'github.com' || e.GH_PROMPT_DISABLED !== '1' || !dir || dir === path.resolve(e.HOME, 'gh') || !fs.existsSync(dir) || fs.readdirSync(dir).length > 0 || !fs.realpathSync(dir).startsWith(fs.realpathSync(e.HOME) + path.sep)) process.exit(7);
  if (flag('apifail')) { fs.writeSync(2, (flag('bigerr') ? 'x'.repeat(500) : '') + 'debug ' + e.GH_TOKEN + '\\n'); process.exit(1); }
  process.stderr.write('debug ' + e.GH_TOKEN + '\\n');
  const route = a[1];
  let m;
  if (route === 'user') console.log(JSON.stringify({ login: flag('swapped') ? 'mallory' : who, id: ids[who] }));
  else if (route === 'user/emails' && a.includes('--paginate')) {
    if (flag('emailscope')) { fs.writeSync(1, JSON.stringify({ message: 'Not Found', status: '404' }) + '\\n'); process.exit(1); }
    const page = JSON.stringify([{ email: ids[who] + '+' + who + '@users.noreply.github.com', primary: true, verified: true }]);
    if (flag('emailpage2')) { fs.writeSync(1, page + '\\n'); process.exit(1); }
    console.log(page);
  }
  else if ((m = /^repos\\/([^/]+)\\/([^/]+)$/.exec(route))) console.log(JSON.stringify({ permissions: { push: who === m[1] || (m[1] === 'org' && who === 'bob') } }));
  else if ((m = /^users\\/(alice|bob|constructor)$/.exec(route))) console.log(JSON.stringify({ id: ids[m[1]], name: m[1] + (flag('renamed') ? ' updated' : '') + (m[1] === 'constructor' && flag('leaky') ? ' ' + e.GH_TOKEN : '') }));
  else process.exit(8);
} else if (a[0] === 'auth' && a[1] === 'token') {
  if (e.GH_TOKEN || e.GH_HOST || a.join(' ').indexOf('--hostname github.com --user ') < 0) process.exit(9);
  const who = a[a.indexOf('--user') + 1];
  if (!ids[who]) process.exit(1);
  console.log('ghp_fixture_' + who + '_9d3f1c' + (flag('multiline') ? '\\nextra-line' : ''));
} else if (a[0] === 'auth' && a[1] === 'status') {
  if (e.GH_TOKEN || e.GH_HOST) process.exit(9);
  for (const key of ['APPDATA','GH_CONFIG_DIR','XDG_CONFIG_HOME']) if (!e[key]?.startsWith(e.HOME)) process.exit(7);
  if (flag('text') && a.includes('--json')) { process.stderr.write('unknown flag: --json'); process.exit(1); }
  if (!a.includes('--json')) process.stderr.write('github.com\\n  ✓ Logged in to github.com account alice (keyring)\\n  - Active account: false\\n  ✓ Logged in to github.com account bob (keyring)\\n  - Active account: true\\n');
  else console.log(JSON.stringify({hosts:{'github.com':[{state:'success',active:false,host:'github.com',login:'alice',tokenSource:'keyring',gitProtocol:'https'},{state:'success',active:true,host:'github.com',login:'bob',tokenSource:'keyring',gitProtocol:'https'},{state:'success',active:false,host:'github.com',login:'constructor',tokenSource:'keyring',gitProtocol:'https'}]}}));
} else process.exit(8);
`,
  );
  const gh = join(bin, process.platform === "win32" ? "gh.cmd" : "gh");
  writeFileSync(
    gh,
    process.platform === "win32"
      ? ["@echo off", `"${node}" "${fake}" %*`, ""].join("\r\n")
      : [
          "#!/bin/sh",
          `exec '${node.replaceAll("'", "'\\''")}' '${fake.replaceAll("'", "'\\''")}' "$@"`,
          "",
        ].join("\n"),
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
    return { status: out.status, ...(JSON.parse(out.stdout) as Reply) };
  }
  const readAudit = (): Audit[] =>
    readFileSync(join(home, ".forge/accounts/audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Audit);
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
  function emptyClone(name: string, remote: string) {
    const path = join(root, name);
    mkdirSync(path);
    git(path, "init", "-b", "main");
    git(path, "remote", "add", "origin", remote);
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
  return {
    root,
    home,
    bin,
    env,
    node,
    forge,
    run,
    git,
    cli,
    readAudit,
    clone,
    emptyClone,
  };
}

test("installed accounts: one approval catches wrong authors and binds every clone", () => {
  const { root, home, bin, env, run, git, cli, readAudit, clone } = setup();
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
    expect(plan.result.ask).toContain(wrong);
    expect(plan.result.hazards.length).toBeGreaterThanOrEqual(2);
    writeFileSync(join(bin, "text"), "");
    expect(cli(repo, "plan").result.proposal.login).toBe("alice");
    rmSync(join(bin, "text"));
    expect(cli(repo, "use", { login: "alice" }).ok).toBe(false);
    expect(
      cli(repo, "use", { login: "alice", approval: { quote: "yes" } }).ok,
    ).toBe(false);
    const approval = { quote: "yes", source: "t3:fixture/message:1" };
    // The agent chooses use/decline; Forge treats the supplied quote as opaque evidence.
    const opaqueRepo = clone("opaque-reply");
    git(
      opaqueRepo,
      "remote",
      "set-url",
      "origin",
      "https://github.com/alice/opaque-reply.git",
    );
    const opaqueApproval = {
      quote: "  no thanks  ",
      source: "t3:fixture/message:opaque",
    };
    const opaqueUse = cli(opaqueRepo, "use", {
      login: "alice",
      approval: opaqueApproval,
    });
    expect(opaqueUse.ok).toBe(true);
    expect(
      readAudit().find((row) => row.id === opaqueUse.result.appliedFrom)
        ?.approval,
    ).toEqual(opaqueApproval);
    const used = cli(repo, "use", { login: "alice", approval });
    expect(used.ok, JSON.stringify(used)).toBe(true);
    const audit = readAudit();
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
    const second = clone("second");
    expect(cli(second, "decline", { approval }).error.code).toBe(
      "ACCOUNT_BOUND",
    );
    const inherited = cli(second, "plan");
    expect(inherited.ok, JSON.stringify(inherited)).toBe(true);
    expect(inherited.result.appliedFrom).toBe(used.result.appliedFrom);
    expect(inherited.result.ask).not.toContain("Reply");
    expect(git(second, "config", "user.email")).toBe(
      "101+alice@users.noreply.github.com",
    );
    expect(
      cli(second, "use", { login: "alice", approval }).result.appliedFrom,
    ).toBe(used.result.appliedFrom);
    // forge-228: accounts check refuses a push range with another account's email.
    const guarded = clone("guarded");
    git(
      guarded,
      "remote",
      "set-url",
      "origin",
      "https://github.com/alice/guarded.git",
    );
    expect(cli(guarded, "check")).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_UNBOUND" },
    });
    expect(cli(guarded, "use", { login: "alice", approval }).ok).toBe(true);
    git(
      guarded,
      "-c",
      "user.email=202+bob@users.noreply.github.com",
      "commit",
      "--allow-empty",
      "-m",
      "bob author",
    );
    const bobCommit = git(guarded, "rev-parse", "HEAD");
    const authorRefused = cli(guarded, "check");
    expect(authorRefused.ok).toBe(false);
    expect(authorRefused.error.code).toBe("ACCOUNT_COMMIT_IDENTITY");
    for (const part of [
      bobCommit,
      "author",
      "202+bob@users.noreply.github.com",
      "alice",
    ])
      expect(authorRefused.error.message).toContain(part);
    git(
      guarded,
      "commit",
      "--amend",
      "--allow-empty",
      "--reset-author",
      "-C",
      "HEAD",
    );
    expect(git(guarded, "log", "-1", "--format=%ae")).toBe(
      "101+alice@users.noreply.github.com",
    );
    expect(cli(guarded, "check")).toMatchObject({ ok: true });
    expect(cli(guarded, "check", { base: "origin/main", tip: "HEAD" }).ok).toBe(
      true,
    );
    const committerOut = run(
      "git",
      ["commit", "--allow-empty", "-m", "bob committer"],
      guarded,
      { GIT_COMMITTER_EMAIL: "202+bob@users.noreply.github.com" },
    );
    expect(committerOut.status, committerOut.stderr).toBe(0);
    const committerCommit = git(guarded, "rev-parse", "HEAD");
    const committerRefused = cli(guarded, "check");
    expect(committerRefused.ok).toBe(false);
    expect(committerRefused.error.code).toBe("ACCOUNT_COMMIT_IDENTITY");
    expect(committerRefused.error.message).toContain(committerCommit);
    expect(committerRefused.error.message).toContain(
      "202+bob@users.noreply.github.com",
    );
    expect(committerRefused.error.message).toContain("committer");
    expect(committerRefused.error.message).not.toContain("author=");
    expect(
      cli(guarded, "check", { base: committerCommit, tip: "HEAD" }).ok,
    ).toBe(true);
    // A second clone of the same remote inherits the approval and passes.
    git(second, "commit", "--allow-empty", "-m", "second clone work");
    expect(cli(second, "check")).toMatchObject({
      ok: true,
      result: { login: "alice" },
    });
    // Check fails closed whenever it cannot examine every commit or trust the include.
    function boundClone(name: string) {
      const path = clone(name);
      git(
        path,
        "remote",
        "set-url",
        "origin",
        `https://github.com/alice/${name}.git`,
      );
      expect(cli(path, "use", { login: "alice", approval }).ok).toBe(true);
      return path;
    }
    const missingInclude = boundClone("check-missing-include");
    rmSync(join(missingInclude, ".git/forge/accounts.gitconfig"));
    expect(cli(missingInclude, "check")).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_INTEGRITY" },
    });
    const changedInclude = boundClone("check-changed-include");
    writeFileSync(
      join(changedInclude, ".git/forge/accounts.gitconfig"),
      "[user]\nemail=changed@example.test\n",
    );
    expect(cli(changedInclude, "check")).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_INTEGRITY" },
    });
    const redirected = boundClone("check-redirected-include");
    const redirectedConfig = join(redirected, ".git/config");
    const configText = readFileSync(redirectedConfig, "utf8");
    expect(configText).toContain('path = "forge/accounts.gitconfig"');
    writeFileSync(
      redirectedConfig,
      configText.replace(
        'path = "forge/accounts.gitconfig"',
        'path = "elsewhere.gitconfig"',
      ),
    );
    expect(cli(redirected, "check")).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_INTEGRITY" },
    });
    const shallow = boundClone("check-shallow");
    git(shallow, "commit", "--allow-empty", "-m", "below the boundary");
    git(shallow, "commit", "--allow-empty", "-m", "above the boundary");
    writeFileSync(
      join(shallow, ".git/shallow"),
      git(shallow, "rev-parse", "HEAD") + "\n",
    );
    expect(git(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(cli(shallow, "check")).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_SHALLOW_HISTORY" },
    });
    const zeroBase = boundClone("check-zero-base");
    git(
      zeroBase,
      "-c",
      "user.email=202+bob@users.noreply.github.com",
      "commit",
      "--allow-empty",
      "-m",
      "bob on another remote",
    );
    git(zeroBase, "update-ref", "refs/remotes/other/topic", "HEAD");
    expect(cli(zeroBase, "check")).toMatchObject({
      ok: true,
      result: { checked: 0 },
    });
    expect(
      cli(zeroBase, "check", { base: "0".repeat(40), tip: "HEAD" }),
    ).toMatchObject({ ok: false, error: { code: "ACCOUNT_COMMIT_IDENTITY" } });
    const signed = boundClone("check-show-signature");
    git(signed, "commit", "--allow-empty", "-m", "carries a signature header");
    const signedObject = git(signed, "cat-file", "-p", "HEAD").replace(
      /\n\n/,
      "\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\n",
    );
    const written = spawnSync(
      "git",
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      { cwd: signed, env, encoding: "utf8", input: signedObject },
    );
    expect(written.status, written.stderr).toBe(0);
    git(signed, "update-ref", "HEAD", written.stdout.trim());
    git(signed, "config", "log.showSignature", "true");
    expect(cli(signed, "check")).toMatchObject({
      ok: true,
      result: { checked: 1 },
    });
    const grafted = boundClone("check-grafts");
    git(
      grafted,
      "-c",
      "user.email=202+bob@users.noreply.github.com",
      "commit",
      "--allow-empty",
      "-m",
      "bob ancestor",
    );
    git(grafted, "commit", "--allow-empty", "-m", "alice tip");
    mkdirSync(join(grafted, ".git/info"), { recursive: true });
    writeFileSync(
      join(grafted, ".git/info/grafts"),
      git(grafted, "rev-parse", "HEAD") + "\n",
    );
    expect(cli(grafted, "check")).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_GRAFTED_HISTORY" },
    });
    const unborn = join(root, "check-unborn");
    mkdirSync(unborn);
    git(unborn, "init", "-b", "main");
    git(
      unborn,
      "remote",
      "add",
      "origin",
      "https://github.com/alice/check-unborn.git",
    );
    mkdirSync(join(unborn, ".forge"));
    writeFileSync(
      join(unborn, ".forge/config.yaml"),
      JSON.stringify({
        schemaVersion: "forge.config/1",
        blocks: { accounts: { source: { builtin: "forge/accounts" } } },
      }),
    );
    expect(cli(unborn, "use", { login: "alice", approval }).ok).toBe(true);
    expect(cli(unborn, "check")).toMatchObject({
      ok: false,
      error: { code: "INPUT_INVALID" },
    });
    writeFileSync(join(bin, "renamed"), "");
    const renamed = clone("renamed");
    git(
      renamed,
      "remote",
      "set-url",
      "origin",
      "https://github.com/alice/another.git",
    );
    expect(cli(renamed, "use", { login: "alice", approval }).ok).toBe(true);
    expect(cli(repo, "plan").ok).toBe(true);
    const overridden = clone("overridden");
    git(
      overridden,
      "remote",
      "set-url",
      "origin",
      "https://github.com/alice/override.git",
    );
    git(overridden, "config", "extensions.worktreeConfig", "true");
    git(
      overridden,
      "config",
      "--worktree",
      "user.email",
      "202+bob@users.noreply.github.com",
    );
    const refused = cli(overridden, "use", { login: "alice", approval });
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("ACCOUNT_INTEGRITY");
    const authorOverride = clone("author-override");
    git(
      authorOverride,
      "remote",
      "set-url",
      "origin",
      "https://github.com/alice/author-override.git",
    );
    git(
      authorOverride,
      "config",
      "author.email",
      "202+bob@users.noreply.github.com",
    );
    const authorRefusal = cli(authorOverride, "use", {
      login: "alice",
      approval,
    });
    expect({
      ok: authorRefusal.ok,
      code: authorRefusal.error?.code,
      namesAuthorOverride:
        authorRefusal.error?.message.includes("author.email"),
    }).toEqual({
      ok: false,
      code: "ACCOUNT_INTEGRITY",
      namesAuthorOverride: true,
    });
    git(authorOverride, "config", "--unset", "author.email");
    expect(
      cli(
        authorOverride,
        "use",
        { login: "alice", approval },
        {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "author.email",
          GIT_CONFIG_VALUE_0: "202+bob@users.noreply.github.com",
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "ACCOUNT_INTEGRITY" } });
    const inheritedKey = clone("inherited-key");
    git(
      inheritedKey,
      "remote",
      "set-url",
      "origin",
      "https://github.com/constructor/app.git",
    );
    expect(
      cli(inheritedKey, "use", { login: "constructor", approval }).ok,
    ).toBe(true);
    expect(git(inheritedKey, "config", "user.email")).toBe(
      "303+constructor@users.noreply.github.com",
    );
    expect(cli(inheritedKey, "plan").result.proposal.login).toBe("constructor");
    const other = clone("other");
    git(other, "remote", "set-url", "origin", "git@github.com:bob/other.git");
    expect(cli(other, "decline", {}).ok).toBe(false);
    const declineApproval = { ...approval, quote: "no" };
    expect(cli(other, "decline", { approval: declineApproval }).ok).toBe(true);
    expect(
      readAudit().find(
        (row) => row.kind === "decline" && row.repo === "github.com/bob/other",
      )?.approval,
    ).toEqual(declineApproval);
    expect(cli(other, "plan").result.declined).toBe(true);
    const noGh = clone("no-gh");
    git(
      noGh,
      "remote",
      "set-url",
      "origin",
      "https://github.com/alice/no-gh.git",
    );
    const gitOnly = join(home, "git-only");
    mkdirSync(gitOnly);
    const gitPath = Bun.which("git");
    if (!gitPath) throw new Error("Git required");
    const gitWrapper = join(
      gitOnly,
      process.platform === "win32" ? "git.cmd" : "git",
    );
    writeFileSync(
      gitWrapper,
      process.platform === "win32"
        ? ["@echo off", `"${gitPath}" %*`, ""].join("\r\n")
        : [
            "#!/bin/sh",
            `exec '${gitPath.replaceAll("'", "'\\''")}' "$@"`,
            "",
          ].join("\n"),
    );
    chmodSync(gitWrapper, 0o700);
    expect(
      cli(noGh, "decline", { approval: declineApproval }, { PATH: gitOnly }),
    ).toMatchObject({
      ok: true,
      result: { declined: true },
    });
    writeFileSync(
      join(repo, ".git/forge/accounts.gitconfig"),
      "[user]\nemail=changed@example.test\n",
    );
    expect(cli(repo, "plan").error.code).toBe("ACCOUNT_INTEGRITY");
    writeFileSync(join(home, ".forge/accounts/bindings.json"), "[]");
    expect(cli(clone("malformed-bindings"), "plan")).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_INTEGRITY" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

const TOKEN = "ghp_fixture_constructor_9d3f1c";

function plant(
  dir: string,
  node: string,
  spyLog: string,
  names = ["gh", "git"],
) {
  mkdirSync(dir, { recursive: true });
  const spy = join(dir, "spy.cjs");
  writeFileSync(
    spy,
    `require('node:fs').appendFileSync(${JSON.stringify(spyLog)}, process.argv.slice(2).join(' ') + ' ' + JSON.stringify(process.env) + '\\n');`,
  );
  for (const name of names) {
    const file = join(dir, process.platform === "win32" ? `${name}.cmd` : name);
    writeFileSync(
      file,
      process.platform === "win32"
        ? ["@echo off", `"${node}" "${spy}" %*`, ""].join("\r\n")
        : ["#!/bin/sh", `exec '${node}' '${spy}' "$@"`, ""].join("\n"),
    );
    chmodSync(file, 0o700);
  }
}

test("installed accounts: planted gh and git on PATH never run or see the token", () => {
  const { root, node, env, cli, clone } = setup();
  try {
    const repo = clone("spy");
    const planted = join(repo, ".bin");
    const spyLog = join(root, "spy.log");
    plant(planted, node, spyLog);
    const hostile = {
      PATH: planted + delimiter + env.PATH,
      GH_TOKEN: "caller-token-never-forward",
    };
    const approval = { quote: "yes", source: "t3:fixture/message:spy" };
    const plan = cli(repo, "plan", {}, hostile);
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    const used = cli(repo, "use", { login: "alice", approval }, hostile);
    expect(used.ok, JSON.stringify(used)).toBe(true);
    expect(existsSync(spyLog) ? readFileSync(spyLog, "utf8") : "").toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("installed accounts: plan picks the only account that can push and use verifies the login", () => {
  const { root, bin, cli, clone, git } = setup();
  try {
    const repo = clone("org-app");
    git(repo, "remote", "set-url", "origin", "https://github.com/org/app.git");
    const plan = cli(repo, "plan");
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    expect(plan.result.proposal.login).toBe("bob");
    expect(plan.result.reason).toContain("push access");
    const approval = { quote: "yes", source: "t3:fixture/message:push" };
    expect(cli(repo, "use", { login: "bob", approval }).ok).toBe(true);
    const ghost = clone("ghost");
    git(
      ghost,
      "remote",
      "set-url",
      "origin",
      "https://github.com/ghost/app.git",
    );
    const denied = cli(ghost, "plan");
    expect(denied.ok, JSON.stringify(denied)).toBe(true);
    expect(denied.result.hazards.join(" ")).toContain(
      "no signed-in account can push",
    );
    writeFileSync(join(bin, "swapped"), "");
    // A stored binding is only reused when the token still belongs to its login.
    expect(cli(repo, "use", { login: "bob", approval })).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_VERIFY_FAILED" },
    });
    const swapped = clone("swapped");
    git(
      swapped,
      "remote",
      "set-url",
      "origin",
      "https://github.com/alice/swapped.git",
    );
    expect(cli(swapped, "use", { login: "alice", approval })).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_VERIFY_FAILED" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("installed accounts: a non-github.com host fails closed", () => {
  const { root, cli, clone, git } = setup();
  try {
    const repo = clone("enterprise");
    git(
      repo,
      "remote",
      "set-url",
      "origin",
      "https://ghe.example.test/org/app.git",
    );
    const approval = { quote: "yes", source: "t3:fixture/message:ghe" };
    for (const [verb, input] of [
      ["plan", {}],
      ["use", { login: "alice", approval }],
    ] as const)
      expect(
        cli(repo, verb, input, { GH_HOST: "ghe.example.test" }),
      ).toMatchObject({
        ok: false,
        error: { code: "ACCOUNT_HOST_UNSUPPORTED" },
      });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("installed accounts: the token never reaches stdout, stderr, receipts or the audit", () => {
  const { root, home, bin, run, node, forge, clone, git } = setup();
  try {
    writeFileSync(join(bin, "leaky"), "");
    const repo = clone("leaky");
    git(
      repo,
      "remote",
      "set-url",
      "origin",
      "https://github.com/constructor/app.git",
    );
    const approval = { quote: "yes", source: "t3:fixture/message:leak" };
    const outputs = ["plan", "use", "plan"].map((verb) => {
      const out = run(
        node,
        [
          forge,
          "accounts",
          verb,
          "--json",
          "--input",
          JSON.stringify(
            verb === "use" ? { login: "constructor", approval } : {},
          ),
        ],
        repo,
      );
      expect(out.status, out.stdout + out.stderr).toBe(0);
      return out.stdout + out.stderr;
    });
    const files = [home, join(repo, ".git")].flatMap((dir) =>
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .map((name) => join(dir, name))
        .filter((path) => statSync(path).isFile()),
    );
    expect(files.some((path) => path.endsWith("audit.jsonl"))).toBe(true);
    for (const text of [
      ...outputs,
      ...files.map((path) => readFileSync(path, "latin1")),
    ])
      expect(text).not.toContain(TOKEN);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("installed accounts: a gh or git planted in a temp directory never runs during clone discovery", () => {
  const { root, home, node, env, cli, clone } = setup();
  try {
    const repo = clone("temp-spy");
    const planted = join(root, "tmp", "planted");
    const spyLog = join(root, "temp-spy.log");
    plant(planted, node, spyLog);
    const plan = cli(
      repo,
      "plan",
      {},
      {
        PATH: planted + delimiter + env.PATH,
        GH_TOKEN: "caller-token-never-forward",
        GITHUB_TOKEN: "caller-token-never-forward",
        GH_CONFIG_DIR: join(home, "gh"),
      },
    );
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    expect(existsSync(spyLog) ? readFileSync(spyLog, "utf8") : "").toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("installed accounts: a failed API call after the token lookup exposes no token in the error envelope", () => {
  const { root, bin, cli, emptyClone } = setup();
  try {
    const repo = emptyClone("failing", "https://github.com/alice/failing.git");
    const approval = { quote: "yes", source: "t3:fixture/message:fail" };
    for (const padded of [false, true]) {
      writeFileSync(join(bin, "apifail"), "");
      if (padded) writeFileSync(join(bin, "bigerr"), "");
      const out = cli(repo, "use", { login: "alice", approval });
      expect(out.ok).toBe(false);
      expect(out.error.code).toBe("ACCOUNT_UNAVAILABLE");
      expect(JSON.stringify(out)).not.toContain("ghp_");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("installed accounts: gh output is validated strictly before it is trusted", () => {
  const { root, bin, cli, clone, git } = setup();
  try {
    const approval = { quote: "yes", source: "t3:fixture/message:strict" };
    function fresh(name: string) {
      const repo = clone(name);
      git(
        repo,
        "remote",
        "set-url",
        "origin",
        `https://github.com/alice/${name}.git`,
      );
      return repo;
    }
    writeFileSync(join(bin, "multiline"), "");
    expect(
      cli(fresh("multi-line-token"), "use", { login: "alice", approval }),
    ).toMatchObject({ ok: false, error: { code: "ACCOUNT_VERIFY_FAILED" } });
    rmSync(join(bin, "multiline"));
    writeFileSync(join(bin, "emailpage2"), "");
    const partial = cli(fresh("email-page-two"), "use", {
      login: "alice",
      approval,
    });
    expect(partial).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_VERIFY_FAILED" },
    });
    expect(partial.error.message).toContain("email");
    rmSync(join(bin, "emailpage2"));
    writeFileSync(join(bin, "emailscope"), "");
    const degraded = cli(fresh("email-scope"), "use", {
      login: "alice",
      approval,
    });
    expect(degraded.ok, JSON.stringify(degraded)).toBe(true);
    expect((degraded.result as { emails?: string }).emails).toBe(
      "noreply-only",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("installed accounts: a gh planted under a symlinked temp directory never runs", () => {
  if (process.platform === "win32") return;
  const { root, node, env, cli, clone } = setup();
  try {
    const repo = clone("temp-link");
    const real = join(root, "tmp");
    const link = join(root, "tmp-link");
    symlinkSync(real, link, "dir");
    const planted = join(real, "planted-gh");
    const spyLog = join(root, "temp-link.log");
    plant(planted, node, spyLog, ["gh"]);
    const plan = cli(
      repo,
      "plan",
      {},
      {
        PATH: planted + delimiter + env.PATH,
        TMPDIR: link,
        TEMP: link,
        TMP: link,
      },
    );
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    expect(existsSync(spyLog) ? readFileSync(spyLog, "utf8") : "").toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("installed accounts: a gh config planted in the clone has no effect on token-bearing calls", () => {
  const { root, home, cli, clone, git } = setup();
  try {
    const repo = clone("planted-config");
    git(
      repo,
      "remote",
      "set-url",
      "origin",
      "https://github.com/alice/planted-config.git",
    );
    const planted = join(repo, ".git/forge/accounts-gh");
    mkdirSync(planted, { recursive: true });
    writeFileSync(
      join(planted, "config.yml"),
      "http_unix_socket: /tmp/evil.sock\n",
    );
    const approval = { quote: "yes", source: "t3:fixture/message:config" };
    const used = cli(repo, "use", { login: "alice", approval });
    expect(used.ok, JSON.stringify(used)).toBe(true);
    // The fake gh refuses any config directory that is not empty and private to the device root.
    const scratch = join(home, ".forge/accounts/scratch");
    expect(existsSync(scratch) ? readdirSync(scratch) : []).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
