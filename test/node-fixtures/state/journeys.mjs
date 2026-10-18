import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
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
const { sqliteStore, createSqliteStore } = await load(
  "adapters/store-sqlite/index.js",
);
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
async function filePair() {
  const directory = mkdtempSync(join(tmpdir(), "forge-whole-file-"));
  const handles = [
    await store(join(directory, "source.db")),
    await store(join(directory, "target.db")),
  ];
  let remaining = handles.length;
  return handles.map((handle) => ({
    ...handle,
    async close() {
      await handle.close();
      if (--remaining === 0)
        rmSync(directory, { recursive: true, force: true });
    },
  }));
}
const cases = {
  async derivedstate() {
    for (const mutation of selected.includes(":")
      ? [selected.split(":")[1]]
      : [
          "value",
          "revision",
          "orphan",
          "missing",
          "gap",
          "lease",
          "previous",
          "receipt",
        ]) {
      const a = await store(),
        b = await store();
      try {
        const left = new StateOwner(a.value, { now: () => 1000 });
        const right = new StateOwner(b.value, { now: () => 2000 });
        left.initialize();
        right.initialize();
        const record = left.put(ns, "one", { value: 1 }, holder.actor, {
          expectRevision: 0,
        });
        left.acquire(ns, "subject", holder, 100, "claim");
        if (mutation === "value" || mutation === "revision") {
          const changed = {
            ...record,
            ...(mutation === "value" ? { value: 99 } : { revision: 9 }),
          };
          a.value.run("UPDATE state_records SET revision=?,body=?", [
            changed.revision,
            JSON.stringify(changed),
          ]);
        } else if (mutation === "orphan")
          a.value.exec("DELETE FROM state_events WHERE key='one'");
        else if (mutation === "missing")
          a.value.exec("DELETE FROM state_records");
        else if (mutation === "receipt")
          a.value.exec("DELETE FROM state_requests");
        else if (mutation === "gap") {
          const event = left.events(ns, "one")[0];
          a.value.run("UPDATE state_events SET body=? WHERE key='one'", [
            JSON.stringify({ ...event, revision: 3 }),
          ]);
        } else if (mutation === "previous") {
          const event = left.events(ns, "subject")[0];
          a.value.run("UPDATE state_events SET body=? WHERE key='subject'", [
            JSON.stringify({
              ...event,
              data: { ...event.data, previous: event.data.lease },
            }),
          ]);
        } else {
          const lease = left.lease(ns, "subject");
          a.value.run("UPDATE state_leases SET generation=9,body=?", [
            JSON.stringify({ ...lease, generation: 9 }),
          ]);
        }
        const before = right.export();
        assert.throws(
          () => right.restore(left.export()),
          (error) =>
            error?.error?.code === "INPUT_INVALID" &&
            error.name === "RestoreConsistencyFailure" &&
            error.key.includes(ns) &&
            error.table.startsWith("state_") &&
            /state_(records|events|leases|requests).*io.example\/demo/.test(
              error.message,
            ),
          mutation,
        );
        assert.deepEqual(right.export(), before);
      } finally {
        await a.close();
        await b.close();
      }
    }
    // A restored image must itself remain replayable, including authority revocation.
    const handles = [await store(), await store(), await store()];
    try {
      const owners = handles.map(
        (h) => new StateOwner(h.value, { now: () => 2000 }),
      );
      owners.forEach((o) => o.initialize());
      owners[0].acquire(ns, "subject", holder, 100, "claim");
      owners[1].restore(owners[0].export());
      owners[2].restore(owners[1].export());
      assert.equal(
        owners[2].acquire(ns, "subject", other, 100, "next").generation,
        2,
      );
    } finally {
      for (const h of handles) await h.close();
    }
  },
  async openidentity() {
    const dir = mkdtempSync(join(tmpdir(), "forge-open-identity-"));
    try {
      for (const boundary of process.platform === "win32"
        ? ["identity-checked", "opening"]
        : ["identity-checked", "opening", "connected"]) {
        const path = join(dir, `${boundary}.db`);
        const initial = await store(path);
        await initial.close();
        const result = await createSqliteStore(dir, {
          step(step) {
            if (step === boundary) {
              renameSync(path, `${path}.old`);
              writeFileSync(path, "");
            }
          },
        }).open({ path, readOnly: false });
        if (result.ok) await result.handle.close();
        assert.equal(
          result.ok,
          false,
          `identity swap at ${boundary} must be refused`,
        );
        assert.match(result.unavailable.reason, /identity changed/);
      }
      const path = join(dir, "fenced.db");
      writeFileSync(`${path}.restore-lock`, "");
      const refused = await createSqliteStore(dir).open({
        path,
        readOnly: false,
      });
      assert.equal(refused.ok, false);
      assert.equal(existsSync(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  async relativepaths() {
    const work = mkdtempSync(join(tmpdir(), "forge-relative-store-"));
    const cwd = process.cwd();
    const prior = process.env.OneDrive;
    const cloud = join(work, "synced-fixture");
    mkdirSync(cloud);
    process.env.OneDrive = cloud;
    try {
      process.chdir(cloud);
      const opened = await sqliteStore.open({
        path: "state.db",
        readOnly: false,
      });
      if (opened.ok) await opened.handle.close();
      assert.equal(opened.ok, false, "relative synced store must be refused");
      assert.match(opened.unavailable.reason, /cloud/);
      assert.equal(existsSync(join(cloud, "state.db")), false);
      process.chdir(cwd);
      const explicit = createSqliteStore(cloud);
      const relative = await explicit.open({
        path: "nested/state.db",
        readOnly: false,
      });
      assert.equal(relative.ok, false);
      assert.match(relative.unavailable.reason, /cloud/);
      const alias = join(work, "alias");
      symlinkSync(
        cloud,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      const linked = await createSqliteStore(work).open({
        path: "alias/state.db",
        readOnly: false,
      });
      assert.equal(linked.ok, false);
      assert.match(linked.unavailable.reason, /cloud/);
      const dangling = join(work, "dangling.db");
      symlinkSync(join(cloud, "uncreated.db"), dangling, "file");
      const refused = await createSqliteStore(work).open({
        path: "dangling.db",
        readOnly: false,
      });
      if (refused.ok) await refused.handle.close();
      assert.equal(refused.ok, false, "dangling file symlink must be refused");
      assert.equal(existsSync(join(cloud, "uncreated.db")), false);
      const local = await createSqliteStore(work).open({
        path: "local.db",
        readOnly: false,
      });
      assert.equal(local.ok, true);
      await local.handle.close();
      assert.equal(existsSync(join(work, "local.db")), true);
      const memory = await explicit.open({ path: ":memory:", readOnly: false });
      assert.equal(memory.ok, true);
      await memory.handle.close();
    } finally {
      process.chdir(cwd);
      if (prior === undefined) delete process.env.OneDrive;
      else process.env.OneDrive = prior;
      rmSync(work, { recursive: true, force: true });
    }
  },
  async generatedcolumns() {
    const domains = [
      {
        namespace: "forge/example",
        reviewedDigest: `sha256:${"c".repeat(64)}`,
        tables: ["domain_generated"],
        migrations: [
          {
            id: "002_generated",
            statements: [
              "CREATE TABLE domain_generated(id TEXT PRIMARY KEY, amount INTEGER, stored INTEGER GENERATED ALWAYS AS (amount * 2) STORED, virtual INTEGER GENERATED ALWAYS AS (amount + 1) VIRTUAL)",
            ],
          },
        ],
      },
    ];
    const [source, target] = await filePair();
    try {
      const first = new StateOwner(source.value, { now: () => 1000 });
      const second = new StateOwner(target.value, { now: () => 1000 });
      first.initialize(domains);
      second.initialize(domains);
      source.value.run("INSERT INTO domain_generated(id,amount) VALUES (?,?)", [
        "one",
        7,
      ]);
      const snapshot = first.export();
      second.restore(snapshot);
      assert.deepEqual(
        { ...target.value.get("SELECT * FROM domain_generated") },
        {
          id: "one",
          amount: 7n,
          stored: 14n,
          virtual: 8n,
        },
      );
      target.value.run("UPDATE domain_generated SET amount=9 WHERE id='one'");
      assert.deepEqual(
        { ...target.value.get("SELECT stored,virtual FROM domain_generated") },
        {
          stored: 18n,
          virtual: 10n,
        },
      );
    } finally {
      await source.close();
      await target.close();
    }
  },
  async foreignkeys() {
    for (const parentFirst of [false, true]) {
      const parent = parentFirst ? "domain_a_parent" : "domain_z_parent";
      const child = parentFirst ? "domain_z_child" : "domain_a_child";
      const declarations = [
        `CREATE TABLE ${parent}(id TEXT PRIMARY KEY)`,
        `CREATE TABLE ${child}(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES ${parent}(id))`,
      ];
      const domains = [
        {
          namespace: "forge/example",
          reviewedDigest: `sha256:${"a".repeat(64)}`,
          tables: parentFirst ? [parent, child] : [child, parent],
          migrations: [
            {
              id: "002_foreign_keys",
              statements: parentFirst
                ? declarations
                : declarations.toReversed(),
            },
          ],
        },
      ];
      const [source, target] = await filePair();
      try {
        const first = new StateOwner(source.value, { now: () => 1000 });
        const second = new StateOwner(target.value, { now: () => 1000 });
        first.initialize(domains);
        second.initialize(domains);
        source.value.run(`INSERT INTO ${parent} VALUES (?)`, ["parent"]);
        source.value.run(`INSERT INTO ${child} VALUES (?,?)`, [
          "child",
          "parent",
        ]);
        first.put(ns, "restored", { preserved: true }, holder.actor, {
          expectRevision: 0,
          requestId: "restore-request",
        });
        first.acquire(ns, "subject", holder, 100, "restore-lease");
        const snapshot = first.export();
        const before = second.export();
        const corrupt = { ...snapshot, image: snapshot.image.slice(0, 100) };
        assert.throws(() => second.restore(corrupt));
        assert.deepEqual(second.export(), before);
        assert.deepEqual(target.value.all("PRAGMA foreign_key_check"), []);
        second.restore(snapshot);
        assert.deepEqual(second.export().domains, snapshot.domains);
        assert.deepEqual(target.value.all("PRAGMA foreign_key_check"), []);
        assert.throws(
          () =>
            target.value.run(`INSERT INTO ${child} VALUES (?,?)`, [
              "dangling",
              "missing",
            ]),
          /foreign key/i,
        );
      } finally {
        await source.close();
        await target.close();
      }
    }
  },
  async namesandtriggers() {
    const domains = [
      {
        namespace: "forge/example",
        reviewedDigest: `sha256:${"d".repeat(64)}`,
        tables: ["domain_unusual", "domain_audit"],
        migrations: [
          {
            id: "002_trigger",
            statements: [
              'CREATE TABLE domain_unusual("odd column "" name" TEXT, payload BLOB, counter INTEGER, positive REAL, negative REAL)',
              "CREATE TABLE domain_audit(value TEXT)",
              'CREATE TRIGGER capture_insert AFTER INSERT ON domain_unusual BEGIN INSERT INTO domain_audit VALUES (new."odd column "" name"); END',
            ],
          },
        ],
      },
    ];
    const [a, b] = await filePair();
    try {
      const left = new StateOwner(a.value, { now: () => 1000 });
      const right = new StateOwner(b.value, { now: () => 1000 });
      left.initialize(domains);
      right.initialize(domains);
      a.value.run(
        'INSERT INTO domain_unusual("odd column "" name",payload,counter) VALUES (?,?,?)',
        ["authored", new Uint8Array([0, 255]), 9007199254740993n],
      );
      a.value.exec("UPDATE domain_unusual SET positive=1e999, negative=-1e999");
      const snapshot = left.export();
      right.restore(JSON.parse(JSON.stringify(snapshot)));
      assert.deepEqual(
        b.value.all("SELECT * FROM domain_unusual"),
        a.value.all("SELECT * FROM domain_unusual"),
      );
      assert.deepEqual(
        b.value.all("SELECT * FROM domain_audit").map((row) => ({ ...row })),
        [{ value: "authored" }],
      );
      b.value.run(
        'INSERT INTO domain_unusual("odd column "" name",payload,counter) VALUES (?,?,?)',
        ["later", null, 2],
      );
      assert.equal(b.value.all("SELECT * FROM domain_audit").length, 2);
    } finally {
      await a.close();
      await b.close();
    }
  },
  async restorevalidation() {
    const dir = mkdtempSync(join(tmpdir(), "forge-image-validation-"));
    const a = await store(),
      b = await store();
    try {
      const left = new StateOwner(a.value, { now: () => 1000 });
      const right = new StateOwner(b.value, { now: () => 1000 });
      const domains = [
        {
          namespace: "forge/example",
          reviewedDigest: `sha256:${"e".repeat(64)}`,
          tables: ["domain_parent", "domain_child"],
          migrations: [
            {
              id: "002_validation",
              statements: [
                "CREATE TABLE domain_parent(id INTEGER PRIMARY KEY)",
                "CREATE TABLE domain_child(id INTEGER REFERENCES domain_parent(id))",
              ],
            },
          ],
        },
      ];
      left.initialize(domains);
      right.initialize(domains);
      left.put(ns, "retained", { value: "complete" }, holder.actor, {
        expectRevision: 0,
      });
      const snapshot = left.export(),
        before = right.export();
      for (const image of ["AQID", snapshot.image.slice(0, 100)]) {
        assert.throws(() => right.restore({ ...snapshot, image }));
        assert.deepEqual(right.export(), before);
      }
      for (const sql of [
        "PRAGMA user_version=999",
        "INSERT INTO state_migrations VALUES ('999_future')",
        "UPDATE state_domains SET reviewed_digest='unknown'",
        "PRAGMA foreign_keys=OFF; INSERT INTO domain_child VALUES (99)",
      ]) {
        const path = join(dir, "candidate.db");
        writeFileSync(path, Buffer.from(snapshot.image, "base64"));
        const candidate = await store(path);
        candidate.value.exec(sql);
        const image = Buffer.from(candidate.value.exportImage()).toString(
          "base64",
        );
        await candidate.close();
        assert.throws(() => right.restore({ ...snapshot, image }));
        assert.deepEqual(right.export(), before);
      }
      assert.throws(
        () =>
          right.restore(snapshot, () => {
            throw new Error("approval drift");
          }),
        /approval drift/,
      );
      assert.deepEqual(right.export(), before);
    } finally {
      await a.close();
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  async requestreceipts() {
    const dir = mkdtempSync(join(tmpdir(), "forge-receipt-validation-"));
    const [source, target] = await filePair();
    try {
      const left = new StateOwner(source.value, { now: () => 1000 });
      const right = new StateOwner(target.value, { now: () => 2000 });
      left.initialize();
      right.initialize();
      const options = { expectRevision: 0, requestId: "first" };
      const first = left.put(ns, "one", { value: 1 }, holder.actor, options);
      const second = left.put(ns, "two", { value: 2 }, holder.actor, {
        expectRevision: 0,
        requestId: "second",
      });
      left.put(ns, "one", { value: 3 }, other.actor, { expectRevision: 1 });
      left.acquire(ns, "subject", holder, 100, "acquisition");
      left.renew(ns, { subject: "subject", holder, generation: 1 }, 200);
      left.put(ns, "subject", true, holder.actor, { expectRevision: 0 });
      left.put(ns, "fenced", true, holder.actor, {
        expectRevision: 0,
        requestId: "fenced",
        fence: { subject: "subject", holder, generation: 1 },
      });
      left.release(ns, { subject: "subject", holder, generation: 1 });
      left.acquire(ns, "subject", other, 200, "next-acquisition");
      const snapshot = left.export();
      const before = right.export();
      const corruptions = [
        [
          "UPDATE state_requests SET result=? WHERE request_id='first'",
          [JSON.stringify(second)],
        ],
        [
          "UPDATE state_requests SET result='null' WHERE request_id='first'",
          [],
        ],
        [
          "UPDATE state_requests SET fingerprint=? WHERE request_id='first'",
          [JSON.stringify({ kind: "put", key: "wrong" })],
        ],
        [
          "UPDATE state_requests SET fingerprint=' ' || fingerprint WHERE request_id='first'",
          [],
        ],
        [
          "UPDATE state_requests SET request_id='orphan' WHERE request_id='first'",
          [],
        ],
        [
          "UPDATE state_requests SET namespace='io.example/other' WHERE request_id='first'",
          [],
        ],
        [
          "UPDATE state_requests SET result=? WHERE request_id='acquisition'",
          [JSON.stringify(first)],
        ],
        [
          "UPDATE state_requests SET fingerprint=replace(fingerprint, '100', '101') WHERE request_id='acquisition'",
          [],
        ],
        [
          "UPDATE state_requests SET fingerprint='{' WHERE request_id='first'",
          [],
        ],
        [
          "INSERT INTO state_events(namespace,key,body) SELECT namespace,key,body FROM state_events WHERE key='two'",
          [],
        ],
      ];
      for (const [sql, params] of corruptions) {
        const path = join(dir, "candidate.db");
        writeFileSync(path, Buffer.from(snapshot.image, "base64"));
        const candidate = await store(path);
        let image;
        try {
          candidate.value.run(sql, params);
          image = Buffer.from(candidate.value.exportImage()).toString("base64");
        } finally {
          await candidate.close();
        }
        assert.throws(
          () => right.restore({ ...snapshot, image }),
          code("INPUT_INVALID"),
          sql,
        );
        assert.deepEqual(
          right.export(),
          before,
          "rejected receipt must leave live store unchanged",
        );
      }
      right.restore(snapshot);
      const restored = right.export();
      assert.deepEqual(
        right.put(ns, "one", { value: 1 }, holder.actor, options),
        first,
      );
      assert.deepEqual(right.export(), restored, "clean replay must not write");
      assert.deepEqual(right.list(ns), left.list(ns));
      assert.throws(
        () => right.acquire(ns, "subject", holder, 100, "acquisition"),
        code("LEASE_STALE"),
      );
    } finally {
      await source.close();
      await target.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  async restorefaults() {
    const steps = [
      "written",
      "synced",
      "validated",
      "prepared",
      "fenced",
      "closed",
      "retained",
      "renamed",
      "verified",
    ];
    for (const step of steps) {
      const dir = mkdtempSync(join(tmpdir(), "forge-restore-fault-"));
      const path = join(dir, "live.db");
      const a = await store();
      const opened = await createSqliteStore(dir, {
        step(name) {
          if (name === step) throw new Error(`fault:${step}`);
        },
      }).open({ path, readOnly: false });
      assert.equal(opened.ok, true);
      const b = opened.handle;
      try {
        const left = new StateOwner(a.value, { now: () => 1000 });
        const right = new StateOwner(b.value, { now: () => 1000 });
        left.initialize();
        right.initialize();
        left.put(ns, "complete", { step }, holder.actor, { expectRevision: 0 });
        assert.throws(
          () => right.restore(left.export()),
          new RegExp(`fault:${step}`),
        );
        assert.equal(right.list(ns).length, 0);
        assert.equal(
          b.value.get("PRAGMA integrity_check").integrity_check,
          "ok",
        );
      } finally {
        await a.close();
        await b.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
  async crashchild() {
    const directory = process.argv[4],
      stop = process.argv[5];
    const opened = await createSqliteStore(directory, {
      step(name) {
        if (name === stop) process.exit(73);
      },
    }).open({ path: "live.db", readOnly: false });
    assert.equal(opened.ok, true);
    const owner = new StateOwner(opened.handle.value, { now: () => 1000 });
    owner.restore({
      format: "forge.state/1",
      image: readFileSync(join(directory, "image.db")).toString("base64"),
    });
    throw new Error("Crash step was not reached");
  },
  async restorecrashes() {
    for (const step of [
      "written",
      "synced",
      "validated",
      "prepared",
      "fenced",
      "closed",
      "retained",
      "renamed",
      "verified",
    ]) {
      const dir = mkdtempSync(join(tmpdir(), "forge-restore-crash-"));
      try {
        const a = await store(),
          b = await store(join(dir, "live.db"));
        const left = new StateOwner(a.value, { now: () => 1000 }),
          right = new StateOwner(b.value, { now: () => 1000 });
        left.initialize();
        right.initialize();
        left.put(
          ns,
          "complete",
          { history: ["all", "retained"] },
          holder.actor,
          { expectRevision: 0, requestId: "crash-receipt" },
        );
        writeFileSync(
          join(dir, "image.db"),
          Buffer.from(left.export().image, "base64"),
        );
        await a.close();
        await b.close();
        const child = spawnSync(
          process.execPath,
          [process.argv[1], root, "crashchild", dir, step],
          { encoding: "utf8", windowsHide: true, timeout: 30000 },
        );
        assert.equal(child.status, 73, child.stderr);
        // The interrupted operation remains fenced. Explicit offline recovery releases only this fixture lock.
        rmSync(join(dir, "live.db.restore-lock"), { force: true });
        const live = await store(join(dir, "live.db"));
        try {
          assert.equal(
            live.value.get("PRAGMA integrity_check").integrity_check,
            "ok",
          );
          assert.deepEqual(live.value.all("PRAGMA foreign_key_check"), []);
          const owner = new StateOwner(live.value, { now: () => 1000 });
          const installed = ["renamed", "verified"].includes(step);
          assert.equal(owner.list(ns).length, installed ? 1 : 0);
          assert.equal(owner.events(ns).length, installed ? 1 : 0);
          assert.equal(
            Number(
              live.value.get("SELECT COUNT(*) AS n FROM state_requests").n,
            ),
            installed ? 1 : 0,
          );
          if (installed)
            assert.deepEqual(owner.get(ns, "complete").value, {
              history: ["all", "retained"],
            });
        } finally {
          await live.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
  async closeerrors() {
    const handle = await store();
    const callbackError = new Error("callback failed");
    const closeError = new Error("close failed");
    let closes = 0;
    const failing = {
      ...handle,
      async close() {
        closes++;
        throw closeError;
      },
    };
    try {
      for (const failure of [callbackError, undefined]) {
        await assert.rejects(
          withState(failing, { now: () => 0 }, async () => {
            throw failure;
          }),
          (error) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [failure, closeError]);
            assert.equal(error.cause, closeError);
            return true;
          },
        );
      }
      assert.equal(closes, 2);
      await assert.rejects(
        withState(failing, { now: () => 0 }, () => "success"),
        (error) => error === closeError,
      );
      assert.equal(closes, 3);
    } finally {
      await handle.close();
    }
  },
  async records() {
    const handle = await store();
    try {
      const owner = new StateOwner(handle.value, { now: () => 1000 });
      owner.initialize();
      assert.throws(
        () =>
          owner.put(ns, "sparse", new Array(1), holder.actor, {
            expectRevision: 0,
          }),
        code("INPUT_INVALID"),
      );
      assert.equal(owner.get(ns, "sparse"), undefined);
      assert.equal(owner.events(ns, "sparse").length, 0);

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
  async newerstore() {
    for (const future of ["999_future", "000_unknown", "schema"]) {
      const handle = await store();
      try {
        const db = handle.value;
        const owner = new StateOwner(db, { now: () => 1000 });
        owner.initialize();
        if (future === "schema") db.exec("PRAGMA user_version=999");
        else db.run("INSERT INTO state_migrations VALUES (?)", [future]);
        const ledger = db.all("SELECT * FROM state_migrations ORDER BY id");
        const before = db.get("SELECT total_changes() AS total").total;
        assert.throws(
          () => owner.initialize(),
          (error) => {
            assert.equal(error.name, "NewerStoreError");
            assert.equal(error.newestKnownVersion, baseline.id);
            assert.equal(
              error.foundVersion,
              future === "schema" ? "schema:999" : future,
            );
            assert.match(error.message, /Store written by a newer Forge/);
            return true;
          },
        );
        assert.deepEqual(
          db.all("SELECT * FROM state_migrations ORDER BY id"),
          ledger,
        );
        assert.equal(db.get("SELECT total_changes() AS total").total, before);
      } finally {
        await handle.close();
      }
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
      assert.deepEqual(
        right.events(ns).slice(0, left.events(ns).length),
        left.events(ns),
      );
      assert.equal(right.events(ns).at(-1).type, `${ns}:lease.released@1`);
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
      const [source, target] = await filePair();
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
        const fault = {
          ...destination.value,
          restoreImage(image, validate, prepare, verify) {
            return destination.value.restoreImage(
              image,
              validate,
              prepare,
              () => {
                renameSync(backup, join(dir, "old-transaction"));
                writeFileSync(backup, "backup");
                verify();
              },
            );
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
  if (
    (selected === "all" && name !== "crashchild") ||
    selected.split(":")[0] === name
  ) {
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
