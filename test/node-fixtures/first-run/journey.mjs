// A new user's first run, against the npm-installed package only, on Node with no Bun:
// import the delivery template, render its skills, file and claim a slice, watch check go red
// then green, open and link a PR, merge it by head through a fake `gh`, and close the slice.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const installed = process.argv[2];
const bin = join(installed, "dist/bin/forge.js");
const gh = join(import.meta.dirname, "gh.mjs");
assert.equal(process.versions.bun, undefined);
const root = realpathSync(mkdtempSync(join(process.cwd(), "first-run-")));
const env = {
  ...process.env,
  FORGE_DEVICE_ROOT: join(root, ".device"),
  FORGE_SESSION: "first-run",
};
const passed = [];

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  if (result.error) throw result.error;
  return result;
}
function cli(args, expected = 0) {
  const result = run(process.execPath, [bin, ...args]);
  assert.equal(
    result.status,
    expected,
    `forge ${args.slice(0, 2).join(" ")}: ${result.stdout} ${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}
function git(...args) {
  const result = run("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    ...args,
  ]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function commit(message) {
  git("add", "--all");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

// An npm project whose test fails until the fix lands.
writeFileSync(
  join(root, "package.json"),
  JSON.stringify({
    name: "first-run",
    version: "1.0.0",
    private: true,
    scripts: { test: "node test.js" },
  }),
);
writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
writeFileSync(join(root, ".gitignore"), ".device/\n");
writeFileSync(
  join(root, "test.js"),
  'const { add } = require("./add.js");\nif (add(2, 2) !== 4) { console.error("add(2, 2) is wrong"); process.exit(1); }\n',
);
writeFileSync(join(root, "add.js"), "exports.add = (a, b) => a - b;\n");
git("init", "-q");
commit("fixture");

const imported = cli([
  "template",
  "import",
  "--input",
  JSON.stringify({ template: "delivery" }),
]).result;
assert.equal(imported.template, "harsha/delivery@0.1.2");
passed.push("template import");

const synced = cli(["skills", "sync"]).result;
for (const name of [
  "forge-loop",
  "forge-intake",
  "slice",
  "build",
  "open-pr",
  "review",
  "land",
]) {
  const file = `.agents/skills/${name}/SKILL.md`;
  assert.ok(synced.written.includes(file), `skills sync wrote ${file}`);
  assert.ok(existsSync(join(root, file)));
}
passed.push("skills sync");
commit("forge: delivery template");

const slice = cli([
  "issue",
  "create",
  "--input",
  JSON.stringify({ title: "Fix add", kind: "bug", labels: ["p1"] }),
]).result;
// A repository with no origin remote: its folder's name, lowercased, prefixes the id.
assert.equal(slice.id, `${basename(root).toLowerCase()}-1`);
passed.push("issue create");
cli(["issue", "claim", slice.id]);
passed.push("issue claim");

const red = cli(["check", "run"], 1).result;
assert.equal(red.status, "FAIL", JSON.stringify(red));
assert.equal(red.subject, git("rev-parse", "HEAD"));
passed.push("check red");

writeFileSync(join(root, "add.js"), "exports.add = (a, b) => a + b;\n");
const head = commit("fix: add adds");
const green = cli(["check", "run"]).result;
assert.equal(green.status, "PASS", JSON.stringify(green));
assert.equal(green.subject, head, "the receipt is bound to the fixed head");
assert.equal(cli(["check", "show", green.id]).result.subject, head);
passed.push("check green");

const pr = run(process.execPath, [gh, "pr", "create", "--title", "Fix add"]);
assert.equal(pr.status, 0, pr.stderr);
const url = pr.stdout.trim();
cli([
  "issue",
  "link",
  "--input",
  JSON.stringify({ id: slice.id, relation: "delivers", url }),
]);
passed.push("pr create + issue link");

const wrong = run(process.execPath, [
  gh,
  "pr",
  "merge",
  "1",
  "--squash",
  "--match-head-commit",
  "0".repeat(40),
]);
assert.notEqual(wrong.status, 0, "a wrong head is refused");
assert.match(wrong.stderr, /Head branch was modified/);
const merged = run(process.execPath, [
  gh,
  "pr",
  "merge",
  "1",
  "--squash",
  "--match-head-commit",
  head,
]);
assert.equal(merged.status, 0, merged.stderr);
passed.push("merge by head");

cli([
  "issue",
  "close",
  "--input",
  JSON.stringify({ id: slice.id, receipt: green.id }),
]);
assert.equal(cli(["issue", "show", slice.id]).result.status, "closed");
// The tracker item carries no links; `issue links` reads them back.
const links = JSON.stringify(cli(["issue", "links", slice.id]).result);
assert.ok(links.includes(url), `the PR link survives the close: ${links}`);
assert.match(links, /"delivers"/);
passed.push("issue close + show");
assert.match(readFileSync(join(root, ".git/fake-gh.json"), "utf8"), /MERGED/);
console.log(`PASS first run: ${passed.join(" → ")}`);
