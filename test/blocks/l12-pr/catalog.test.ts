import { expect, test, setDefaultTimeout } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  captureBlock,
  Catalog,
  type CapturedBlock,
} from "../../../src/core/catalog/index.ts";
import { ASSEMBLY_PROVIDES } from "../../../src/assembly/providers.ts";
import { blockCapture } from "../../../src/assembly/capture.ts";
import { validateDocsRecords } from "../../../src/generated/validators.ts";
import { prConfig, ready } from "./helpers.ts";
setDefaultTimeout(10000);
test("all PR and GitHub operations capture their config, schemas, contexts and effects", () => {
  const directory = mkdtempSync(join(tmpdir(), "forge-pr-catalog-"));
  try {
    const blocks = new Map<string, CapturedBlock>();
    for (const name of ["pr", "github"]) {
      const target = join(directory, name),
        source = resolve(import.meta.dirname, `../../../src/blocks/${name}`);
      cpSync(source, target, { recursive: true });
      writeFileSync(
        join(target, "entry.cjs"),
        new Bun.Transpiler({ loader: "ts" }).transformSync(
          readFileSync(join(source, "entry.cts"), "utf8"),
        ),
      );
      const block = captureBlock(target, blockCapture);
      expect(validateDocsRecords(JSON.parse(block.text("docs.json"))).ok).toBe(
        true,
      );
      expect(block.manifest.authorAbi).toBe("forge.author/v2");
      expect(block.manifest.profile).toBe("trusted-action/v2");
      expect(block.validate("schemas/evidence.json", ready())).toBe(true);
      blocks.set(name, block);
    }
    const pr = blocks.get("pr")!;
    expect(pr.validate("schemas/config.json", prConfig)).toBe(true);
    const catalog = new Catalog(
      {
        schemaVersion: "forge.config/1",
        blocks: {
          pr: { source: { path: "./pr" } },
          github: { source: { path: "./github" } },
        },
      },
      blocks,
      undefined,
      ASSEMBLY_PROVIDES,
    );
    expect(catalog.list().length).toBe(16);
    for (const [name, block] of blocks)
      for (const [op, declaration] of Object.entries(
        block.manifest.operations,
      )) {
        if (
          [
            "pr.status",
            "pr.checks",
            "pr.threads",
            "github.status",
            "github.use",
            "github.read",
          ].includes(op)
        )
          expect(declaration.effects).toEqual([
            "external:process",
            "environment:read",
          ]);
        if (op === "pr.merge")
          expect(declaration).toMatchObject({
            context: "leased",
            leaseMode: "held",
            effects: [
              "pr:write",
              "external:write",
              "external:process",
              "environment:read",
            ],
          });
        if (op === "github.call")
          expect(declaration.effects).toEqual([
            "github:write",
            "external:write",
            "external:process",
            "environment:read",
          ]);
        expect(name.length).toBeGreaterThan(0);
      }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
