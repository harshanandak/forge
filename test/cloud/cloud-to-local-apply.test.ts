import { expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyPrivateFile } from "../../src/adapters/store-sqlite/file-ops.ts";
import { createSqliteStore } from "../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import { apply } from "../../tools/cloud-to-local-apply.ts";
import { compute } from "../../tools/cloud-to-local-delta.ts";
import { cloudWrites, moved, project } from "./cloud-to-local.fixture.ts";
import * as f from "./import-current-state.fixture.ts";

setDefaultTimeout(120_000);

async function withStore<T>(
  path: string,
  write: boolean,
  use: (owner: StateOwner) => T,
): Promise<T> {
  const opened = await createSqliteStore(process.cwd()).open({
    path,
    readOnly: !write,
  });
  if (!opened.ok) throw new Error("store did not open");
  try {
    return use(new StateOwner(opened.handle.value, { now: () => f.at }));
  } finally {
    await opened.handle.close();
  }
}
type Doc = {
  delta: object[];
  notCarriedBack: object[];
  source: { project: unknown };
};
async function prepared() {
  const made = await moved();
  cloudWrites(made.dump);
  await compute(made.options);
  const store = join(made.root, "live.sqlite");
  copyPrivateFile(made.options.backup, store);
  const report = made.options.out;
  return {
    ...made,
    store,
    report,
    edit: (change: (doc: Doc) => void) => {
      const doc = JSON.parse(readFileSync(report, "utf8")) as Doc;
      change(doc);
      writeFileSync(report, JSON.stringify(doc));
    },
    apply: (write = false, manifest = made.options.manifest) =>
      apply({ report, manifest, store, write }),
  };
}
function rawStore(path: string, sql: string) {
  const db = new Database(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
const sha = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const read = (store: string, key: string) =>
  withStore(store, false, (owner) => owner.get(f.ns, key));
async function refused(attempt: Promise<unknown>, reason: string) {
  const error = await attempt.then(
    () => undefined,
    (thrown: unknown) => thrown as { error: { code: string; message: string } },
  );
  expect(error?.error.code).toBe("INPUT_INVALID");
  expect(error?.error.message).toContain(reason);
}

test("a dry run reports the carried records and writes nothing", async () => {
  const run = await prepared();
  const before = sha(run.store);
  expect(await run.apply()).toEqual({ mode: "dry-run", new: 2, changed: 1 });
  expect(sha(run.store)).toBe(before);
}, 120_000);

test("an explicit write applies every carried record in one batch", async () => {
  const run = await prepared();
  expect(await run.apply(true)).toEqual({
    mode: "applied",
    new: 2,
    changed: 1,
  });
  expect((await read(run.store, "comment:work-1:2"))?.value).toEqual({
    id: "work-1",
    body: "cloud only",
  });
  const issue = await read(run.store, "issue:work-3");
  expect(issue?.revision).toBe(2);
  expect(issue?.value).toMatchObject({ status: "closed" });
}, 120_000);

test("a record changed locally since the backup refuses the whole batch", async () => {
  const run = await prepared();
  await withStore(run.store, true, (owner) =>
    owner.put(
      f.ns,
      "issue:work-3",
      { ...f.issueValue("work-3"), title: "local edit" },
      f.actor,
      {
        expectRevision: 1,
      },
    ),
  );
  await refused(run.apply(true), "changed since the backup");
  expect(await read(run.store, "comment:work-1:2")).toBeUndefined();
  expect((await read(run.store, "issue:work-3"))?.revision).toBe(2);
}, 120_000);

test("a new record that exists locally refuses the whole batch", async () => {
  const run = await prepared();
  await withStore(run.store, true, (owner) =>
    owner.put(
      f.ns,
      "comment:work-1:2",
      { id: "work-1", body: "local" },
      f.actor,
      {
        expectRevision: 0,
      },
    ),
  );
  await refused(run.apply(true), "changed since the backup");
  expect((await read(run.store, "issue:work-3"))?.revision).toBe(1);
}, 120_000);

test("a report from a different backup is refused", async () => {
  const run = await prepared();
  writeFileSync(
    run.options.manifest,
    JSON.stringify({ ...run.source.manifest, sha256: "0".repeat(64) }),
  );
  const before = sha(run.store);
  await refused(run.apply(true), "different backup");
  expect(sha(run.store)).toBe(before);
}, 120_000);

test("a report from a different project is refused and a matching identity is accepted", async () => {
  const run = await prepared();
  expect(await run.apply()).toMatchObject({ mode: "dry-run" });
  await withStore(run.store, true, (owner) =>
    owner.put(
      "forge/core-project",
      "identity",
      { ...project, id: "fedcba9876543210" },
      f.actor,
      { expectRevision: 1 },
    ),
  );
  const before = sha(run.store);
  await refused(run.apply(true), "different project");
  expect(sha(run.store)).toBe(before);
}, 120_000);

test("a store without a project identity is refused", async () => {
  const run = await prepared();
  rawStore(
    run.store,
    "DELETE FROM state_records WHERE namespace='forge/core-project'",
  );
  const before = sha(run.store);
  await refused(run.apply(true), "no project identity");
  expect(sha(run.store)).toBe(before);
}, 120_000);

test("a report without a project identity is refused", async () => {
  const run = await prepared();
  run.edit((doc) => {
    doc.source.project = null;
  });
  await refused(run.apply(), "report");
}, 120_000);

test("a store whose migrations differ from the expected set is refused and not migrated", async () => {
  const run = await prepared();
  rawStore(
    run.store,
    "DELETE FROM state_migrations WHERE id='004_state_checkpoint'",
  );
  const before = sha(run.store);
  await refused(run.apply(true), "migrations differ");
  expect(sha(run.store)).toBe(before);
}, 120_000);
test("the next local comment and issue numbers follow the carried ones", async () => {
  const run = await prepared();
  await run.apply(true);
  const next = (prefix: string, value: object) =>
    withStore(
      run.store,
      true,
      (owner) => owner.putNext(f.ns, prefix, () => ({ value }), f.actor).key,
    );
  expect(await next("comment:work-1:", { id: "work-1", body: "local" })).toBe(
    "comment:work-1:3",
  );
  expect(await next("issue:work-", f.issueValue("work-10"))).toBe(
    "issue:work-10",
  );
}, 120_000);

test("a store path that vanishes before the write open is refused and not created", async () => {
  const run = await prepared();
  const step = (name: string) => {
    if (name === "identity-checked") rmSync(run.store);
  };
  await refused(
    apply({
      report: run.report,
      manifest: run.options.manifest,
      store: run.store,
      write: true,
      step,
    }),
    "store",
  );
  expect(existsSync(run.store)).toBe(false);
}, 120_000);

test("a revision that changes after the checks leaves no carried record and no floor change", async () => {
  const run = await prepared();
  const step = (name: string) => {
    if (name === "preflighted")
      rawStore(
        run.store,
        "UPDATE state_records SET revision=revision+1 WHERE namespace='forge/work' AND key='issue:work-3'",
      );
  };
  await expect(
    apply({
      report: run.report,
      manifest: run.options.manifest,
      store: run.store,
      write: true,
      step,
    }),
  ).rejects.toBeDefined();
  expect(await read(run.store, "comment:work-1:2")).toBeUndefined();
  expect(await read(run.store, "issue:work-9")).toBeUndefined();
  expect((await read(run.store, "allocation:comment:work-1:"))?.value).toEqual({
    prefix: "comment:work-1:",
    number: 1,
  });
}, 120_000);

test("records outside the carried families are refused, including keys named in notCarriedBack", async () => {
  const cases: ((doc: Doc) => void)[] = [
    (doc) => doc.delta.push(entry("autopilot:global")),
    (doc) => doc.delta.push(entry("allocation:issue:work-")),
    (doc) =>
      doc.notCarriedBack.push({
        scope: "forge/work:issue:*",
        reason: "barred",
        count: 1,
        keys: [{ namespace: f.ns, key: "issue:work-3" }],
      }),
  ];
  for (const change of cases) {
    const run = await prepared();
    run.edit(change);
    const before = sha(run.store);
    await refused(run.apply(true), "not carried back");
    expect(sha(run.store)).toBe(before);
  }
}, 120_000);

test("a store path that does not exist is refused and not created", async () => {
  const run = await prepared();
  const missing = join(run.root, "absent.sqlite");
  await refused(
    apply({
      report: run.report,
      manifest: run.options.manifest,
      store: missing,
      write: true,
    }),
    "store",
  );
  expect(existsSync(missing)).toBe(false);
}, 120_000);

function entry(key: string) {
  return {
    namespace: f.ns,
    key,
    kind: key.split(":")[0],
    change: "new",
    beforeRevision: null,
    after: {},
  };
}
