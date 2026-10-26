import { expect, test } from "bun:test";
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
  type Assembly,
  createAssembly,
  localCall,
} from "../../../src/assembly/index.ts";
import { dispatch, record } from "../../../src/surface/dispatch.ts";
import { lintSkill } from "../../../src/surface/skills.ts";
import { openHarness } from "../../blocks/memory/lib.ts";

const repo = resolve(import.meta.dirname, "../../..");
const SKILLS = ["build", "land", "loop", "open-pr", "review", "slice"] as const;
const rendered = (name: string): string => `.agents/skills/${name}/SKILL.md`;

type Call = (op: string, input?: object) => Promise<Record<string, unknown>>;

/** Calls against a fresh assembly; the catalog is read once per assembly, as once per CLI call. */
async function open<T>(
  root: string,
  run: (call: Call, assembly: Assembly) => Promise<T>,
): Promise<T> {
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  const raw: Call = async (op, input = {}) => {
    const result = await dispatch(
      assembly.catalog,
      op,
      input,
      localCall(assembly),
    );
    return { ...result, ...(record(result.result) ?? {}) };
  };
  // fills in the current revision for writes
  const call: Call = async (op, input = {}) =>
    raw(
      op,
      "expectRevision" in input
        ? {
            ...input,
            expectRevision: String((await raw("config.show")).revision),
          }
        : input,
    );
  try {
    return await run(call, assembly);
  } finally {
    await assembly.close();
  }
}

/**
 * A fresh project that imported the shipped delivery template by name, as a user does; its skills
 * are read from the package. Built-in entries exist only in a build, so each imported block
 * instance is pointed at a copy of the shipped block with a stub entry; listing never runs it.
 * The installed-package journey is packed.integration.test.ts.
 */
async function withDelivery(
  run: (
    root: string,
    call: Call,
    lint: (text: string) => readonly string[],
  ) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "forge-delivery-"));
  try {
    // an npm project: check's commands come from its scripts, not from the template
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "p", scripts: { test: "node test.js" } }),
    );
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, ".forge/config.yaml"),
      JSON.stringify({ schemaVersion: "forge.config/1", blocks: {} }),
    );
    await open(root, async (call) => {
      expect(
        await call("template.import", {
          template: "delivery",
          expectRevision: "",
        }),
      ).toMatchObject({ ok: true });
      for (const name of ["work", "memory", "check"]) {
        const target = join(root, "blocks", name);
        cpSync(join(repo, "src/blocks", name), target, { recursive: true });
        const { entry } = JSON.parse(
          readFileSync(join(target, "forge.block.json"), "utf8"),
        ) as { entry: string };
        writeFileSync(join(target, entry), "module.exports={};");
        expect(
          await call("config.set", {
            path: `/blocks/${name}/source`,
            value: { path: `./blocks/${name}` },
            expectRevision: "",
          }),
        ).toMatchObject({ ok: true });
      }
    });
    await open(root, (call, assembly) =>
      run(root, call, (text) =>
        lintSkill(text, assembly.catalog.list(), undefined, 4096),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the delivery template renders all six skills: linted, at most 4 KB, values filled in", async () => {
  await withDelivery(async (root, call, lint) => {
    const synced = await call("skills.sync");
    expect(synced).toMatchObject({ ok: true });
    expect(synced.written).toEqual(
      expect.arrayContaining(SKILLS.map(rendered)),
    );
    const text = Object.fromEntries(
      SKILLS.map((name) => [
        name,
        readFileSync(join(root, rendered(name)), "utf8"),
      ]),
    );
    for (const name of SKILLS) {
      expect(lint(text[name]!)).toEqual([]);
      expect(Buffer.byteLength(text[name]!)).toBeLessThanOrEqual(4096);
      expect(text[name]).not.toContain("{{");
    }
    expect(text.loop).toContain("At most 3 workers at once");
    expect(text.loop).toContain("publish, force-push, prod-write");
    expect(text.slice).toContain("at most 5 questions");
    expect(text.slice).toContain(
      "Target 800 changed lines and at most 15 files",
    );
    expect(text.slice).toContain("Above 1500 lines, split");
    expect(text.slice).toContain("p0, p1, p2, p3, p4");
    expect(text.build).toContain('"ttlSeconds":7200');
    expect(text.loop).toContain("t3_thread_configuration");
    expect(text.loop).toContain("FORGE_SESSION=t3:<threadId>");
    expect(text.loop).toContain("every forge command");
    expect(text.build).toContain("T3 chats use the session step in `loop`");
    expect(text.build).toContain("After 2 failed fixes on the same check");
    expect(text.review).toContain("At most 2 rounds");
    expect(text.review).toContain("Fix only P0, P1 findings");
    expect(text.review).toContain("Rerun up to 1 time");
    // review threads are read and resolved with gh alone: nothing in the skills points into this repo
    expect(text.review).toContain("gh api graphql --paginate");
    expect(text.review).toContain("after:$endCursor");
    expect(text.review).toContain(
      "repos/{owner}/{repo}/pulls/<n>/comments/<comment id>/replies",
    );
    expect(text.review).toContain("resolveReviewThread(input:{threadId:$id})");
    for (const name of SKILLS)
      expect(text[name]).not.toMatch(/templates\/|\.mjs/);
    expect(text["open-pr"]).toContain('"relation":"delivers"');
    expect(text["open-pr"]).toContain("`link_pull_request`");
    // The executable gate owns the merge conditions and returns the pinned head and receipt.
    expect(text.land).toContain("forge check gate");
    expect(text.land).toContain("head moved means run the gate again");
    expect(text.land).toContain('"receipt":"<id>"');
    expect(text.build).toContain("receiptChecks");
    expect(text.slice).toContain('"withoutReceipt":"superseded by <id>"');
    expect(text.land).toContain(
      "gh pr merge <n> --squash --match-head-commit <head>",
    );
    expect(text.land).toContain("publish, force-push, prod-write");
  });
}, 30_000);

test("integration: rendered memory save and search accept a lowercase repository scope", async () => {
  await withDelivery(async (root, call) => {
    expect(await call("skills.sync")).toMatchObject({ ok: true });
    const land = readFileSync(join(root, rendered("land")), "utf8");
    const command = new RegExp("forge memory add --input '([^']+)'").exec(land);
    expect(command).not.toBeNull();
    const slice = readFileSync(join(root, rendered("slice")), "utf8");
    // gh's built-in jq ascii_downcase was also checked against Product-Suite with gh repo view.
    for (const text of [land, slice])
      expect(text).toContain(
        "gh repo view --json name --jq '.name|ascii_downcase'",
      );
    const scope = "Product-Suite".toLowerCase();
    const input = JSON.parse(
      command![1]!.replaceAll("...", "lesson").replaceAll("<name>", scope),
    ) as Record<string, unknown>;
    const search = new RegExp("forge memory search --input '([^']+)'").exec(
      slice,
    );
    expect(search).not.toBeNull();
    const searchInput = JSON.parse(
      search![1]!.replaceAll("...", "lesson").replaceAll("<name>", scope),
    ) as Record<string, unknown>;
    // Rendering uses stub entries; execute the documented input against the real memory block.
    const memory = await openHarness(["memory"]);
    try {
      expect(
        await memory.call("memory.add", input, { caller: "agent" }),
      ).toMatchObject({ ok: true, result: { note: { level: "device" } } });
      expect(
        await memory.call("memory.search", searchInput, { caller: "agent" }),
      ).toMatchObject({
        ok: true,
        result: { hits: [expect.objectContaining({ scope: "product-suite" })] },
      });
    } finally {
      await memory.close();
    }
    expect(input.scope).toBe("product-suite");
    expect(searchInput.scope).toBe(input.scope);
  });
}, 30_000);

test("rendered delivery skills do not give rule tags standing authority", async () => {
  await withDelivery(async (root, call) => {
    expect(await call("skills.sync")).toMatchObject({ ok: true });
    for (const name of SKILLS) {
      const text = readFileSync(join(root, rendered(name)), "utf8");
      expect(text).not.toContain('"tag":"rule"');
      expect(text).not.toMatch(/"tags"\s*:\s*\[[^\]]*"rule"/);
      expect(text).not.toContain('tag "rule"');
      expect(text).not.toContain("tag `rule`");
    }
  });
}, 30_000);

test("the rendered loop pages through adopted decision titles and proposals handle missing format", async () => {
  await withDelivery(async (root, call) => {
    expect(await call("skills.sync")).toMatchObject({ ok: true });
    const loop = readFileSync(join(root, rendered("loop")), "utf8");
    expect(loop).toContain(
      `forge decision list --input '{"status":"adopted"}'`,
    );
    expect(loop).toContain('"after":<next>');
    expect(loop).toContain("`truncated` is true");
    expect(loop).toContain("even if a page is empty");
    expect(loop).toContain("titles only");
    expect(loop).toContain("no decision text");
    expect(loop).toContain("see below for pagination");
    for (const name of ["land", "slice"]) {
      const text = readFileSync(join(root, rendered(name)), "utf8");
      expect(text).toContain("forge decision propose --input");
      expect(text).toContain("`format_missing`");
      expect(text).toContain("returned `repair`");
      expect(text).toContain("propose again");
      expect(text).toContain("Only after `proposed`");
      expect(text).toContain("human");
    }
  });
}, 30_000);

test("changing a value and syncing again changes the rendered skill text", async () => {
  await withDelivery(async (root, call) => {
    await call("skills.sync");
    for (const [path, value] of [
      ["/values/fixes/maxFailedPerCheck", 3],
      ["/values/slice/targetLines", 400],
    ] as const)
      expect(
        await call("config.set", { path, value, expectRevision: "" }),
      ).toMatchObject({
        ok: true,
      });
    expect(await call("skills.sync")).toMatchObject({ ok: true });
    const build = readFileSync(join(root, rendered("build")), "utf8");
    expect(build).toContain("After 3 failed fixes on the same check");
    expect(build).not.toContain("After 2 failed fixes");
    expect(readFileSync(join(root, rendered("slice")), "utf8")).toContain(
      "Target 400 changed lines",
    );
  });
}, 30_000);
