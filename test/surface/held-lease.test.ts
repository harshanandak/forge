import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAssembly,
  localCall,
  type Assembly,
} from "../../src/assembly/index.ts";
import { runCli } from "../../src/surface/cli.ts";

const repo = resolve(import.meta.dirname, "../..");
let work: string;
let assembly: Assembly;

type Envelope = {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string };
};
/** `forge <argv>` through the generated CLI, as one plain command in the given session. */
async function forge(argv: readonly string[], session = "agent-one") {
  const response = await runCli(
    assembly.catalog,
    argv,
    localCall(assembly, session),
  );
  return JSON.parse(response.stdout) as Envelope;
}

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "forge-held-"));
  const block = join(work, "blocks", "work");
  cpSync(join(repo, "src/blocks/work"), block, {
    recursive: true,
    filter: (path) => !path.endsWith(".cts"),
  });
  const source = readFileSync(join(repo, "src/blocks/work/entry.cts"), "utf8");
  writeFileSync(
    join(block, "entry.cjs"),
    new Bun.Transpiler({ loader: "ts" }).transformSync(source),
  );
  mkdirSync(join(work, ".forge"));
  writeFileSync(
    join(work, ".forge", "config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: {
        work: { source: { path: "./blocks/work" }, bind: { state: "core" } },
      },
    }),
  );
  assembly = await createAssembly({
    root: work,
    deviceRoot: join(work, "device"),
  });
  const digest = (await forge(["block", "check", "./blocks/work"])).result
    ?.digest as string;
  expect((await forge(["block", "admit", digest])).ok).toBe(true);
  const granted = await forge([
    "config",
    "grant",
    "--input",
    JSON.stringify({ digest, effects: ["issue:write"] }),
  ]);
  expect(granted.ok).toBe(true);
}, 30_000);

afterEach(async () => {
  await assembly.close();
  rmSync(work, { recursive: true, force: true });
}, 30_000);

async function created(): Promise<string> {
  const issue = await forge([
    "issue",
    "create",
    "--input",
    JSON.stringify({ title: "Plain commands" }),
  ]);
  expect(issue.ok).toBe(true);
  return issue.result?.id as string;
}

test("claim, link and close are three plain commands in one session", async () => {
  const id = await created();
  const claimed = await forge(["issue", "claim", "--input", `{"id":"${id}"}`]);
  expect(claimed).toMatchObject({ ok: true, result: { id, generation: 1 } });
  const linked = await forge([
    "issue",
    "link",
    "--input",
    JSON.stringify({ id, relation: "pr", url: "https://example.com/pr/1" }),
  ]);
  expect(linked.ok).toBe(true);
  const closed = await forge(["issue", "close", "--input", `{"id":"${id}"}`]);
  expect(closed).toMatchObject({ ok: true, result: { id, status: "closed" } });
}, 30_000);

test("another session cannot link or close a claim it does not hold", async () => {
  const id = await created();
  expect((await forge(["issue", "claim", id])).ok).toBe(true);
  const link = JSON.stringify({ id, relation: "pr", url: "https://x.dev/1" });
  for (const argv of [
    ["issue", "link", "--input", link],
    ["issue", "close", id],
  ]) {
    const refused = await forge(argv, "agent-two");
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "LEASE_NOT_HELD" },
    });
  }
  const shown = await forge(["issue", "show", id]);
  expect(shown.result?.status).toBe("open");
  expect((await forge(["issue", "close", id])).ok).toBe(true);
}, 30_000);

test("a held command on an unclaimed item still names the missing lease", async () => {
  const id = await created();
  const refused = await forge(["issue", "close", id]);
  expect(refused).toMatchObject({
    ok: false,
    error: { code: "CONTEXT_MISSING" },
  });
}, 30_000);
