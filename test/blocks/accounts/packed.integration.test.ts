import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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
  ask?: string;
};

let template: string | undefined;
// The shared starting clone: one commit by alice, origin set, accounts block configured.
function baseClone() {
  if (template) return template;
  const dir = mkdtempSync(join(tmpdir(), "forge-accounts-template-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "clone");
  mkdirSync(path);
  const config = join(dir, "gitconfig");
  writeFileSync(config, "");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].toUpperCase().startsWith("GIT_"),
    ),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: config,
    HOME: dir,
    USERPROFILE: dir,
  });
  const git = (...args: string[]) => {
    const out = spawnSync("git", args, {
      cwd: path,
      env,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(out.status, out.stderr).toBe(0);
  };
  git("init", "-b", "main");
  git("remote", "add", "origin", "https://github.com/alice/app.git");
  git(
    "-c",
    "user.name=Alice",
    "-c",
    "user.email=101+alice@users.noreply.github.com",
    "commit",
    "--allow-empty",
    "-m",
    "base",
  );
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  mkdirSync(join(path, ".forge"));
  writeFileSync(
    join(path, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: { accounts: { source: { builtin: "forge/accounts" } } },
    }),
  );
  template = path;
  return path;
}

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
  // Git's own trace2 log lists every git process; a global setting makes each one append a start event.
  const gitTrace = join(home, "git-trace.txt");
  writeFileSync(
    join(home, ".gitconfig"),
    `[trace2]\n\teventTarget = ${gitTrace.replaceAll("\\", "/")}\n`,
  );
  const fake = join(bin, "fake.cjs");
  writeFileSync(
    fake,
    `
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2), e = process.env;
const flag = (name) => fs.existsSync(path.join(__dirname, name));
fs.appendFileSync(path.join(__dirname, 'ghlog.txt'), (a[0] === 'api' && a[1].startsWith('repos/') ? 'api repos/x/y' : a.slice(0, 2).join(' ')) + '\\n');
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
  if (route === 'user') console.log(JSON.stringify({ login: flag('swapped') ? 'mallory' : who, id: ids[who], name: who + (flag('renamed') ? ' updated' : '') + (who === 'constructor' && flag('leaky') ? ' ' + e.GH_TOKEN : '') }));
  else if (route === 'user/emails' && a.includes('--paginate')) {
    if (flag('emailscope')) { fs.writeSync(1, JSON.stringify({ message: 'Not Found', status: '404' }) + '\\n'); process.exit(1); }
    const page = JSON.stringify([{ email: ids[who] + '+' + who + '@users.noreply.github.com', primary: true, verified: true }].concat(flag('emaillisted') ? [{ email: who + '@example.test', primary: false, verified: true }] : []));
    if (flag('emailpage2')) { fs.writeSync(1, page + '\\n'); process.exit(1); }
    console.log(page);
  }
  else if ((m = /^repos\\/([^/]+)\\/([^/]+)$/.exec(route))) console.log(JSON.stringify({ permissions: { push: who === m[1] || (m[1] === 'org' && who === 'bob') } }));
  else process.exit(8);
} else if (a[0] === 'auth' && a[1] === 'token') {
  if (e.GH_TOKEN || e.GH_HOST || a.join(' ').indexOf('--hostname github.com --user ') < 0) process.exit(9);
  const who = a[a.indexOf('--user') + 1];
  if (!ids[who] || flag('signedout')) process.exit(1);
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
    const started = performance.now();
    const out = spawnSync(command, args, {
      cwd,
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    });
    // A child that timed out keeps what it printed; show it with how long it ran.
    expect(
      out.error,
      `${command} ${args.join(" ")} ran ${Math.round(performance.now() - started)} ms: status=${out.status} signal=${out.signal}
stdout: ${out.stdout}
stderr: ${out.stderr}`,
    ).toBeUndefined();
    return out;
  }
  // Each fake gh call appends one line, so tests can count the gh processes Forge starts.
  function ghCalls() {
    const log = join(bin, "ghlog.txt");
    const counts: Record<string, number> = {};
    for (const line of (existsSync(log) ? readFileSync(log, "utf8") : "")
      .split(/\r?\n/)
      .filter(Boolean))
      counts[line] = (counts[line] ?? 0) + 1;
    return counts;
  }
  // The accounts block starts its git processes with -c core.fsmonitor=false, except `git var`; Forge's own git calls carry neither.
  function gitCalls() {
    const counts: Record<string, number> = {};
    for (const line of (existsSync(gitTrace)
      ? readFileSync(gitTrace, "utf8")
      : ""
    )
      .split(/\r?\n/)
      .filter(Boolean)) {
      const event = JSON.parse(line) as { event: string; argv?: string[] };
      const argv = event.argv?.slice(1) ?? [];
      if (event.event !== "start") continue;
      // The identity probes run `git var` with the caller's environment and carry no -c flag.
      const owned = argv[1] === "core.fsmonitor=false";
      if (!owned && argv[0] !== "var") continue;
      const verb = owned
        ? (argv.slice(2).find((arg) => !arg.startsWith("-")) ?? "")
        : "var";
      counts[verb] = (counts[verb] ?? 0) + 1;
    }
    return counts;
  }
  function resetCalls() {
    for (const file of [gitTrace, join(bin, "ghlog.txt")])
      if (existsSync(file)) rmSync(file);
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
    // Report the child's own failure before parsing, so a dead or killed call is not a JSON error.
    expect(
      out.stdout,
      `forge accounts ${verb} printed nothing: status=${out.status} signal=${out.signal} stderr=${out.stderr}`,
    ).not.toBe("");
    return { status: out.status, ...(JSON.parse(out.stdout) as Reply) };
  }
  const readAudit = (): Audit[] =>
    readFileSync(join(home, ".forge/accounts/audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Audit);
  // Every test gets its own fresh copy of one clone built once per file: five git starts each otherwise.
  function clone(name: string) {
    const path = join(root, name);
    cpSync(baseClone(), path, { recursive: true });
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
    ghCalls,
    gitCalls,
    resetCalls,
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
    // A noreply-only account never reads the email list, so a broken list cannot block it.
    writeFileSync(join(bin, "emailscope"), "");
    const noreply = cli(fresh("email-scope"), "use", {
      login: "alice",
      approval,
    });
    expect(noreply.ok, JSON.stringify(noreply)).toBe(true);
    expect((noreply.result as { emails?: string }).emails).toBe("noreply-only");
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

test("installed accounts: use with a named login starts one token lookup and one api user call", () => {
  const { root, cli, clone, ghCalls } = setup();
  try {
    const repo = clone("few-gh-calls");
    const approval = { quote: "yes", source: "t3:fixture/message:calls" };
    const used = cli(repo, "use", { login: "alice", approval });
    expect(used.ok, JSON.stringify(used)).toBe(true);
    // Each gh process is a cmd.exe and node start on Windows, so the count is the user-facing cost.
    // One api user call proves the token's login and id and supplies the name; the generated
    // noreply address needs no email listing, and a named login needs no account listing.
    expect(ghCalls()).toEqual({ "auth token": 1, "api user": 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("installed accounts: plan, use and check on a bound clone start only the processes their checks need", () => {
  const { root, cli, clone, git, ghCalls, gitCalls, resetCalls } = setup();
  try {
    const approval = { quote: "yes", source: "t3:fixture/message:counts" };
    const first = clone("counts-first");
    // Unbound plan on a remote a signed-in account owns: one account listing; the owner is the pick, so no token or permission lookups.
    resetCalls();
    expect(cli(first, "plan").ok).toBe(true);
    expect(ghCalls()).toEqual({ "auth status": 1 });
    // The origin url, the unpushed commits, the git identities and the recent authors; no common-dir lookup for a github.com origin.
    expect(gitCalls()).toEqual({ remote: 1, log: 2, config: 1 });
    // No signed-in account owns this remote: a token lookup and a permission lookup per signed-in account.
    const ghost = clone("counts-ghost");
    git(
      ghost,
      "remote",
      "set-url",
      "origin",
      "https://github.com/ghost/app.git",
    );
    resetCalls();
    expect(cli(ghost, "plan").ok).toBe(true);
    expect(ghCalls()).toEqual({
      "auth status": 1,
      "auth token": 3,
      "api repos/x/y": 3,
    });
    // Unbound use with a named login: the token proof alone. The token lookup shows the login is signed
    // in, so no account listing; the email listing is only for a custom commit email.
    resetCalls();
    expect(cli(first, "use", { login: "alice", approval }).ok).toBe(true);
    expect(ghCalls()).toEqual({ "auth token": 1, "api user": 1 });
    // The git reads still feed the unpushed-commit and email hazards: the origin url, the unpushed commits,
    // the identities and the recent authors, the identity check, and the two `git var` probes.
    expect(gitCalls()).toEqual({ remote: 1, log: 2, config: 2, var: 2 });
    const second = clone("counts-second");
    // Bound plan: one account listing and no token or permission lookups.
    resetCalls();
    expect(cli(second, "plan").ok).toBe(true);
    expect(ghCalls()).toEqual({ "auth status": 1 });
    // The second config call is the identity check: one read of name, email and useConfigOnly.
    expect(gitCalls()).toEqual({ remote: 1, log: 2, config: 2, var: 2 });
    // Bound use: the token proof and the one identity read; the account listing and the git discovery only feed a question it never asks.
    resetCalls();
    expect(cli(second, "use", { login: "alice", approval }).ok).toBe(true);
    expect(ghCalls()).toEqual({ "auth token": 1, "api user": 1 });
    expect(gitCalls()).toEqual({ remote: 1, config: 1, var: 2 });
    // Check never calls gh: the origin url, the shallow and tip lookup in one call, and the log.
    resetCalls();
    const checked = cli(second, "check");
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    expect(ghCalls()).toEqual({});
    expect(gitCalls()).toEqual({ remote: 1, "rev-parse": 1, log: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("installed accounts: a clone cannot spoof the approved identity with an empty useConfigOnly or a multi-line name", () => {
  const { root, cli, clone, git } = setup();
  try {
    const approval = { quote: "yes", source: "t3:fixture/message:spoof" };
    expect(
      cli(clone("spoof-first"), "use", { login: "alice", approval }).ok,
    ).toBe(true);
    // An empty value is false to git; it must not read as a bare key (true).
    const empty = clone("spoof-empty");
    expect(cli(empty, "use", { login: "alice", approval }).ok).toBe(true);
    git(empty, "config", "user.useConfigOnly", "");
    expect(cli(empty, "use", { login: "alice", approval })).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_INTEGRITY" },
    });
    // A name holding a newline must not pass for a second user.name entry that equals the approved name.
    const multi = clone("spoof-multi-line");
    expect(cli(multi, "use", { login: "alice", approval }).ok).toBe(true);
    git(multi, "config", "user.name", "Evil\nuser.name alice");
    expect(cli(multi, "use", { login: "alice", approval })).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_INTEGRITY" },
    });
    // Git reads any nonzero integer as true and 0 as false.
    const numeric = clone("spoof-numeric");
    expect(cli(numeric, "use", { login: "alice", approval }).ok).toBe(true);
    git(numeric, "config", "user.useConfigOnly", "2");
    expect(cli(numeric, "use", { login: "alice", approval }).ok).toBe(true);
    git(numeric, "config", "user.useConfigOnly", "0");
    expect(cli(numeric, "use", { login: "alice", approval })).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_INTEGRITY" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("installed accounts: a bound use refuses when the bound login is signed out of gh", () => {
  const { root, bin, cli, clone } = setup();
  try {
    const approval = { quote: "yes", source: "t3:fixture/message:signedout" };
    expect(
      cli(clone("signedout-first"), "use", { login: "alice", approval }).ok,
    ).toBe(true);
    // The bound path skips the account listing; the failed token lookup still refuses.
    writeFileSync(join(bin, "signedout"), "");
    expect(
      cli(clone("signedout-second"), "use", { login: "alice", approval }),
    ).toMatchObject({ ok: false, error: { code: "ACCOUNT_VERIFY_FAILED" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("installed accounts: use with a login gh holds no token for refuses before it binds anything", () => {
  const { root, cli, clone } = setup();
  try {
    const approval = { quote: "yes", source: "t3:fixture/message:unknown" };
    // The token lookup is the only proof that the login is signed in; it needs no account listing.
    expect(
      cli(clone("no-token"), "use", { login: "carol", approval }),
    ).toMatchObject({ ok: false, error: { code: "ACCOUNT_VERIFY_FAILED" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("installed accounts: a custom commit email is bound only when GitHub lists it", () => {
  const { root, home, bin, cli, clone } = setup();
  try {
    const approval = { quote: "yes", source: "t3:fixture/message:custom" };
    expect(
      cli(clone("custom-first"), "use", { login: "alice", approval }).ok,
    ).toBe(true);
    // Give the stored account a second commit email, as a hand-edited accounts file would.
    const dir = join(home, ".forge/accounts");
    const accounts = JSON.parse(
      readFileSync(join(dir, "accounts.json"), "utf8"),
    ) as Record<string, { commitEmails: string[] }>;
    accounts.alice!.commitEmails.push("alice@example.test");
    writeFileSync(join(dir, "accounts.json"), JSON.stringify(accounts));
    writeFileSync(join(dir, "bindings.json"), "{}");
    const unlisted = cli(clone("custom-unlisted"), "use", {
      login: "alice",
      approval,
    });
    expect(unlisted).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_VERIFY_FAILED" },
    });
    expect(unlisted.error.message).toContain("alice@example.test");
    writeFileSync(join(bin, "emailpage2"), "");
    const partial = cli(clone("custom-page-two"), "use", {
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
    const scoped = cli(clone("custom-scope"), "use", {
      login: "alice",
      approval,
    });
    expect(scoped).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_VERIFY_FAILED" },
    });
    expect(scoped.error.message).toContain("user:email");
    rmSync(join(bin, "emailscope"));
    writeFileSync(join(bin, "emaillisted"), "");
    const listed = cli(clone("custom-listed"), "use", {
      login: "alice",
      approval,
    });
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    expect((listed.result as { emails?: string }).emails).toBe("listed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("installed accounts: a named-login use still records the unpushed-commit and email hazards", () => {
  const { root, cli, clone, git, readAudit } = setup();
  try {
    const repo = clone("named-hazards");
    git(repo, "config", "user.email", "202+bob@users.noreply.github.com");
    git(repo, "-c", "user.name=Bob", "commit", "--allow-empty", "-m", "wrong");
    const wrong = git(repo, "rev-parse", "HEAD");
    const approval = { quote: "yes", source: "t3:fixture/message:hazards" };
    const used = cli(repo, "use", { login: "alice", approval });
    expect(used.ok, JSON.stringify(used)).toBe(true);
    const ask = readAudit().find(
      (row) => row.id === used.result.appliedFrom,
    )?.ask;
    expect(ask).toContain(wrong);
    expect(ask).toContain("unpushed");
    expect(ask).toContain("202+bob@users.noreply.github.com");
    // Only gh's account listing is skipped, so no active-account hazard is computed.
    expect(ask).not.toContain("signed in as");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

type ApplySnapshot = Record<string, string>;
// One real `forge accounts use` builds the fixture for the whole file (17 tests used to run one
// each); every test ends by restoring the copy of what the call left behind.
let interrupted: ReturnType<typeof buildInterruptedApply> | undefined;
let setupUses = 0;
afterAll(() => {
  if (interrupted) rmSync(interrupted.root, { recursive: true, force: true });
});
// Makes `to` hold the files of `from`. Files that exist are overwritten in place and directories
// are never replaced: on Windows the device files carry a private ACL that a fresh copy would lose.
function syncDirectory(from: string, to: string, keep = new Set<string>()) {
  const wanted = new Set(readdirSync(from));
  for (const name of readdirSync(to))
    if (!wanted.has(name) && !keep.has(name))
      rmSync(join(to, name), { recursive: true, force: true });
  for (const name of wanted) {
    const target = join(to, name);
    if (statSync(join(from, name)).isDirectory()) {
      mkdirSync(target, { recursive: true });
      syncDirectory(join(from, name), target);
    } else writeFileSync(target, readFileSync(join(from, name)));
  }
}
function interruptedApply() {
  interrupted ??= buildInterruptedApply();
  return interrupted;
}
function buildInterruptedApply() {
  const fixture = setup();
  const { root, home, cli, clone } = fixture;
  const repo = clone("uninterrupted");
  const approval = { quote: "yes", source: "t3:fixture/message:recovery" };
  setupUses += 1;
  expect(cli(repo, "use", { login: "alice", approval }).ok).toBe(true);
  // Everything in the home except the fake gh and git programs, which tests never change and
  // which are not copied back, so the files that run stay the ones already scanned.
  const saved = join(root, "saved-home");
  const mutable = () => readdirSync(home).filter((name) => name !== "bin");
  for (const name of mutable())
    cpSync(join(home, name), join(saved, name), { recursive: true });
  const staged: string[] = [];
  const stagedClone = (name: string) => {
    staged.push(name);
    return clone(name);
  };
  function restore() {
    for (const name of staged.splice(0))
      rmSync(join(root, name), { recursive: true, force: true });
    syncDirectory(saved, home, new Set(["bin"]));
  }
  const paths = [
    "forge/accounts.gitconfig",
    "forge/accounts.applied.json",
    "config",
  ];
  const complete: ApplySnapshot = Object.fromEntries(
    paths.map((path) => [path, readFileSync(join(repo, ".git", path), "utf8")]),
  );
  const device = join(home, ".forge/accounts");
  const bindings = readFileSync(join(device, "bindings.json"), "utf8");
  const approvedAudit =
    readFileSync(join(device, "audit.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line && (JSON.parse(line) as Audit).kind !== "apply")
      .join("\n") + "\n";
  function stage(name: string, count: number) {
    writeFileSync(join(device, "bindings.json"), bindings);
    writeFileSync(join(device, "audit.jsonl"), approvedAudit);
    const path = stagedClone(name);
    mkdirSync(join(path, ".git/forge"), { recursive: true });
    for (const file of paths.slice(0, count))
      writeFileSync(join(path, ".git", file), complete[file]!);
    return path;
  }
  function snapshot(path: string) {
    return [
      ...paths.map((file) => join(path, ".git", file)),
      ...["accounts.json", "bindings.json", "audit.jsonl"].map((file) =>
        join(device, file),
      ),
    ].map((file) => (existsSync(file) ? readFileSync(file, "utf8") : null));
  }
  return {
    ...fixture,
    clone: stagedClone,
    restore,
    approval,
    paths,
    complete,
    device,
    stage,
    snapshot,
  };
}

for (const count of [1, 2, 3]) {
  for (const verb of ["check", "plan", "use"]) {
    test(`installed accounts: ${verb} handles interrupted apply after write ${count}`, () => {
      const f = interruptedApply();
      try {
        const repo = f.stage("interrupted", count);
        const input =
          verb === "use" ? { login: "alice", approval: f.approval } : {};
        if (verb === "check" && count < 3) {
          const before = f.snapshot(repo);
          expect(f.cli(repo, "check")).toMatchObject({
            ok: false,
            status: "FAIL",
            error: {
              code: "ACCOUNT_INTEGRITY",
              message:
                "Owned include has no matching device binding or clone record",
              repair: "Run forge accounts plan to finish the interrupted apply",
            },
          });
          expect(f.snapshot(repo)).toEqual(before);
        }
        const recovered = f.cli(repo, verb === "check" ? "plan" : verb, input);
        expect(recovered, JSON.stringify(recovered)).toMatchObject({
          ok: true,
          status: "OK",
        });
        for (const path of f.paths)
          expect(readFileSync(join(repo, ".git", path), "utf8")).toBe(
            f.complete[path]!,
          );
        expect(
          f.readAudit().filter((row) => row.kind === "apply"),
        ).toHaveLength(count === 3 ? 0 : 1);
        const after = f.snapshot(repo);
        expect(f.cli(repo, verb, input).ok).toBe(true);
        expect(f.snapshot(repo)).toEqual(after);
      } finally {
        f.restore();
      }
    }, 120_000);
  }
}

for (const kind of [
  "changed include",
  "unowned include",
  "edited record",
  "record only",
  "no binding",
  "declined binding",
  "different config include",
  "config only",
]) {
  test(`installed accounts: interrupted apply refuses ${kind} without changing files`, () => {
    const f = interruptedApply();
    try {
      const repo = f.stage("refused", kind === "edited record" ? 2 : 1);
      const owned = join(repo, ".git/forge/accounts.gitconfig");
      const applied = join(repo, ".git/forge/accounts.applied.json");
      const config = join(repo, ".git/config");
      if (kind === "changed include")
        writeFileSync(owned, f.complete[f.paths[0]!]! + "x");
      if (kind === "unowned include")
        writeFileSync(owned, "[user]\nname = other\n");
      if (kind === "edited record")
        writeFileSync(
          applied,
          f.complete[f.paths[1]!]!.replace(
            '"includeHash":"',
            '"includeHash":"x',
          ),
        );
      if (kind === "record only") {
        rmSync(owned);
        writeFileSync(applied, f.complete[f.paths[1]!]!);
      }
      if (kind === "no binding" || kind === "declined binding")
        writeFileSync(
          join(f.device, "bindings.json"),
          kind === "no binding"
            ? "{}"
            : JSON.stringify({
                "github.com/alice/app": {
                  declined: true,
                  appliedFrom: "declined",
                },
              }),
        );
      if (kind === "different config include")
        writeFileSync(
          config,
          f.complete.config!.replace(
            'path = "forge/accounts.gitconfig"',
            'path = "elsewhere.gitconfig"',
          ),
        );
      if (kind === "config only") {
        rmSync(owned);
        writeFileSync(config, f.complete.config!);
      }
      const before = f.snapshot(repo);
      for (const verb of ["check", "plan", "use"]) {
        const result = f.cli(
          repo,
          verb,
          verb === "use" ? { login: "alice", approval: f.approval } : {},
        );
        expect(result).toMatchObject({
          status: "FAIL",
          ok: false,
          error: {
            code: "ACCOUNT_INTEGRITY",
            message:
              "Owned include has no matching device binding or clone record",
          },
        });
        expect(f.snapshot(repo)).toEqual(before);
        expect(result.error).not.toHaveProperty("repair");
      }
    } finally {
      f.restore();
    }
  }, 120_000);
}

for (const owner of ["dead", "live device", "live clone"]) {
  test(`installed accounts: interrupted apply handles ${owner} lock owners`, () => {
    const f = interruptedApply();
    try {
      const repo = f.stage("locked", 1);
      const exited = f.run(f.node, ["-e", "process.exit(0)"], repo);
      expect(exited.status).toBe(0);
      const locks = [
        join(f.device, "lock"),
        join(repo, ".git/forge/accounts.apply.lock"),
      ];
      const markers = locks.map((path, i) => {
        const pid =
          owner === (i === 0 ? "live device" : "live clone")
            ? process.pid
            : exited.pid;
        const marker = `owner-${pid}-00000000-0000-4000-8000-000000000000`;
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(join(path, marker), "{}", { mode: 0o600 });
        return marker;
      });
      const before = f.snapshot(repo);
      const result = f.cli(repo, "plan");
      expect(result.ok, JSON.stringify(result)).toBe(owner === "dead");
      if (owner === "dead") {
        for (const path of f.paths)
          expect(readFileSync(join(repo, ".git", path), "utf8")).toBe(
            f.complete[path]!,
          );
        expect(
          f.readAudit().filter((row) => row.kind === "apply"),
        ).toHaveLength(1);
        expect(f.cli(repo, "check").ok).toBe(true);
        for (const lock of locks) expect(existsSync(lock)).toBe(false);
      } else {
        expect(f.snapshot(repo)).toEqual(before);
        const i = owner === "live device" ? 0 : 1;
        expect(readdirSync(locks[i]!)).toEqual([markers[i]!]);
      }
    } finally {
      f.restore();
    }
  }, 120_000);
}

test("installed accounts: another clone's apply audit does not suppress recovery", () => {
  const f = interruptedApply();
  try {
    const repo = f.stage("interrupted", 1);
    expect(f.cli(f.clone("completed-other"), "plan").ok).toBe(true);
    expect(f.readAudit().filter((row) => row.kind === "apply")).toHaveLength(1);
    expect(f.cli(repo, "plan").ok).toBe(true);
    expect(f.readAudit().filter((row) => row.kind === "apply")).toHaveLength(2);
  } finally {
    f.restore();
  }
}, 120_000);

test("installed accounts: the interrupted-apply fixture ran one real use for the whole file", () => {
  expect(setupUses).toBeLessThanOrEqual(1);
}, 1000);
