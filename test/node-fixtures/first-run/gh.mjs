// A fake `gh` for the first-run journey: `pr create` records the branch head, and `pr merge`
// refuses unless `--match-head-commit` names that head, like GitHub does.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const state = join(process.cwd(), ".git", "fake-gh.json");
const prs = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : [];
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const head = () =>
  spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

if (args[0] === "pr" && args[1] === "create") {
  const number = prs.length + 1;
  const url = `https://github.com/fixture/first-run/pull/${number}`;
  prs.push({
    number,
    url,
    title: flag("--title"),
    head: head(),
    state: "OPEN",
  });
  writeFileSync(state, JSON.stringify(prs));
  console.log(url);
} else if (args[0] === "pr" && args[1] === "merge") {
  const pr = prs.find((entry) => entry.number === Number(args[2]));
  if (!pr || pr.state !== "OPEN") {
    console.error(`no open pull request ${args[2]}`);
    process.exit(1);
  }
  if (flag("--match-head-commit") !== pr.head) {
    console.error(
      `Head branch was modified. Review and try the merge again. (expected ${pr.head})`,
    );
    process.exit(1);
  }
  pr.state = "MERGED";
  writeFileSync(state, JSON.stringify(prs));
  console.log(`Merged pull request #${pr.number}`);
} else if (
  args[0] === "pr" &&
  args[1] === "view" &&
  flag("--json") === "state,headRefOid,mergeCommit"
) {
  const pr = prs.find((entry) => entry.url === args[2]);
  if (!pr) throw new Error(`Unknown pull request ${args[2]}`);
  console.log(
    JSON.stringify({
      state: pr.state,
      headRefOid: pr.head,
      mergeCommit: pr.state === "MERGED" ? { oid: pr.head } : null,
    }),
  );
} else {
  console.error(`fake gh: unsupported ${args.join(" ")}`);
  process.exit(2);
}
