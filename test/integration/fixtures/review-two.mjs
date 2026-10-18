import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createAssembly, localContext } from "forge-workflow/runtime";
import { StateOwner } from "forge-workflow/state";
import { sqliteStore } from "forge-workflow/adapters/sqlite";
const packageUrl = import.meta.resolve("forge-workflow/package.json");
const { LocalState } = await import(
  new URL("dist/src/assembly/state.js", packageUrl)
);
const bin = fileURLToPath(new URL("dist/bin/forge.js", packageUrl));
const mode = process.argv[2] ?? "all";
const work = mkdtempSync(join(process.cwd(), "review-two-"));
function cli(root, args, expected = 0) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    env: { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") },
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(
    result.status,
    expected,
    `${args.join(" ")}: ${result.stdout}\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}
function block(path, noun) {
  mkdirSync(path, { recursive: true });
  const manifest = {
    schemaVersion: "forge.block/1",
    id: `example.org/${noun}`,
    version: "1.0.0",
    authorAbi: "forge.author/v1",
    profile: "trusted-action-sync/v1",
    entry: "index.cjs",
    docs: "docs.json",
    operations: {
      [`${noun}.echo`]: {
        input: "input.json",
        output: "output.json",
        args: ["value"],
        context: "stateless",
        effects: [],
        idempotent: true,
        callers: ["human", "agent"],
        stability: "stable",
      },
    },
  };
  writeFileSync(join(path, "forge.block.json"), JSON.stringify(manifest));
  for (const name of ["input", "output"])
    writeFileSync(join(path, `${name}.json`), '{"type":"object"}');
  writeFileSync(
    join(path, "docs.json"),
    JSON.stringify({
      operations: { [`${noun}.echo`]: { title: "Echo", summary: "Echo." } },
    }),
  );
  writeFileSync(
    join(path, "index.cjs"),
    `module.exports = { '${noun}.echo': ({input}) => input };`,
  );
  return manifest;
}
const rewrite = (path, file, value) =>
  writeFileSync(join(path, file), JSON.stringify(value));
const cases = [
  ["missing-source", (path) => rmSync(path, { recursive: true, force: true })],
  [
    "unreadable-manifest",
    (path) => {
      rmSync(join(path, "forge.block.json"));
      mkdirSync(join(path, "forge.block.json"));
    },
  ],
  [
    "invalid-manifest-json",
    (path) => writeFileSync(join(path, "forge.block.json"), "{"),
  ],
  [
    "manifest-schema",
    (path, manifest) =>
      rewrite(path, "forge.block.json", { ...manifest, version: 123 }),
  ],
  ["invalid-docs-json", (path) => writeFileSync(join(path, "docs.json"), "{")],
  [
    "invalid-docs",
    (path) => rewrite(path, "docs.json", { operations: "invalid" }),
  ],
  [
    "missing-docs-operation",
    (path) => rewrite(path, "docs.json", { operations: {} }),
  ],
  [
    "config-schema-mismatch",
    (path, manifest) => {
      rewrite(path, "forge.block.json", {
        ...manifest,
        configSchema: "config.json",
      });
      rewrite(path, "config.json", {
        type: "object",
        required: ["enabled"],
        properties: { enabled: { type: "boolean" } },
      });
    },
  ],
  ["capture-error", (path) => rmSync(join(path, "index.cjs"))],
];
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function lifetime() {
  const marker = join(work, "existing.sqlite");
  writeFileSync(marker, "marker");
  function provider(gate) {
    const opened = [],
      entered = deferred();
    const port = {
      async open(options) {
        const record = { readOnly: options.readOnly, closed: 0 };
        opened.push(record);
        entered.resolve();
        if (gate) await gate.promise;
        const result = await sqliteStore.open({
          path: ":memory:",
          readOnly: false,
        });
        assert.ok(result.ok);
        new StateOwner(result.handle.value, { now: () => 1000 }).initialize();
        return {
          ok: true,
          handle: {
            ownership: "owned",
            value: result.handle.value,
            async close() {
              record.closed++;
              await result.handle.close();
            },
          },
        };
      },
    };
    return { opened, entered, port };
  }
  const gate = deferred(),
    fake = provider(gate),
    state = new LocalState(marker, fake.port);
  const left = state.acquire(true),
    right = state.acquire(true);
  await fake.entered.promise;
  const opensBeforeRelease = fake.opened.length;
  gate.resolve();
  const handles = await Promise.all([left, right]);
  try {
    assert.equal(
      opensBeforeRelease,
      1,
      "concurrent first opens must be serialized",
    );
    assert.equal(
      fake.opened.length,
      1,
      "two callers share one open connection",
    );
    assert.equal(handles[0].value, handles[1].value);
    await handles[0].close();
    assert.equal(
      fake.opened[0].closed,
      0,
      "first invocation cannot close the second invocation's connection",
    );
    assert.equal(
      handles[1].value.get("example.org/lifetime", "none"),
      undefined,
    );
    const closing = state.close();
    assert.equal(
      handles[1].value.get("example.org/lifetime", "none"),
      undefined,
      "shutdown waits for active invocation",
    );
    await handles[1].close();
    await closing;
    assert.equal(
      fake.opened[0].closed,
      1,
      "shared connection closes exactly once",
    );
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
    await state.close();
  }
  const modes = provider(),
    changing = new LocalState(marker, modes.port);
  const reader = await changing.acquire(false);
  const writer = await changing.acquire(true);
  try {
    assert.equal(
      modes.opened[0].closed,
      0,
      "promotion cannot close an active reader",
    );
    assert.equal(reader.value.get("example.org/lifetime", "none"), undefined);
    await writer.close();
    assert.equal(
      reader.value.get("example.org/lifetime", "none"),
      undefined,
      "reader survives writer release",
    );
    assert.equal(modes.opened[1].closed, 1);
  } finally {
    await reader.close();
    await writer.close();
    await changing.close();
  }
  assert.deepEqual(
    modes.opened.map((record) => record.closed),
    [1, 1],
  );
  console.log(
    "PASS lifetime: queued first opens, leased clients, mode promotion and shutdown barriers",
  );
}
try {
  if (mode === "all" || mode === "bootstrap") {
    const root = join(work, "bootstrap");
    mkdirSync(join(root, "device/trust.sqlite"), { recursive: true });
    const env = { ...process.env, FORGE_DEVICE_ROOT: join(root, "device") };
    for (const flag of ["--version", "-v"]) {
      const result = spawnSync(process.execPath, [bin, flag], {
        cwd: root,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      });
      assert.equal(result.status, 0, "version must not open local state");
      assert.match(result.stdout, /^\d+\.\d+\.\d+[^\r\n]*\r?\n$/);
      assert.equal(result.stderr, "");
    }
    const result = spawnSync(process.execPath, [bin, "config", "show"], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    });
    assert.match(result.stdout, /^\{/, "bootstrap must return a JSON failure");
    const failure = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(failure.ok, false);
    assert.equal(failure.status, "FAIL");
    assert.equal(failure.error.code, "UNAVAILABLE");
    assert.equal(failure.error.retry, "never");
    assert.deepEqual(failure.warnings, []);
    assert.doesNotMatch(
      result.stderr,
      /\n\s+at /,
      "bootstrap failure must be handled",
    );
    console.log(
      "PASS bootstrap: typed JSON failure and state-independent version",
    );
  }
  if (mode === "all" || mode === "implicit-bindings") {
    for (const order of ["unbound", "provider-first", "consumer-first"]) {
      const root = join(work, order);
      mkdirSync(root);
      const consumer = block(join(root, "client"), "client");
      consumer.requires = [
        { slot: "cache", interface: "example.cache@1", optional: true },
      ];
      rewrite(join(root, "client"), "forge.block.json", consumer);
      const provider = block(join(root, "provider"), "provider");
      provider.provides = [
        { interface: "example.cache@1.0.0", noun: "provider" },
      ];
      rewrite(join(root, "provider"), "forge.block.json", provider);
      const entries = [
        ["client", { source: { path: "./client" } }],
        ...(order === "unbound"
          ? []
          : [["provider", { source: { path: "./provider" } }]]),
      ];
      if (order === "provider-first") entries.reverse();
      mkdirSync(join(root, ".forge"));
      rewrite(join(root, ".forge"), "config.yaml", {
        schemaVersion: "forge.config/1",
        blocks: Object.fromEntries(entries),
      });
      const assembly = await createAssembly({
        root,
        deviceRoot: join(root, "device"),
      });
      try {
        const advertised = assembly.catalog
          .list()
          .some((entry) => entry.op === "client.echo");
        if (order === "unbound") {
          assert.ok(advertised, "unbound optional slots remain optional");
          assert.deepEqual(assembly.catalog.unavailable(), []);
        } else {
          assert.equal(
            advertised,
            false,
            "unsupported implicit bindings must not be advertised",
          );
          assert.equal(
            assembly.catalog
              .unavailable()
              .find((entry) => entry.name === "client").error.code,
            "PROVIDER_MISSING",
          );
          assert.ok(
            assembly.catalog
              .list()
              .some((entry) => entry.op === "provider.echo"),
            "provider remains available",
          );
          assert.ok(
            cli(root, ["config", "show"]).result.problems.some((problem) =>
              problem.includes("client"),
            ),
          );
        }
      } finally {
        await assembly.close();
      }
    }
    console.log(
      "PASS implicit-bindings: resolved optional providers checked in both config orders",
    );
  }
  if (["all", "per-block", "bad-docs"].includes(mode)) {
    for (const [name, breakBlock] of cases.filter(
      ([name]) => mode !== "bad-docs" || name === "invalid-docs",
    )) {
      const root = join(work, name);
      mkdirSync(root);
      writeFileSync(
        join(root, "package.json"),
        '{"name":"consumer","version":"1.0.0"}',
      );
      block(join(root, "good"), "good");
      const manifest = block(join(root, "bad"), "bad");
      breakBlock(join(root, "bad"), manifest);
      mkdirSync(join(root, ".forge"));
      const bytes = JSON.stringify({
        schemaVersion: "forge.config/1",
        blocks: {
          bad: { source: { path: "./bad" } },
          good: { source: { path: "./good" } },
        },
      });
      writeFileSync(join(root, ".forge/config.yaml"), bytes);
      const show = cli(root, ["config", "show"]);
      assert.ok(
        show.result.problems.some(
          (problem) =>
            problem.includes("bad") && problem.includes("unavailable"),
        ),
        `${name}: invalid block is unavailable`,
      );
      assert.equal(
        readFileSync(join(root, ".forge/config.yaml"), "utf8"),
        bytes,
      );
      const assembly = await createAssembly({
        root,
        deviceRoot: join(root, "device"),
      });
      try {
        assert.equal(
          assembly.catalog.unavailable()[0].name,
          "bad",
          `${name}: typed catalog diagnostic`,
        );
        assert.ok(assembly.catalog.unavailable()[0].error.code);
        assert.ok(
          assembly.catalog.list().some((entry) => entry.op === "good.echo"),
          `${name}: healthy operations survive`,
        );
        assert.ok(
          !assembly.catalog.list().some((entry) => entry.op === "bad.echo"),
        );
      } finally {
        await assembly.close();
      }
      cli(root, [
        "config",
        "apply",
        "--input",
        JSON.stringify({
          expectRevision: show.result.revision,
          patch: [{ op: "remove", path: "/blocks/bad" }],
        }),
      ]);
      assert.equal(existsSync(join(root, ".forge/state.sqlite")), false);
    }
    console.log(
      "PASS per-block: nine source, manifest, docs, config and capture failure kinds remain repairable",
    );
  }
  if (mode === "all" || mode === "bindings") {
    const root = join(work, "bindings");
    mkdirSync(root);
    writeFileSync(
      join(root, "package.json"),
      '{"name":"consumer","version":"1.0.0"}',
    );
    const path = join(root, "scopes"),
      manifest = block(path, "scopes");
    const base = manifest.operations["scopes.echo"];
    manifest.requires = [{ slot: "records", interface: "forge.state@1" }];
    manifest.operations = Object.fromEntries(
      ["stateless", "project", "device"].map((context) => [
        `scopes.${context}`,
        {
          ...base,
          context,
          effects: context === "stateless" ? [] : ["scopes:write"],
        },
      ]),
    );
    rewrite(path, "forge.block.json", manifest);
    rewrite(path, "docs.json", {
      operations: Object.fromEntries(
        Object.keys(manifest.operations).map((op) => [
          op,
          { title: op, summary: op },
        ]),
      ),
    });
    writeFileSync(
      join(path, "index.cjs"),
      `module.exports = Object.fromEntries(['stateless','project','device'].map(context => ['scopes.'+context, ({input,services}) => { const slots=Object.keys(services); const count=services.records.list().length; if(context==='stateless') return {slots,count}; const record=services.records.put('record', {value:context}, {expectRevision:0}); return {slots,revision:record.revision}; }]));`,
    );
    const added = cli(root, ["block", "add", "./scopes"], 2),
      digest = added.error.repair.match(/sha256:[a-f0-9]{64}/)[0];
    cli(root, ["block", "admit", digest]);
    cli(root, [
      "config",
      "grant",
      "--input",
      JSON.stringify({ digest, effects: ["scopes:write"] }),
    ]);
    const assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
    });
    try {
      const operations = assembly.catalog
        .list()
        .filter((entry) => entry.op.startsWith("scopes."));
      assert.equal(operations.length, 3);
      for (const entry of operations) {
        const result = await assembly.catalog.invoke({
          schemaVersion: "forge.invocation/1",
          requestId: entry.op,
          op: entry.op,
          caller: "agent",
          context: localContext(assembly, { kind: "agent", id: "test" }),
          input: {},
        });
        assert.equal(
          result.ok,
          true,
          `${entry.op}: required service must be available: ${JSON.stringify(result)}`,
        );
        assert.deepEqual(
          result.result.slots,
          manifest.requires.map((required) => required.slot),
          "every advertised operation receives all required slots",
        );
      }
    } finally {
      await assembly.close();
    }
    for (const [db, expected] of [
      [join(root, ".forge/state.sqlite"), "project"],
      [join(root, "device/records.sqlite"), "device"],
    ]) {
      const opened = await sqliteStore.open({ path: db, readOnly: true });
      assert.ok(opened.ok);
      try {
        assert.equal(
          new StateOwner(opened.handle.value, { now: () => 1000 }).get(
            "example.org/scopes",
            "record",
          ).value.value,
          expected,
        );
      } finally {
        await opened.handle.close();
      }
    }
    for (const context of ["leased", "stateless"]) {
      const unsupported = join(root, `unsupported-${context}`),
        bad = block(unsupported, `unsupported-${context}`);
      bad.requires = [{ slot: "state", interface: "forge.state@1" }];
      bad.operations[`unsupported-${context}.echo`].context = context;
      bad.operations[`unsupported-${context}.echo`].effects = [
        "unsupported:write",
      ];
      if (context === "leased")
        bad.operations[`unsupported-${context}.echo`].leaseMode = "held";
      rewrite(unsupported, "forge.block.json", bad);
      const refused = cli(
        root,
        ["block", "check", `./unsupported-${context}`],
        1,
      );
      assert.equal(refused.error.code, "PROVIDER_MISSING");
      const current = cli(root, ["config", "show"]);
      cli(root, [
        "config",
        "apply",
        "--input",
        JSON.stringify({
          expectRevision: current.result.revision,
          patch: [
            {
              op: "set",
              path: `/blocks/unsupported-${context}`,
              value: { source: { path: `./unsupported-${context}` } },
            },
          ],
        }),
      ]);
      const configured = await createAssembly({
        root,
        deviceRoot: join(root, "device"),
      });
      try {
        assert.equal(
          configured.catalog
            .unavailable()
            .find((entry) => entry.name === `unsupported-${context}`).error
            .code,
          "PROVIDER_MISSING",
        );
        assert.ok(
          !configured.catalog
            .list()
            .some((entry) => entry.op.startsWith(`unsupported-${context}.`)),
          "unsupported bindings must not be advertised",
        );
      } finally {
        await configured.close();
      }
    }
    console.log(
      "PASS bindings: every advertised operation has required slots; device and project owners are isolated; unsupported contexts are refused",
    );
  }
  if (mode === "all" || mode === "lifetime") await lifetime();
} finally {
  rmSync(work, { recursive: true, force: true });
}
