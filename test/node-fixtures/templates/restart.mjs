// The installed delivery workflow survives a new Node process and a new session.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.versions.bun, undefined);
const self = fileURLToPath(import.meta.url);

// Both the PATH shim and direct fake writes use this entry point. Invoking the
// entry point with Node also works on Windows, where spawn cannot execute .cmd.
if (process.argv[2] === "--gh") {
  const args = process.argv.slice(3);
  appendFileSync(join(".fake", "gh-calls.jsonl"), `${JSON.stringify(args)}\n`);
  process.argv = [process.execPath, self, ...args];
  await import(
    args[0] === "pr" && ["create", "merge"].includes(args[1])
      ? "../first-run/gh.mjs"
      : "../../integration/pr-state/gh.mjs"
  );
} else {
  const installed = resolve(process.argv[2]);
  const root = resolve(process.argv[3]);
  const phase = process.argv[4];
  const fake = join(root, ".fake");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|COMSPEC)$/i.test(
        name,
      ),
    ),
  );
  env.PATH = [fake, process.env.PATH ?? process.env.Path ?? ""].join(delimiter);
  env.FORGE_DEVICE_ROOT = join(root, ".device");
  if (phase) env.FORGE_SESSION = phase;

  function run(executable, args, expected = 0, timeout = 60_000) {
    const result = spawnSync(executable, args, {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout,
    });
    assert.equal(
      result.status,
      expected,
      `${executable} ${args.join(" ")}: ${result.error?.message ?? result.signal ?? "exit"}\n${result.stdout}\n${result.stderr}`,
    );
    return result.stdout;
  }
  const cli = (args, expected = 0) =>
    JSON.parse(
      run(
        process.execPath,
        [join(installed, "dist/bin/forge.js"), ...args],
        expected,
      ),
    );
  const input = (noun, verb, value) =>
    cli([noun, verb, "--input", JSON.stringify(value)]).result;
  const git = (...args) =>
    run("git", [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ]).trim();
  function commit(message) {
    git("add", "--all");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  }
  const gh = (...args) => run(process.execPath, [self, "--gh", ...args]).trim();

  if (!phase) {
    mkdirSync(fake);
    if (process.platform === "win32") {
      writeFileSync(
        join(fake, "gh.cmd"),
        `@"${process.execPath}" "${self}" --gh %*\r\n`,
      );
    } else {
      const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
      writeFileSync(
        join(fake, "gh"),
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(self)} --gh "$@"\n`,
      );
      chmodSync(join(fake, "gh"), 0o755);
    }
    // No phase output is read or passed on: only the project path survives.
    run(process.execPath, [self, installed, root, "a"], 0, 180_000);
    process.stdout.write(
      run(process.execPath, [self, installed, root, "b"], 0, 180_000),
    );
  } else if (phase === "a") {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "restart",
        version: "1.0.0",
        private: true,
        scripts: { test: "node test.js" },
      }),
    );
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
    writeFileSync(join(root, ".gitignore"), ".device/\n.fake/\nfixture.json\n");
    writeFileSync(
      join(root, "test.js"),
      'const { add } = require("./add.js");\nif (add(2, 2) !== 4) process.exit(1);\n',
    );
    writeFileSync(join(root, "add.js"), "exports.add = (a, b) => a - b;\n");
    writeFileSync(join(root, "fixture.json"), "{}");
    git("init", "-q");
    commit("fixture");
    assert.equal(
      cli(["template", "import", "delivery"]).result.template,
      "harsha/delivery@0.1.2",
    );
    const synced = cli(["skills", "sync"]).result;
    for (const skill of [
      "forge-intake",
      "forge-cut",
      "forge-build",
      "forge-review",
      "forge-land",
      "forge-loop",
    ])
      assert.ok(synced.written.includes(`.agents/skills/${skill}/SKILL.md`));
    commit("chore: import delivery template");

    const intent = input("issue", "create", {
      title: "Restart intent",
      kind: "task",
    });
    const intake = input("issue", "call", { id: intent.id, role: "intake" });
    assert.equal(intake.call, 1);
    assert.equal(intake.timeboxMinutes, 45);
    const slice = input("issue", "create", {
      title: "Fix add after restart",
      kind: "bug",
      parent: intent.id,
    });
    cli(["issue", "claim", slice.id]);
    const build = input("issue", "call", { id: slice.id, role: "build" });
    assert.equal(build.id, intent.id);
    assert.equal(build.call, 2);
    const red = cli(["check", "run"], 1).result;
    assert.equal(red.status, "FAIL");
    writeFileSync(join(root, "add.js"), "exports.add = (a, b) => a + b;\n");
    const head = commit("fix: add adds");
    const green = cli(["check", "run"]).result;
    assert.equal(green.status, "PASS");
    assert.equal(green.subject, head);
    const url = gh("pr", "create", "--title", "Fix add after restart");
    const number = Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
    assert.ok(Number.isInteger(number) && number > 0);
    writeFileSync(
      join(root, "fixture.json"),
      JSON.stringify({ pr: number, head, url }),
    );
    input("issue", "link", { id: slice.id, relation: "delivers", url });
    input("issue", "comment", {
      id: slice.id,
      body: `checkpoint: pr ${url} head ${head} receipt ${green.id}`,
    });
    cli(["issue", "release", slice.id]);
  } else if (phase === "b") {
    const items = cli(["issue", "list"]).result.items;
    assert.equal(items.length, 2);
    const intent = items.find((item) => item.title === "Restart intent");
    const slice = items.find((item) => item.title === "Fix add after restart");
    assert.ok(intent);
    assert.ok(slice);
    assert.equal(cli(["issue", "show", slice.id]).result.parent, intent.id);
    const calls = cli(["issue", "comments", intent.id]).result.records.filter(
      (record) => typeof record.value.call === "number",
    );
    assert.deepEqual(
      calls.map((record) => record.value.body),
      ["call 1 intake", "call 2 build"],
    );
    assert.deepEqual(
      calls.map((record) => record.value.call),
      [1, 2],
    );
    const comments = cli(["issue", "comments", slice.id]).result.records;
    const checkpoint =
      /^checkpoint: pr (https:\/\/\S+\/pull\/(\d+)) head ([a-f0-9]{40}) receipt (\S+)$/.exec(
        comments.at(-1)?.value.body,
      );
    assert.ok(
      checkpoint,
      "the slice checkpoint contains the PR, head and receipt",
    );
    const [, url, number, head, receipt] = checkpoint;
    const links = cli(["issue", "links", slice.id]).result.records;
    assert.ok(
      links.some(
        (record) =>
          record.value.url === url && record.value.relation === "delivers",
      ),
    );
    const stateLine = run(process.execPath, [
      join(installed, "dist/bin/forge.js"),
      "pr",
      "state",
      number,
    ]);
    assert.equal(stateLine.trim().split("\n").length, 1);
    const state = JSON.parse(stateLine);
    assert.equal(state.pr, Number(number));
    assert.equal(state.head, head);
    assert.equal(state.verdict, "ready");
    assert.equal(state.end, true);
    const review = input("issue", "call", { id: slice.id, role: "review" });
    assert.equal(review.id, intent.id);
    assert.equal(review.call, 3);
    assert.equal(review.timeboxMinutes, 45);
    gh("pr", "merge", number, "--squash", "--match-head-commit", head);
    cli(["issue", "claim", slice.id]);
    input("issue", "close", { id: slice.id, receipt });
    assert.equal(cli(["issue", "show", slice.id]).result.status, "closed");
    const ghCalls = readFileSync(join(fake, "gh-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).slice(0, 2));
    assert.deepEqual(ghCalls, [
      ["pr", "create"],
      ["pr", "view"],
      ["pr", "checks"],
      ["pr", "checks"],
      ["api", "graphql"],
      ["api", `repos/fixture/first-run/pulls/${number}/comments?per_page=100`],
      ["pr", "view"],
      ["pr", "merge"],
    ]);
    console.log(
      "PASS restart: intake call 1 -> build call 2 -> checkpoint -> restart -> read back 2 calls -> pr state ready -> review call 3 -> merge by head -> close",
    );
  } else {
    throw new Error(`Unknown restart phase: ${phase}`);
  }
}
