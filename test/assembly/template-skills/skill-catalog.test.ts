import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as skills from "../../../src/assembly/skills.ts";
import type { McpCandidate } from "../../../src/contract/mcp.ts";
import { candidate } from "../../surface/fixtures/catalog.ts";

test("renders the same skill bytes as a fresh sync", () => {
  type Render = (
    candidates: readonly McpCandidate[],
    prefix: string,
    templates: skills.TemplateSkills,
  ) => readonly { noun: string; path: string; bytes: Uint8Array }[];
  const root = mkdtempSync(join(tmpdir(), "forge-skill-catalog-"));
  try {
    const source = join(root, "tpl", "skills", "review");
    mkdirSync(join(source, "examples"), { recursive: true });
    const frontmatter =
      '---\nname: review\ndescription: "Use when reviewing patches."\nmetadata:\n  author: "Forge"\n---\n';
    const primary = join(source, "SKILL.md");
    const body = "Review {{values.rounds}} rounds.";
    writeFileSync(primary, `${frontmatter}\n${body}\n`);
    const companion = Uint8Array.of(0, 13, 10, 255);
    writeFileSync(join(source, "examples", "payload.bin"), companion);
    const templates = {
      sources: [{ root, file: "tpl/forge.template.json" }],
      values: { rounds: 3 },
    };
    const candidates = [candidate()];
    const render: unknown = Reflect.get(skills, "renderSkillCatalog");
    expect(render, "read-only byte renderer is exported").toBeFunction();

    const catalog = (render as Render)(candidates, "test", templates);
    expect(existsSync(join(root, ".agents"))).toBe(false);
    expect(catalog.map(({ path }) => path).sort()).toEqual([
      "review/SKILL.md",
      "review/examples/payload.bin",
      "sample/SKILL.md",
      "sample/reference.md",
    ]);
    const decoder = new TextDecoder();
    const review = catalog.find(({ path }) => path === "review/SKILL.md")!;
    expect(decoder.decode(review.bytes).startsWith(frontmatter)).toBe(true);
    expect(decoder.decode(review.bytes)).toContain("Review 3 rounds.");
    const payload = catalog.find(({ path }) => path.endsWith("/payload.bin"));
    expect(payload?.bytes).toEqual(companion);

    const synced = skills.syncSkills(
      root,
      candidates,
      "test",
      undefined,
      templates,
    );
    expect(synced.errors).toEqual([]);
    expect(synced.written).toHaveLength(catalog.length);
    for (const { noun, path, bytes } of catalog) {
      expect(path.split("/")[0]).toBe(noun);
      const onDisk = readFileSync(join(root, synced.dir, path));
      expect(bytes).toEqual(new Uint8Array(onDisk));
    }

    writeFileSync(primary, `${frontmatter}\nReview new evidence first.\n`);
    const updated = (render as Render)(candidates, "test", templates);
    const updatedReview = updated.find(({ path }) => path === review.path);
    expect(updatedReview?.bytes).not.toEqual(review.bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
