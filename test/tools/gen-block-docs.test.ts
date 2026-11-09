import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBlockDocsIn } from "../../tools/gen/block-docs.ts";

/** A temp repo root holding one block whose docs summary is `length` characters long. */
function fixture(length: number): string {
  const root = mkdtempSync(join(tmpdir(), "forge-gen-docs-"));
  const block = join(root, "src/blocks/demo");
  mkdirSync(block, { recursive: true });
  writeFileSync(
    join(block, "forge.block.json"),
    JSON.stringify({ docs: "docs.json", operations: { "lane.close": {} } }),
  );
  writeFileSync(
    join(block, "docs.json"),
    JSON.stringify({
      operations: {
        "lane.close": { title: "Close a lane", summary: "x".repeat(length) },
      },
    }),
  );
  return root;
}

test("gen refuses a block docs summary over 300 characters, naming the block, operation and limit", () => {
  const root = fixture(301);
  try {
    expect(() => checkBlockDocsIn(root)).toThrow(
      'src/blocks/demo: Invalid input for block docs docs.json:\ndocs.json: operations["lane.close"].summary must be at most 300 characters',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("gen accepts a block docs summary of exactly 300 characters", () => {
  const root = fixture(300);
  try {
    expect(() => checkBlockDocsIn(root)).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("gen refuses a block whose docs omit a declared operation", () => {
  const root = fixture(10);
  try {
    writeFileSync(
      join(root, "src/blocks/demo/docs.json"),
      JSON.stringify({ operations: {} }),
    );
    expect(() => checkBlockDocsIn(root)).toThrow(
      'docs.json: operations["lane.close"] is required',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("every real block's docs pass the same check", () => {
  expect(() => checkBlockDocsIn()).not.toThrow();
}, 30_000);
