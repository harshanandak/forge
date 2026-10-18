import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFileCapture } from "../../../src/adapters/node-runtime/capture.ts";
import { Catalog, CapturedBlock } from "../../../src/core/catalog/index.ts";
import { INTERFACE_DOCUMENTS } from "../../../src/generated/schemas.ts";
import type {
  BlockManifest,
  ConfigDocument,
  InterfaceDocument,
} from "../../../src/generated/types.ts";

const operation = {
  input: "input.json",
  output: "output.json",
  context: "stateless",
  effects: [],
  idempotent: true,
  callers: ["human", "agent"],
  stability: "stable",
} as const;
function block(extra: Partial<BlockManifest> = {}) {
  const manifest: BlockManifest = {
    schemaVersion: "forge.block/1",
    id: "example.org/sample",
    version: "1.0.0",
    authorAbi: "forge.author/v1",
    profile: "trusted-action-sync/v1",
    entry: "index.cjs",
    docs: "docs.json",
    operations: {
      "sample.run": { ...operation, effects: [], callers: ["human", "agent"] },
    },
    ...extra,
  };
  return new CapturedBlock(
    new Map([
      ["input.json", "{}"],
      ["output.json", "{}"],
    ]),
    manifest,
  );
}
function catalog(
  captured: CapturedBlock,
  rename?: Record<string, string>,
  enabled = true,
  version = "0.1.0-dev.0",
) {
  const config: ConfigDocument = {
    schemaVersion: "forge.config/1",
    blocks: {
      sample: {
        source: { path: "./sample" },
        enabled,
        ...(rename === undefined ? {} : { rename }),
      },
    },
  };
  // Version is explicit composition input; core does not read package metadata.
  return new Catalog(config, new Map([["sample", captured]]), version);
}

test("capture refuses an intermediate directory swapped after validation", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-race-"));
  try {
    mkdirSync(join(root, "block"));
    mkdirSync(join(root, "outside"));
    mkdirSync(join(root, "block", "nested"));
    writeFileSync(join(root, "block", "nested", "entry"), "inside");
    writeFileSync(join(root, "outside", "entry"), "outside");
    const capture = createNodeFileCapture(() => {
      renameSync(join(root, "block", "nested"), join(root, "saved"));
      symlinkSync(
        join(root, "outside"),
        join(root, "block", "nested"),
        "junction",
      );
    });
    assert.throws(
      () => capture.open(join(root, "block")).value.read("nested/entry", 100),
      /INPUT_CONFLICT|INPUT_INVALID/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);

test("capture refuses a relocated root even when the opened file identity matches", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-root-race-"));
  try {
    mkdirSync(join(root, "block"));
    writeFileSync(join(root, "block", "entry"), "inside");
    const capture = createNodeFileCapture(() => {
      renameSync(join(root, "block"), join(root, "saved"));
      symlinkSync(join(root, "saved"), join(root, "block"), "junction");
    });
    assert.throws(
      () => capture.open(join(root, "block")).value.read("entry", 100),
      /INPUT_CONFLICT/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);

test("reservations apply to final renamed nouns", () => {
  assert.throws(() => catalog(block(), { sample: "catalog" }), /NAME_RESERVED/);
  assert.deepEqual(
    catalog(
      block({
        operations: {
          "catalog.run": { ...operation, effects: [], callers: ["human"] },
        },
      }),
      { catalog: "sample" },
    ).list(),
    ["sample.run"],
  );
}, 5000);

const tracker = INTERFACE_DOCUMENTS.find(
  (doc) => doc.id === "forge.tracker",
) as unknown as InterfaceDocument;
function provider() {
  return block({
    provides: [{ interface: "forge.tracker@1.0.0", noun: "sample" }],
    operations: Object.fromEntries(
      Object.entries(tracker.operations).map(([verb, expected]) => [
        `sample.${verb}`,
        {
          ...operation,
          context: expected.context,
          ...(expected.leaseMode === undefined
            ? {}
            : { leaseMode: expected.leaseMode }),
          idempotent: expected.idempotent,
          effects: expected.access === "write" ? ["sample:write"] : [],
          callers: ["human", "agent"],
        },
      ]),
    ),
  });
}
for (const defect of [
  "missing",
  "context",
  "lease",
  "idempotence",
  "access",
] as const) {
  test(`advertised interface refuses ${defect} before binding`, () => {
    const valid = provider();
    assert.ok(catalog(valid).list().length > 0);
    const operations = { ...valid.manifest.operations };
    const op = { ...operations["sample.update"]! };
    operations["sample.update"] = op;
    const manifest = { ...valid.manifest, operations };
    if (defect === "missing") delete manifest.operations["sample.update"];
    if (defect === "context") {
      op.context = "project";
      delete op.leaseMode;
    }
    if (defect === "lease") op.leaseMode = "acquire";
    if (defect === "idempotence") op.idempotent = true;
    if (defect === "access") op.effects = [];
    assert.throws(() => catalog(block(manifest)), /INTERFACE_INCOMPATIBLE/);
  }, 5000);
}

test("Forge version constraints reject incompatible blocks and accept contract comparator ranges", () => {
  assert.throws(
    () => catalog(block({ forgeVersion: ">=2.0.0 <3.0.0" })),
    /INPUT_INVALID/,
  );
  assert.deepEqual(
    catalog(block({ forgeVersion: ">=0.1.0-dev.0 <1.0.0" })).list(),
    ["sample.run"],
  );
  assert.deepEqual(
    catalog(block({ forgeVersion: ">=2.0.0" }), undefined, false).list(),
    [],
  );
  assert.throws(
    () =>
      new Catalog(
        {
          schemaVersion: "forge.config/1",
          blocks: { sample: { source: { path: "./sample" } } },
        },
        new Map([["sample", block({ forgeVersion: ">=0.0.0" })]]),
      ),
    /INPUT_INVALID/,
  );
}, 5000);
