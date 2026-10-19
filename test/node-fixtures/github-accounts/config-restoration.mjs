import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { createAssemblyProviders } from "../../../src/assembly/providers.ts";

const temporary = realpathSync.native(
  mkdtempSync(join(tmpdir(), "forge-config-restoration-")),
);
const root = join(temporary, "clone"),
  configFile = join(root, ".git/config");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      value !== undefined &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      !/^GIT_/i.test(key) &&
      !/^(?:GH|GITHUB)_/i.test(key),
  ),
);
Object.assign(env, {
  HOME: temporary,
  USERPROFILE: temporary,
  GIT_CONFIG_GLOBAL: join(temporary, "global"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
});
const leases = [];
function git(...args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 1048576,
  });
  assert.equal(
    result.status,
    0,
    `git ${args[0]}: ${result.error?.message ?? ""} ${result.stderr}`,
  );
  return result.stdout.replace(/\r?\n$/, "");
}
const module = { exports: {} };
runInNewContext(
  stripTypeScriptTypes(
    readFileSync(
      new URL("../../../src/blocks/github-accounts/entry.cts", import.meta.url),
      "utf8",
    ),
  ),
  {
    module,
    fail(code, message) {
      throw Object.assign(new Error(message), { code });
    },
  },
);
try {
  mkdirSync(root);
  git("init");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  git("commit", "--allow-empty", "-m", "fixture");
  const include = join(temporary, "included.config");
  const conditional = join(temporary, "conditional.config");
  writeFileSync(
    include,
    '[credential "https://github.com"]\n\thelper = included-helper\n',
  );
  writeFileSync(
    conditional,
    '[credential "https://github.com"]\n\thelper = conditional-helper\n',
  );
  const quote = (value) => JSON.stringify(value.replace(/\\/g, "/"));
  appendFileSync(
    configFile,
    `\n# Native settings retain their exact order and formatting.\n[credential "https://github.com"]\n\thelper =\n\thelper = native-one\n\thelper = native-two\n[user]\n\tname = Original One\n\tname = Original Two\n\temail = original@example.com\n[core]\n\thooksPath = native-hooks\n[include]\n\tpath = ${quote(include)}\n[includeIf "gitdir/i:${root.replace(/\\/g, "/")}/.git"]\n\tpath = ${quote(conditional)}\n[credential "https://github.com"]\n\thelper = native-tail\n`,
  );
  const original = readFileSync(configFile, "utf8");
  const helpers = git(
    "config",
    "--includes",
    "--null",
    "--get-all",
    "credential.https://github.com.helper",
  );
  assert.deepEqual(
    helpers.split("\0").slice(0, -1),
    [
      "",
      "native-one",
      "native-two",
      "included-helper",
      "conditional-helper",
      "native-tail",
    ],
    "fixture must exercise reset, multivalue helpers and both includes in order",
  );
  const gitBase = dirname(dirname(dirname(git("--exec-path"))));
  const shellProgram =
    process.platform === "win32"
      ? [join(gitBase, "usr/bin/sh.exe"), join(gitBase, "bin/bash.exe")].find(
          existsSync,
        )
      : "/bin/sh";
  assert.ok(shellProgram);
  const config = {
    environmentNames: Object.keys(env),
    gitProgram: "git",
    ghProgram: process.execPath,
    ghArgs: [],
    commandTimeoutMs: 10000,
    maxOutputBytes: 65536,
    maxFileBytes: 1048576,
    maxCommits: 100,
    coauthorPolicy: "allow",
    aiCoauthorPatterns: [],
    forgeCommand: [process.execPath],
    shellProgram,
    envProgram:
      process.platform === "win32"
        ? join(dirname(shellProgram), "env.exe")
        : "/usr/bin/env",
    allowedGhCommands: ["repo view"],
    identityName: "profile",
    identityEmail: "noreply",
  };
  const scope = {
    op: "github-account.bind",
    effects: [
      "external:process",
      "files:read",
      "files:write",
      "environment:read",
    ],
    signal: new AbortController().signal,
    deadline: Date.now() + 60000,
    processContainment: "supervised",
  };
  const providers = createAssemblyProviders(root, { env });
  const files = await providers.openFiles(scope);
  leases.push(files);
  const repository = await providers.repository(scope);
  leases.push(repository);
  const account = await providers.account(scope);
  leases.push(account);
  const services = {
    files: files.value,
    repository: repository.value,
    account: {
      ...account.value,
      async run(program, args) {
        let stdout;
        if (args[0] === "auth")
          stdout = Buffer.from("fixture-credential").toString("base64url");
        else if (args[0] === "api" && args[1] === "user")
          stdout = JSON.stringify({
            login: "fixture",
            id: 201,
            name: "Fixture",
          });
        else if (args[0] === "api" && args[1] === "user/emails")
          stdout = JSON.stringify([
            { email: "fixture@example.com", verified: true },
          ]);
        else if (args[0] === "repo" && args[1] === "view")
          stdout = JSON.stringify({ nameWithOwner: "fixture/repo" });
        else throw new Error("unexpected account fixture operation");
        return {
          exitCode: 0,
          signal: null,
          stdout,
          stderr: "",
          timedOut: false,
          truncated: false,
          durationMs: 0,
        };
      },
    },
    process: providers.process(scope),
    environment: providers.environment(scope),
    crypto: providers.crypto(scope),
  };
  async function call(operation, input) {
    return module.exports[`github-account.${operation}`]({
      input,
      services,
      config,
    });
  }
  await call("bind", {
    login: "fixture",
    auto: true,
    repository: "fixture/repo",
  });
  const boundConfig = readFileSync(configFile, "utf8");
  const tampered = boundConfig.replace(
    "201+fixture@users.noreply.github.com",
    "tampered@example.com",
  );
  assert.notEqual(
    tampered,
    boundConfig,
    "fixture must alter the owned identity",
  );
  const managed = join(root, ".git/.forge-github-accounts");
  const preserved = ["metadata.json", "bin/gh", "credential-helper"].map(
    (path) => [path, readFileSync(join(managed, path), "utf8")],
  );
  writeFileSync(configFile, tampered);
  await assert.rejects(
    call("unbind", {}),
    { code: "INPUT_CONFLICT" },
    "tampered owned configuration must refuse unbinding",
  );
  assert.equal(
    readFileSync(configFile, "utf8"),
    tampered,
    "refused unbind must preserve the edited config",
  );
  for (const [path, text] of preserved)
    assert.equal(
      readFileSync(join(managed, path), "utf8"),
      text,
      "refused unbind must preserve owned metadata and scripts",
    );
  writeFileSync(configFile, boundConfig);
  const foreign =
    "\n# Independent user edit after account binding.\n[fixture]\n\tforeign = preserved\n";
  appendFileSync(configFile, foreign);
  assert.equal((await call("unbind", {})).unbound, true);
  assert.equal(
    git(
      "config",
      "--includes",
      "--null",
      "--get-all",
      "credential.https://github.com.helper",
    ),
    helpers,
    "unbind must restore helper order across include and includeIf boundaries",
  );
  assert.equal(
    readFileSync(configFile, "utf8").slice(0, -foreign.length),
    original,
    "unbind must restore exact native configuration bytes, including identity and hook positions",
  );
  assert.equal(
    readFileSync(configFile, "utf8"),
    original + foreign,
    "unbind must retain unrelated edits without moving native settings",
  );
  assert.equal(
    readFileSync(include, "utf8"),
    '[credential "https://github.com"]\n\thelper = included-helper\n',
  );
  assert.equal(
    readFileSync(conditional, "utf8"),
    '[credential "https://github.com"]\n\thelper = conditional-helper\n',
  );
  console.log("PASS config-restoration");
} finally {
  const closed = await Promise.allSettled(leases.map((lease) => lease.close()));
  rmSync(temporary, { recursive: true, force: true });
  assert.equal(
    closed.filter((result) => result.status === "rejected").length,
    0,
    "all service leases must close",
  );
}
