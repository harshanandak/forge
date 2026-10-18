import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
const root = process.argv[2];
const selected = process.argv[3] ?? "all";
const load = (path) => import(pathToFileURL(join(root, "dist/src", path)).href);
const { sqliteStore } = await load("adapters/store-sqlite/index.js");
const { StateOwner, withState } = await load("core/state/index.js");
const { baseline, migrate, execMigrationStatement } = await load(
  "core/state/migrations.js",
);
const { trimTrailingSeparators, assertFilesystem, classifyFilesystem } =
  await load("core/state/fs-class.js");
const { inspectRecoveryFile, withRecoveryFence } = await load(
  "adapters/store-sqlite/recovery.js",
);
const { hardenPrivatePaths } = await load(
  "adapters/store-sqlite/private-acl.js",
);
const ns = "io.example/demo";
const holder = {
  actor: { kind: "agent", id: "alpha" },
  session: { id: "one" },
};
const other = { actor: { kind: "agent", id: "beta" }, session: { id: "two" } };
const code = (expected) => (error) => error?.error?.code === expected;
async function store(path = ":memory:") {
  const result = await sqliteStore.open({ path, readOnly: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.handle;
}
const cases = {
  async records() {
    const handle = await store();
    try {
      const owner = new StateOwner(handle.value, { now: () => 1000 });
      owner.initialize();
      const client = owner.client(ns, holder.actor);
      const value = {
        authored: "full text",
        history: [{ before: null, after: "x" }],
        nested: { z: [1, true, null] },
      };
      const first = client.put("entry", value, { expectRevision: 0 });
      assert.deepEqual(client.get("entry"), first);
      assert.equal(client.events("entry").length, 1);
      assert.throws(
        () => client.put("entry", {}, { expectRevision: 0 }),
        code("REVISION_CONFLICT"),
      );
      assert.equal(
        client.put("entry", value, { expectRevision: 1 }).revision,
        2,
      );
      assert.equal(
        owner.client("io.example/other", holder.actor).list().length,
        0,
      );
      assert.equal(client.list("%").length, 0);
      const opts = { expectRevision: 0, requestId: "request-1" };
      const result = owner.put(ns, "replay", value, holder.actor, opts);
      assert.deepEqual(
        owner.put(ns, "replay", value, holder.actor, opts),
        result,
      );
      assert.throws(
        () => owner.put(ns, "replay", {}, holder.actor, opts),
        code("INPUT_CONFLICT"),
      );
      assert.throws(
        () => client.put("bad", undefined, { expectRevision: 0 }),
        code("INPUT_INVALID"),
      );
      assert.equal(client.events("bad").length, 0);
      const casFault = new StateOwner(
        {
          ...handle.value,
          run(sql, params) {
            if (sql.startsWith("UPDATE state_records"))
              return { changes: 0, lastInsertRowid: 0 };
            return handle.value.run(sql, params);
          },
        },
        { now: () => 1000 },
      );
      assert.throws(
        () =>
          casFault.put(ns, "entry", { rejected: true }, holder.actor, {
            expectRevision: 2,
          }),
        (error) =>
          code("REVISION_CONFLICT")(error) && error.error.currentRevision === 2,
      );
      assert.equal(client.get("entry").revision, 2);
      assert.equal(client.events("entry").length, 2);
      const dir = mkdtempSync(join(tmpdir(), "forge-state-read-"));
      try {
        const missing = join(dir, "absent.db");
        assert.equal(
          (await sqliteStore.open({ path: missing, readOnly: true })).ok,
          false,
        );
        assert.equal(existsSync(missing), false);
        const path = join(dir, "present.db"),
          disk = await store(path);
        const writer = new StateOwner(disk.value, { now: () => 1000 });
        writer.initialize();
        writer
          .client(ns, holder.actor)
          .put("saved", { value: 17 }, { expectRevision: 0 });
        await disk.close();
        const before = readFileSync(path);
        const opened = await sqliteStore.open({ path, readOnly: true });
        assert.equal(opened.ok, true);
        try {
          const reader = new StateOwner(opened.handle.value, {
            now: () => 1000,
          });
          assert.equal(reader.get(ns, "saved").value.value, 17);
          reader.list(ns);
          reader.events(ns);
          reader.export();
        } finally {
          await opened.handle.close();
        }
        assert.deepEqual(readFileSync(path), before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      await handle.close();
    }
  },
  async migration() {
    const a = await store(),
      b = await store();
    try {
      const later = {
        id: "002_metadata",
        statements: ["ALTER TABLE state_records ADD COLUMN metadata TEXT"],
      };
      migrate(a.value, [baseline, later]);
      migrate(b.value, [baseline]);
      assert.equal(
        b.value
          .all("PRAGMA table_info(state_records)")
          .some((column) => column.name === "metadata"),
        false,
      );
      migrate(b.value, [baseline, later]);
      // Lost-ledger recovery must not attempt to seed migration-added columns twice.
      b.value.exec("DELETE FROM state_migrations");
      migrate(b.value, [baseline, later]);
      assert.deepEqual(
        a.value.all("PRAGMA table_info(state_records)"),
        b.value.all("PRAGMA table_info(state_records)"),
      );
      for (const db of [a.value, b.value]) {
        const owner = new StateOwner(db, { now: () => 1000 });
        owner
          .client(ns, holder.actor)
          .put("same", { text: "same" }, { expectRevision: 0 });
      }
      assert.deepEqual(
        new StateOwner(a.value, { now: () => 1000 }).export(),
        new StateOwner(b.value, { now: () => 1000 }).export(),
      );
      const native = new Error("original ADD failure");
      for (const post of ["present", "absent", "throws"]) {
        let reads = 0;
        const fault = {
          ...a.value,
          all() {
            if (++reads === 1) return [];
            if (post === "throws") throw new Error("probe failed");
            return post === "present" ? [{ name: "raced" }] : [];
          },
          exec() {
            throw native;
          },
        };
        if (post === "present")
          execMigrationStatement(
            fault,
            "ALTER TABLE state_records ADD COLUMN raced TEXT",
          );
        else
          assert.throws(
            () =>
              execMigrationStatement(
                fault,
                "ALTER TABLE state_records ADD COLUMN raced TEXT",
              ),
            (error) => error === native,
          );
      }
      assert.throws(() =>
        migrate(a.value, [
          {
            id: "003_fail",
            statements: ["CREATE TABLE transient(value TEXT)", "INVALID SQL"],
          },
        ]),
      );
      assert.equal(
        a.value.get("SELECT name FROM sqlite_master WHERE name='transient'"),
        undefined,
      );
    } finally {
      await a.close();
      await b.close();
    }
  },
  async leases() {
    const handle = await store();
    let now = 1000;
    try {
      const owner = new StateOwner(handle.value, { now: () => now });
      owner.initialize();
      const first = owner.acquire(ns, "subject", holder, 100, "claim-1");
      assert.equal(first.generation, 1);
      assert.deepEqual(
        owner.acquire(ns, "subject", holder, 100, "claim-1"),
        first,
      );
      assert.throws(
        () => owner.acquire(ns, "subject", other, 100, "claim-2"),
        code("LEASE_HELD"),
      );
      const fence = { subject: "subject", holder, generation: 1 };
      assert.throws(
        () =>
          owner.renew(
            ns,
            { ...fence, holder: { ...holder, session: { id: "different" } } },
            100,
          ),
        code("LEASE_NOT_HELD"),
      );
      assert.throws(
        () => owner.renew(ns, { ...fence, generation: undefined }, 100),
        code("CONTEXT_MISSING"),
      );
      assert.throws(
        () => owner.acquire(ns, "invalid", holder, 0, "invalid"),
        code("INPUT_INVALID"),
      );
      now = 1100;
      assert.throws(() => owner.renew(ns, fence, 100), code("LEASE_EXPIRED"));
      const second = owner.acquire(ns, "subject", holder, 100, "claim-3");
      assert.equal(second.generation, 2);
      assert.equal(
        owner.events(ns, "subject").at(-1).type,
        `${ns}:lease.reacquired@1`,
      );
      assert.throws(
        () => owner.acquire(ns, "subject", holder, 100, "claim-1"),
        code("LEASE_STALE"),
      );
      assert.throws(
        () =>
          owner.put(ns, "entry", {}, holder.actor, {
            expectRevision: 0,
            fence,
          }),
        code("LEASE_STALE"),
      );
      owner.release(ns, { ...fence, generation: 2 });
      assert.equal(
        owner.acquire(ns, "subject", other, 100, "claim-4").generation,
        3,
      );
    } finally {
      await handle.close();
    }
  },
  async concurrency() {
    const handle = await store();
    let now = 1000;
    try {
      const owner = new StateOwner(handle.value, { now: () => now });
      owner.initialize();
      let entered = false,
        loser;
      // Force the second caller to enter at the winner's transaction boundary.
      const fault = {
        ...handle.value,
        transaction(body) {
          return handle.value.transaction(() => {
            if (!entered) {
              entered = true;
              try {
                owner.acquire(ns, "race", other, 100, "loser");
              } catch (error) {
                loser = error;
              }
            }
            return body();
          });
        },
      };
      const contender = new StateOwner(fault, { now: () => now });
      const winner = contender.acquire(ns, "race", holder, 100, "winner");
      assert.equal(winner.generation, 1);
      assert.match(loser.message, /Nested transactions/);
      assert.throws(
        () => owner.acquire(ns, "race", other, 100, "loser"),
        code("LEASE_HELD"),
      );
      assert.equal(owner.events(ns, "race").length, 1);
      // Move authority exactly after the call starts and before its write transaction body.
      let injected = false;
      const deferred = {
        ...handle.value,
        transaction(body) {
          if (!injected) {
            injected = true;
            now = 1100;
            owner.acquire(ns, "race", other, 100, "takeover");
          }
          return handle.value.transaction(body);
        },
      };
      const revived = new StateOwner(deferred, { now: () => now });
      assert.throws(
        () =>
          revived.put(ns, "fenced", {}, holder.actor, {
            expectRevision: 0,
            fence: { subject: "race", holder, generation: 1 },
          }),
        code("LEASE_STALE"),
      );
      assert.equal(owner.get(ns, "fenced"), undefined);
    } finally {
      await handle.close();
    }
  },
  async filesystem() {
    const value = "x" + "/".repeat(1000000);
    assert.equal(trimTrailingSeparators(value), "x");
    const hostile = "/".repeat(1000000) + "x";
    assert.equal(trimTrailingSeparators(hostile), hostile);
    assert.equal(
      classifyFilesystem({
        path: "C:/OneDrive/db",
        platform: "win32",
        driveType: "unknown",
      }).risk,
      "refuse",
    );
    assert.equal(
      classifyFilesystem({
        path: "C:/OneDriveBackup/db",
        platform: "win32",
        cloudRoots: ["C:/OneDrive"],
        driveType: "local",
      }).risk,
      "safe",
    );
    assert.equal(
      classifyFilesystem({
        path: "/data/db",
        platform: "linux",
        mountType: "nfs4",
      }).risk,
      "refuse",
    );
    const lines = [];
    const signals = { path: "/mnt/c/db", platform: "linux", wsl: true };
    assertFilesystem(signals, (line) => lines.push(line));
    assertFilesystem(signals, (line) => lines.push(line));
    assert.equal(lines.length, 1);
  },
  async lifecycle() {
    const handle = await store();
    let closes = 0;
    const counted = {
      ...handle,
      async close() {
        closes++;
        await handle.close();
      },
    };
    await assert.rejects(
      withState(counted, { now: () => 0 }, () => {
        throw new Error("body failed");
      }),
      /body failed/,
    );
    assert.equal(closes, 1);
    const borrowed = await store();
    try {
      await assert.rejects(
        withState(
          { ownership: "borrowed", value: borrowed.value },
          { now: () => 0 },
          () => {
            throw new Error("borrowed failed");
          },
        ),
        /borrowed failed/,
      );
      borrowed.value.exec("SELECT 1");
    } finally {
      await borrowed.close();
    }
    await counted.close(); // adapter close itself is idempotent
  },
  async roundtrip() {
    const a = await store(),
      b = await store();
    try {
      const left = new StateOwner(a.value, { now: () => 1000 });
      left.initialize();
      const right = new StateOwner(b.value, { now: () => 1000 });
      right.initialize();
      left.put(
        ns,
        "full",
        {
          authored: "body",
          history: [{ old: null }],
          arbitrary: [null, 17, { deep: "value" }],
        },
        holder.actor,
        { expectRevision: 0 },
      );
      left.acquire(ns, "subject", holder, 100, "lease");
      const snapshot = left.export();
      right.restore(snapshot);
      assert.deepEqual(right.list(ns), left.list(ns));
      assert.deepEqual(right.events(ns), left.events(ns));
      assert.deepEqual(right.get(ns, "full").value, {
        authored: "body",
        history: [{ old: null }],
        arbitrary: [null, 17, { deep: "value" }],
      });
      assert.equal(
        right.acquire(ns, "subject", other, 100, "new-lease").generation,
        2,
      );
      assert.throws(() => right.restore(snapshot), code("INPUT_INVALID"));
      const domains = [
        {
          namespace: "forge/example",
          reviewedDigest: `sha256:${"a".repeat(64)}`,
          tables: ["domain_example"],
          migrations: [
            {
              id: "002_domain_example",
              statements: [
                "CREATE TABLE domain_example(id TEXT PRIMARY KEY, content TEXT, payload BLOB, counter INTEGER)",
              ],
            },
          ],
        },
      ];
      const source = await store(),
        target = await store();
      try {
        const first = new StateOwner(source.value, { now: () => 1000 }),
          second = new StateOwner(target.value, { now: () => 1000 });
        first.initialize(domains);
        second.initialize(domains);
        // Reviewed first-party setup data; export/restore itself remains owned by StateOwner.
        source.value.run("INSERT INTO domain_example VALUES (?,?,?,?)", [
          "one",
          "full authored history",
          new Uint8Array([0, 255, 17]),
          9007199254740993n,
        ]);
        first.put(ns, "replay", { a: "retained" }, holder.actor, {
          expectRevision: 0,
          requestId: "retained-request",
        });
        second.restore(first.export());
        assert.deepEqual(second.export().domains, first.export().domains);
        assert.deepEqual(
          second.put(ns, "replay", { a: "retained" }, holder.actor, {
            expectRevision: 0,
            requestId: "retained-request",
          }),
          first.get(ns, "replay"),
        );
        assert.throws(
          () =>
            first.initialize([
              {
                ...domains[0],
                reviewedDigest: `sha256:${"b".repeat(64)}`,
                migrations: [
                  ...domains[0].migrations,
                  {
                    id: "003_rejected_registration",
                    statements: ["CREATE TABLE domain_rejected(value TEXT)"],
                  },
                ],
              },
            ]),
          /ownership changed/,
        );
        assert.equal(
          source.value.get(
            "SELECT name FROM sqlite_master WHERE name='domain_rejected'",
          ),
          undefined,
        );
        assert.equal(
          source.value.get(
            "SELECT id FROM state_migrations WHERE id='003_rejected_registration'",
          ),
          undefined,
        );
        assert.throws(
          () =>
            second.initialize([
              { ...domains[0], namespace: "io.example/outside" },
            ]),
          code("INPUT_INVALID"),
        );
      } finally {
        await source.close();
        await target.close();
      }
    } finally {
      await a.close();
      await b.close();
    }
  },
  async recovery() {
    const dir = mkdtempSync(join(tmpdir(), "forge-state-recovery-"));
    try {
      const source = join(dir, "source"),
        backup = join(dir, "backup");
      writeFileSync(source, "source");
      writeFileSync(backup, "backup");
      const approved = {
        source: inspectRecoveryFile(source),
        backup: inspectRecoveryFile(backup),
      };
      const harden = async (paths) => {
        for (const path of paths) chmodSync(path, 0o600);
      };
      // Real host proof: mutate only these disposable files, through the process port.
      const native = {
        resolve: (executable) => ({ kind: "resolved", path: executable }),
        async run(executable, args, options) {
          const result = spawnSync(executable.path, args, {
            cwd: options.cwd,
            env: options.env,
            input: options.stdin,
            encoding: "utf8",
            windowsHide: true,
            timeout: options.timeoutMs,
          });
          return {
            exitCode: result.status,
            timedOut: result.error?.code === "ETIMEDOUT",
            truncated: false,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            signal: result.signal,
            durationMs: 0,
          };
        },
      };
      await hardenPrivatePaths([source, backup], native, process.env);
      let committed = false;
      await withRecoveryFence(
        approved,
        join(dir, "retained"),
        harden,
        (verify) => {
          verify();
          committed = true;
        },
      );
      assert.equal(committed, true);
      assert.equal(readFileSync(join(dir, "retained"), "utf8"), "backup");
      await assert.rejects(
        withRecoveryFence(
          approved,
          join(dir, "retained-2"),
          harden,
          (verify) => {
            renameSync(backup, join(dir, "old"));
            writeFileSync(backup, "backup");
            verify();
          },
        ),
        /drift/,
      );
      // A hardening failure must prevent any mutation callback.
      committed = false;
      await assert.rejects(
        withRecoveryFence(
          {
            source: inspectRecoveryFile(source),
            backup: inspectRecoveryFile(backup),
          },
          join(dir, "retained-3"),
          async () => {
            throw new Error("ACL refused");
          },
          () => {
            committed = true;
          },
        ),
        /ACL refused/,
      );
      assert.equal(committed, false);
      const origin = await store(),
        destination = await store();
      try {
        const first = new StateOwner(origin.value, { now: () => 1000 });
        first.initialize();
        first
          .client(ns, holder.actor)
          .put("recover", { authored: "retained" }, { expectRevision: 0 });
        let swapped = false;
        const fault = {
          ...destination.value,
          run(sql, params) {
            const result = destination.value.run(sql, params);
            if (!swapped && sql.startsWith("INSERT INTO state_records")) {
              swapped = true;
              renameSync(backup, join(dir, "old-transaction"));
              writeFileSync(backup, "backup");
            }
            return result;
          },
        };
        const second = new StateOwner(fault, { now: () => 1000 });
        second.initialize();
        const approval = {
          source: inspectRecoveryFile(source),
          backup: inspectRecoveryFile(backup),
        };
        await assert.rejects(
          withRecoveryFence(
            approval,
            join(dir, "retained-transaction"),
            harden,
            (verify) => second.restore(first.export(), verify),
          ),
          /drift/,
        );
        assert.equal(second.list(ns).length, 0);
        assert.equal(second.events(ns).length, 0);
      } finally {
        await origin.close();
        await destination.close();
      }
      const fake = {
        resolve: () => ({ kind: "resolved", path: "powershell.exe" }),
        async run() {
          return { exitCode: 1, timedOut: false, truncated: false };
        },
      };
      await assert.rejects(
        hardenPrivatePaths([backup], fake, {}, "win32"),
        /ACL/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
const passed = [];
for (const [name, run] of Object.entries(cases))
  if (selected === "all" || selected === name) {
    await run();
    passed.push(name);
  }
assert.ok(passed.length > 0);
console.log(
  JSON.stringify({
    runtime: process.version,
    binding: process.versions.bun ? "bun:sqlite" : "node:sqlite",
    passed,
  }),
);
