import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [installed, work] = process.argv.slice(2);
const { createAssembly } = await import(
  pathToFileURL(join(installed, "dist/src/assembly/index.js")).href
);
const root = join(work, "project"),
  deviceRoot = join(work, "device");
mkdirSync(root, { recursive: true });
const marker = "declared-fixture-environment";
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    ["path", "pathext", "systemroot", "windir", "home", "tmp", "temp"].includes(
      name.toLowerCase(),
    ),
  ),
);
env.FORGE_L12_FIXTURE = marker;
const envNames = Object.keys(env);
const head = "a".repeat(40),
  base = "b".repeat(40);
const reference = { repository: "owner/repository", number: 42 };
const ready = {
  ...reference,
  headSha: head,
  baseSha: base,
  state: "OPEN",
  draft: false,
  mergeable: "MERGEABLE",
  complete: true,
  checks: [],
  requiredChecks: [],
  reviews: [],
  threads: [],
  findings: [],
  lastActivityAt: Date.now() - 10000,
};
const provider = join(root, "provider.cjs");
writeFileSync(
  provider,
  `
  const assert=require('node:assert/strict');
  assert.equal(process.env.FORGE_L12_FIXTURE,${JSON.stringify(marker)});
  let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>body+=chunk);
  process.stdin.on('end',()=>{
    const request=JSON.parse(body);assert.equal(request.action,'status');
    assert.deepEqual(request.payload,${JSON.stringify(reference)});
    process.stdout.write(JSON.stringify({ok:true,result:${JSON.stringify(ready)}}));
  });
`,
);
// Node treats "api" as its script path; this is a portable fake gh executable
// without a shell shim, executable-bit dependency or injected process service.
writeFileSync(
  join(root, "api"),
  `
  const assert=require('node:assert/strict');
  assert.equal(process.env.FORGE_L12_FIXTURE,${JSON.stringify(marker)});
  assert.deepEqual(process.argv.slice(2),['--hostname','github.com','--method','GET','user']);
  process.stdout.write(JSON.stringify({login:'owner'}));
`,
);
const prConfig = {
  envNames,
  provider: {
    executable: process.execPath,
    readArgs: [provider],
    writeArgs: [provider],
    timeoutMs: 15000,
    maxOutputBytes: 65536,
  },
  minApprovals: 0,
  settleMs: 0,
  optionalChecks: "safe-terminal",
  allowNoChecks: true,
  blockingLabels: [],
  leaseMs: 10000,
  squashTitle: "Explicit title",
  squashBody: "Explicit body",
};
const githubConfig = {
  envNames,
  executable: process.execPath,
  account: "owner",
  host: "github.com",
  timeoutMs: 15000,
  maxOutputBytes: 65536,
  pageSize: 10,
  maxPages: 2,
};
const assembly = await createAssembly({ root, deviceRoot, providers: { env } });
let sequence = 0;
const context = {
  actor: { kind: "human", id: "fixture" },
  project: { id: assembly.root, root: assembly.root },
  device: { id: assembly.deviceRoot },
};
async function invoke(op, input = {}, caller = "human") {
  return assembly.catalog.invoke({
    schemaVersion: "forge.invocation/1",
    requestId: `assembly-pr-${++sequence}`,
    op,
    input,
    caller,
    context,
  });
}
async function good(op, input = {}, caller = "human") {
  const value = await invoke(op, input, caller);
  assert.equal(value.ok, true, JSON.stringify(value));
  return value.result;
}
try {
  for (const [name, config] of [
    ["pr", prConfig],
    ["github", githubConfig],
  ]) {
    cpSync(
      join(installed, "dist/src/blocks", name),
      join(root, "blocks", name),
      { recursive: true },
    );
    const source = { path: `./blocks/${name}` };
    const shown = await good("config.show");
    await good("config.set", {
      path: `/blocks/${name}`,
      value: { source, config },
      expectRevision: shown.revision,
    });
    const added = await invoke("block.add", { path: source.path });
    assert.equal(added.ok, false);
    assert.equal(added.error.code, "ADMISSION_REQUIRED");
    const digest = /sha256:[a-f0-9]{64}/.exec(added.error.repair)?.[0];
    assert.ok(digest);
    await good("block.admit", { digest });
    const denied = await invoke(
      name === "pr" ? "pr.status" : "github.status",
      name === "pr" ? reference : {},
      "agent",
    );
    assert.equal(denied.ok, false);
    assert.equal(
      denied.error.code,
      "GRANT_REQUIRED",
      "process/environment grants must be effective at the shipped assembly",
    );
    await good("config.grant", {
      digest,
      effects: ["external:process", "environment:read"],
    });
  }
  assert.equal(assembly.catalog.unavailable().length, 0);
  const state = join(root, ".forge/state.sqlite");
  const before = existsSync(state);
  assert.equal(
    before,
    false,
    "configuration/admission should not create project records",
  );
  const view = await good("pr.status", reference, "agent");
  assert.equal(view.verdict.status, "MERGE_READY");
  assert.deepEqual(view.evidence, ready);
  const after = existsSync(state);
  assert.equal(
    after,
    false,
    "observational PR status must not create project state",
  );
  const github = await good("github.status", {}, "agent");
  assert.deepEqual(github, {
    account: "owner",
    host: "github.com",
    available: true,
  });
  const listed = assembly.catalog
    .list()
    .filter(
      (entry) => entry.op.startsWith("pr.") || entry.op.startsWith("github."),
    );
  assert.equal(listed.length, 16);
  const exposed = listed.filter((entry) => entry.admitted);
  assert.equal(exposed.length, 16);
  console.log(
    `PR assembly: admitted/configured ${exposed.length} catalog operations; actual supervised pr.status and github.status passed; state.sqlite before=${before}, after=${after}`,
  );
} finally {
  await assembly.close();
}
