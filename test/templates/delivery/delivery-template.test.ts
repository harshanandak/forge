import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
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
import { GENERATED_MARKER, lintSkill } from "../../../src/surface/skills.ts";
import { openHarness } from "../../blocks/memory/lib.ts";

const repo = resolve(import.meta.dirname, "../../..");
const SKILLS = [
  "forge-build",
  "forge-intake",
  "forge-loop",
  "forge-land",
  "forge-review",
  "forge-cut",
] as const;
const rendered = (name: string): string => `.agents/skills/${name}/SKILL.md`;

test("intake counts its routed call before dispatch", () => {
  const text = readFileSync(
    join(repo, "templates/delivery/skills/forge-intake/SKILL.md"),
    "utf8",
  );
  expect(text).toContain("forge issue call");
  expect(text).toContain("LIMIT_REACHED");
  expect(text).toContain("intake's dispatch rules");
  expect(text).toContain("Before each dispatch, run `forge issue call");
  expect(text).toContain("Retry REVISION_CONFLICT");
  expect(text.indexOf("intake's dispatch rules")).toBeGreaterThan(
    text.indexOf("Retry REVISION_CONFLICT"),
  );
}, 30_000);

test("every harness wake reads the shared verdict and the owning session holds watches", async () => {
  await withDelivery(async (root, call, lint) => {
    await call("skills.sync");
    const texts = ["forge-build", "forge-review", "forge-loop"].map((name) => {
      const text = readFileSync(join(root, rendered(name)), "utf8");
      expect(lint(text)).toEqual([]);
      expect(text).toContain("forge pr state <n>");
      expect(text).toContain("verdict");
      return text;
    });
    const handoff = readFileSync(
      join(root, ".agents/skills/forge-build/pull-request.md"),
      "utf8",
    );
    expect(handoff).toMatch(/owning session.*forge agent wait/i);
    const all = [...texts, handoff].join("\n");
    expect(all).not.toMatch(/watch_pull_request|Claude Code|Codex|\bT3\b/);
  });
}, 30_000);

test("S5 sync retires four stage skills, preserves notes and ships proof and thread companions", async () => {
  await withDelivery(async (root, call, lint) => {
    await call("config.set", {
      path: "/blocks/agent/config/adapters",
      value: [
        { id: "agents", detect: [], skills: ".agents/skills" },
        { id: "claude", detect: [], skills: ".claude/skills" },
      ],
      expectRevision: "",
    });
    for (const adapter of [".agents", ".claude"]) {
      for (const old of ["build", "open-pr", "review", "land"]) {
        const folder = join(root, adapter, "skills", old);
        mkdirSync(folder, { recursive: true });
        writeFileSync(
          join(folder, "SKILL.md"),
          `${GENERATED_MARKER}\nold stage\n`,
        );
      }
      writeFileSync(
        join(root, adapter, "skills/review/NOTES.md"),
        "user notes\n",
      );
    }
    expect(await call("skills.sync")).toMatchObject({ ok: true });
    for (const adapter of [".agents", ".claude"]) {
      for (const old of ["build", "open-pr", "review", "land"])
        expect(existsSync(join(root, adapter, "skills", old, "SKILL.md"))).toBe(
          false,
        );
      expect(
        readFileSync(join(root, adapter, "skills/review/NOTES.md"), "utf8"),
      ).toBe("user notes\n");
      for (const name of ["forge-build", "forge-review", "forge-land"]) {
        const text = readFileSync(
          join(root, adapter, "skills", name, "SKILL.md"),
          "utf8",
        );
        expect(lint(text)).toEqual([]);
        if (name === "forge-review") {
          expect(text).toContain(
            "<!-- forge companions: list-threads.mjs, reply-and-resolve.mjs -->",
          );
          for (const helper of ["list-threads.mjs", "reply-and-resolve.mjs"])
            expect(
              readFileSync(join(root, adapter, "skills", name, helper), "utf8"),
            ).toBe(
              readFileSync(
                join(repo, "templates/delivery/skills", name, helper),
                "utf8",
              ),
            );
          for (const phrase of [
            "forge route get review",
            "forge issue call",
            "single-family",
            "conflicts, then threads, then CI",
            "Fixed in <sha>",
            "one push wave",
            "harness wake",
            "sleep loop",
            "clean behind-base update",
            "merge base locally",
            "retry only `resolveReviewThread`",
            "gh repo view --json owner,name",
            "Other old threads wait for new evidence",
            "Retry REVISION_CONFLICT",
          ])
            expect(text).toContain(phrase);
        }
        if (name === "forge-build")
          for (const phrase of [
            "light 0-1",
            "standard 2-3",
            "heavy 4-5",
            "45 minutes",
            "forge issue call",
            "stopBy",
            "stop at push",
            "named environment variables only",
            "trunk and head",
            "fresh-context review",
            "new assertion",
            "built artifact",
            "independent",
            "an empty field blocks the call",
            "stop and report the checkpoint when timeboxMinutes expire",
            "never later than stopBy",
            "CI carries remaining project checks",
          ])
            expect(text).toContain(phrase);
        if (name === "forge-land")
          for (const phrase of [
            "serial",
            "zero red checks, open threads and open doors",
            '"fix all"',
            "--match-head-commit",
            "forge check gate",
          ])
            expect(text).toContain(phrase);
      }
    }
    expect(await call("skills.sync", { check: true })).toMatchObject({
      ok: true,
    });
  });
}, 30_000);

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
      for (const name of ["work", "memory", "check", "agent"]) {
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

test("delivery sync replaces loop with forge-loop and forge-intake", async () => {
  await withDelivery(async (root, call, lint) => {
    const synced = await call("skills.sync");
    expect(synced).toMatchObject({ ok: true });
    expect(synced.written).toEqual(
      expect.arrayContaining([
        rendered("forge-loop"),
        rendered("forge-intake"),
      ]),
    );
    expect(existsSync(join(root, rendered("loop")))).toBe(false);
    const router = readFileSync(join(root, rendered("forge-loop")), "utf8");
    const intake = readFileSync(join(root, rendered("forge-intake")), "utf8");
    expect(router).toContain("disable-model-invocation: true");
    expect(router).toContain("vague intent");
    expect(router).toContain("`forge-intake`");
    expect(intake).toContain("disable-model-invocation: false");
    expect(intake).toContain("forge route get <role> --text");
    expect(lint(router)).toEqual([]);
    expect(lint(intake)).toEqual([]);
    const credits = readFileSync(join(repo, "CREDITS"), "utf8");
    for (const source of ["grilling", "ask-matt"])
      expect(credits).toContain(source);
    expect(credits).toContain("https://github.com/mattpocock/skills");
    expect(credits).toContain("MIT");
  });
}, 30_000);

test("forge-cut replaces marked slice copies while keeping user notes in both adapters", async () => {
  await withDelivery(async (root, call, lint) => {
    expect(
      await call("config.set", {
        path: "/blocks/agent/config/adapters",
        value: [
          { id: "agents", detect: [], skills: ".agents/skills" },
          { id: "claude", detect: [], skills: ".claude/skills" },
        ],
        expectRevision: "",
      }),
    ).toMatchObject({ ok: true });
    for (const adapter of [".agents", ".claude"]) {
      const folder = join(root, adapter, "skills/slice");
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "SKILL.md"),
        `${GENERATED_MARKER}\nold slice\n`,
      );
      writeFileSync(join(folder, "NOTES.md"), "user notes\n");
    }
    expect(await call("skills.sync")).toMatchObject({ ok: true });
    for (const adapter of [".agents", ".claude"]) {
      const folder = join(root, adapter, "skills");
      expect(existsSync(join(folder, "slice/SKILL.md"))).toBe(false);
      expect(readFileSync(join(folder, "slice/NOTES.md"), "utf8")).toBe(
        "user notes\n",
      );
      const cut = readFileSync(join(folder, "forge-cut/SKILL.md"), "utf8");
      expect(lint(cut)).toEqual([]);
      const create = new RegExp("forge issue create --input '([^']+)'").exec(
        cut,
      );
      expect(create).not.toBeNull();
      expect(JSON.parse(create![1]!)).toMatchObject({
        parent: "<intent id>",
        dependsOn: ["<dep id>"],
      });
      expect(cut).toContain("otherwise the epic");
      expect(cut).toContain("For later edits");
      expect(cut).toContain("forge issue release");
      expect(cut).toContain("forge companions: framing.md");
      expect(cut).toContain("[framing.md](framing.md)");
      expect(
        Buffer.byteLength(
          readFileSync(
            join(repo, "templates/delivery/skills/forge-cut/SKILL.md"),
            "utf8",
          ).replace(/\r\n/g, "\n"),
        ),
      ).toBeLessThanOrEqual(2815);
      for (const rule of [
        "400 changed lines",
        "above 800",
        "deletions exceed twice the additions",
        "churn over 518 lines +2",
        "over 10 files +2",
        "`core` or `blocks` +1",
        "light 0-1",
        "standard 2-3",
        "heavy 4-5",
        "demoable",
        "one-context",
        "prefactors",
        "expand, migrate in batches, then contract",
        "forge issue dep",
      ])
        expect(cut).toContain(rule);
      expect(cut.indexOf("Before filing")).toBeLessThan(
        cut.indexOf("forge issue create"),
      );
    }
    expect(await call("skills.sync", { check: true })).toMatchObject({
      ok: true,
    });
  });
}, 30_000);

test("intake prototypes answer a named question and report evidence on the intent issue", async () => {
  await withDelivery(async (root, call) => {
    await call("skills.sync");
    const intake = readFileSync(join(root, rendered("forge-intake")), "utf8");
    for (const rule of [
      "only running code can answer",
      "Name the question first",
      "one session",
      "300 lines",
      "prototype/<name>",
      "scratch folder",
      "no tests or polish",
      "verdict",
      "output, timing or screenshot",
      "branch pointer",
      "comment on the intent issue",
      "validated snippet",
      "never merges",
      "`forge-cut`",
    ])
      expect(intake).toContain(rule);
    const credits = readFileSync(join(repo, "CREDITS"), "utf8");
    for (const source of ["to-tickets", "prototype"])
      expect(credits).toContain(`skills/engineering/${source}`);
  });
}, 30_000);

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
    // Check the installed PR companion too: the folded stage keeps its caller contract.
    text["forge-build"] += readFileSync(
      join(root, ".agents/skills/forge-build/pull-request.md"),
      "utf8",
    );
    expect(text["forge-loop"]).toContain("At most 3 workers at once");
    expect(text["forge-loop"]).toContain("publish, force-push, prod-write");
    expect(text["forge-cut"]).toContain(
      "Route open decisions to `forge-intake`",
    );
    expect(text["forge-cut"]).toContain(
      "unclear goal or done condition to forge-intake",
    );
    expect(text["forge-cut"]).not.toContain("Silence means every default");
    expect(text["forge-cut"]).not.toContain("at most 5");
    expect(text["forge-cut"]).toContain("Aim at 400 changed lines");
    expect(text["forge-cut"]).toContain("split above 800");
    expect(text["forge-cut"]).toContain("p0, p1, p2, p3, p4");
    expect(text["forge-build"]).toContain(
      `forge issue claim --input '{"id":"<slice>"}'`,
    );
    expect(text["forge-loop"]).toContain("t3_thread_configuration");
    expect(text["forge-loop"]).toContain("FORGE_SESSION=t3:<threadId>");
    expect(text["forge-loop"]).toContain("every forge command");
    expect(text["forge-loop"]).toContain(
      "Workers you launch keep their own task session",
    );
    expect(text["forge-loop"]).toContain(
      "Session: export FORGE_SESSION=<your task name> before any claim; never use the chat's t3: session.",
    );
    expect(text["forge-build"]).not.toContain("`forge-loop`");
    expect(text["forge-build"]).toContain("t3_thread_configuration");
    expect(text["forge-build"]).toContain("FORGE_SESSION=t3:<threadId>");
    expect(text["forge-build"]).toContain("forge memory rules");
    expect(text["forge-build"]).toContain(
      "`result.text.text` is a pointer, never note text",
    );
    expect(text["forge-build"]).toContain(
      "After 2 failed fixes on the same check",
    );
    expect(text["forge-review"]).toContain("At most 2 rounds");
    expect(text["forge-review"]).toContain("Fix only P0, P1 findings");
    expect(text["forge-review"]).toContain("Rerun up to 1 time");
    // Companion scripts travel with the generated skill; commands use their installed paths.
    expect(text["forge-review"]).toContain("list-threads.mjs");
    expect(text["forge-review"]).toContain("reply-and-resolve.mjs");
    expect(text["forge-review"]).not.toContain("gh api graphql");
    for (const name of SKILLS) expect(text[name]).not.toContain("templates/");
    expect(text["forge-build"]).toContain('"relation":"delivers"');
    expect(text["forge-build"]?.match(/`forge agent wait <n>`/g)).toHaveLength(
      1,
    );
    expect(text["forge-build"]).toMatch(
      /forge issue release[\s\S]*Last action: the owning session runs `forge agent wait <n>`/,
    );
    expect(text["forge-build"]).toContain(
      "git worktree add <path> -b <branch> origin/main",
    );
    expect(text["forge-build"]).toContain("then the project's install");
    expect(text["forge-review"]).toContain(
      "run `forge pr state <n>` and act on `verdict`",
    );
    for (const name of ["forge-review", "forge-loop"]) {
      expect(text[name]).toContain(
        "After each push, run `forge agent wait <n>`",
      );
      expect(text[name]).toContain("`t3-tool`, skip its steps");
    }
    expect(text["forge-loop"]).toContain(
      "Only when resuming a session with existing PR work",
    );
    expect(text["forge-loop"]).toContain(
      "Use `--fallback` only if a plain opening wait's link or watch step fails.",
    );
    expect(text["forge-loop"]).toContain(
      "Report and skip a failed `--sweep` or `--done` step.",
    );
    expect(text["forge-loop"]).toContain("act without re-arming event watches");
    expect(text["forge-loop"]).toContain("unmerged close or handback");
    for (const name of ["forge-land", "forge-loop"])
      expect(text[name]).toContain("forge agent wait <n> --done");
    expect(
      existsSync(join(root, ".agents/skills/forge-build/done-claim.mjs")),
    ).toBe(true);
    // The executable gate owns the merge conditions and returns the pinned head and receipt.
    expect(text["forge-land"]).toContain("forge check gate");
    expect(text["forge-land"]).toContain("head moved means run the gate again");
    expect(text["forge-land"]).toContain('"receipt":"<id>"');
    expect(text["forge-build"]).toContain("receiptChecks");
    expect(text["forge-cut"]).toContain(
      '"withoutReceipt":"superseded by <id>"',
    );
    expect(text["forge-land"]).toContain(
      "gh pr merge <n> --squash --match-head-commit <head>",
    );
    expect(text["forge-land"]).toContain("publish, force-push, prod-write");
  });
}, 30_000);

test("rendered forge-build Models requires exact model attribution for each stage", async () => {
  await withDelivery(async (root, call) => {
    expect(await call("skills.sync")).toMatchObject({ ok: true });
    const text = readFileSync(
      join(root, ".agents/skills/forge-build/pull-request.md"),
      "utf8",
    );
    const models = text
      .split("\n")
      .find((line) => line.startsWith("- **Models**:"));
    expect(models).toBeDefined();
    for (const requirement of [
      /display\s+name/i,
      /model\s+id/i,
      /reasoning\s+level/i,
      /harness/i,
      /\bplanned\b/i,
      /\bimplemented\b/i,
      /\breviewed\b/i,
      /not yet reviewed/i,
      /roles?\s+alone\b.*\bnot\s+allowed/i,
      /no tool-branding footer/i,
    ])
      expect(models).toMatch(requirement);
  });
}, 30_000);

test("PR template Models slots require the same attribution fields for each stage", () => {
  const text = readFileSync(
    join(repo, ".github/pull_request_template.md"),
    "utf8",
  );
  for (const stage of ["Planned", "Implemented", "Reviewed"]) {
    const slot = text.match(new RegExp(`^- ${stage}: (.+)$`, "im"))?.[1];
    expect(slot).toBeDefined();
    for (const field of [
      /<display name>/i,
      /<model id>/i,
      /reasoning\s+<level>/i,
      /via\s+<harness>/i,
    ])
      expect(slot).toMatch(field);
    if (stage === "Reviewed") expect(slot).toMatch(/not yet reviewed/i);
  }
}, 30_000);

test("integration: rendered memory save and search accept a lowercase repository scope", async () => {
  await withDelivery(async (root, call) => {
    expect(await call("skills.sync")).toMatchObject({ ok: true });
    const land = readFileSync(join(root, rendered("forge-land")), "utf8");
    const command = new RegExp("forge memory add --input '([^']+)'").exec(land);
    expect(command).not.toBeNull();
    const slice = readFileSync(
      join(root, ".agents/skills/forge-cut/framing.md"),
      "utf8",
    );
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
      const text =
        readFileSync(join(root, rendered(name)), "utf8") +
        (name === "forge-cut"
          ? readFileSync(
              join(root, ".agents/skills/forge-cut/framing.md"),
              "utf8",
            )
          : "");
      expect(text).not.toContain('"tag":"rule"');
      expect(text).not.toMatch(/"tags"\s*:\s*\[[^\]]*"rule"/);
      expect(text).not.toContain('tag "rule"');
      expect(text).not.toContain("tag `rule`");
    }
  });
}, 30_000);

test("the rendered forge-loop pages through adopted decision titles and proposals handle missing format", async () => {
  await withDelivery(async (root, call) => {
    expect(await call("skills.sync")).toMatchObject({ ok: true });
    const loop = readFileSync(join(root, rendered("forge-loop")), "utf8");
    expect(loop).toContain("forge memory rules");
    expect(loop).toContain("unless a hook supplied it");
    expect(loop).toContain(
      `forge decision list --input '{"status":"adopted"}'`,
    );
    expect(loop).toContain('"after":<next>');
    expect(loop).toContain("`truncated` is true");
    expect(loop).toContain("even if a page is empty");
    expect(loop).toContain("titles only");
    expect(loop).toContain("no decision text");
    expect(loop).toContain("see below for pagination");
    expect(loop).toContain("`forge-build`'s Worker brief");
    expect(loop).not.toContain("End state:");
    for (const name of ["forge-land", "forge-cut"]) {
      const text = readFileSync(
        join(
          root,
          name === "forge-cut"
            ? ".agents/skills/forge-cut/framing.md"
            : rendered(name),
        ),
        "utf8",
      );
      expect(text).toContain("forge decision propose --input");
      expect(text).toContain("`format_missing`");
      expect(text).toContain("returned `repair`");
      expect(text).toContain("propose again");
      expect(text).toContain("Only after `proposed`");
      expect(text).toContain("human");
    }
  });
}, 30_000);

test("stale guidance values do not change the rendered delivery instructions", async () => {
  await withDelivery(async (root, call) => {
    await call("skills.sync");
    for (const [path, value] of [
      ["/values/fixes/maxFailedPerCheck", 3],
      ["/values/slice/targetLines", 999],
    ] as const)
      expect(
        await call("config.set", { path, value, expectRevision: "" }),
      ).toMatchObject({
        ok: true,
      });
    expect(await call("skills.sync")).toMatchObject({ ok: true });
    const build = readFileSync(join(root, rendered("forge-build")), "utf8");
    expect(build).toContain("After 2 failed fixes on the same check");
    expect(build).not.toContain("After 3 failed fixes");
    const cut = readFileSync(join(root, rendered("forge-cut")), "utf8");
    expect(cut).toContain("Aim at 400 changed lines");
    expect(cut).not.toContain("999");
  });
}, 30_000);

const GUIDANCE = [
  ["slice.targetLines", "forge-cut", "Aim at 400 changed lines"],
  ["slice.splitAbove", "forge-cut", "split above 800"],
  ["slice.maxFiles", "forge-cut", "over 10 files +2"],
  ["review.rounds", "forge-review", "At most 2 rounds"],
  ["review.fix", "forge-review", "Fix only P0, P1 findings"],
  ["review.file", "forge-review", "Everything else (P2, P3"],
  ["review.reruns", "forge-review", "Rerun up to 1 time"],
  ["merge.by", "forge-land", "Merge by: agent"],
  ["merge.method", "forge-land", "gh pr merge <n> --squash"],
  [
    "doors",
    "forge-loop",
    "publish, force-push, prod-write, migration-apply, delete-branch, delete-worktree, merge-to-autodeploy, global-config",
  ],
  [
    "fixes.maxFailedPerCheck",
    "forge-build",
    "After 2 failed fixes on the same check",
  ],
  ["lanes.max", "forge-loop", "At most 3 workers at once"],
  ["lanes.fullSuiteRuns", "forge-loop", "1 full-suite run at a time"],
  ["lanes.stallMinutes", "forge-loop", "silent for 10 minutes"],
  [
    "labels.priority",
    "forge-cut",
    "Priority is one label of p0, p1, p2, p3, p4",
  ],
  ["labels.deferred", "forge-review", '"review-deferred"'],
  ["labels.gap", "forge-build", "`contract-gap` issue"],
  ["roles.orchestrator", "forge-loop", "orchestrator strong"],
  ["roles.implementer", "forge-loop", "implementer fast"],
  ["roles.reviewer", "forge-loop", "reviewer other-family"],
  ["roles.housekeeping", "forge-loop", "housekeeping cheapest"],
  [
    "pr.models",
    "forge-build",
    "**Models**: for each of planned, implemented and reviewed",
  ],
  ["pr.notVerified", "forge-build", "**Not verified**: what you did not check"],
  ["pr.trailers", "forge-build", "trailers: none"],
  [
    "pr.style",
    "forge-build",
    "Style: plain opening; bold takeaways; What review found; Verification",
  ],
] as const;

test("skills sync warns about the legacy claim default until it is explicitly moved", async () => {
  await withDelivery(async (root, call) => {
    expect(
      await call("config.apply", {
        expectRevision: "",
        patch: [
          { op: "remove", path: "/blocks/work/config/claimTtlSeconds" },
          { op: "set", path: "/values/claims/ttlSeconds", value: 7200 },
        ],
      }),
    ).toMatchObject({ ok: true });
    const file = join(root, ".forge/config.yaml");
    const before = readFileSync(file, "utf8");
    expect(await call("skills.sync")).toMatchObject({
      ok: true,
      warnings: [
        {
          code: "CLAIM_TTL_CONFIG_MOVE",
          message:
            "Move /values/claims/ttlSeconds to /blocks/work/config/claimTtlSeconds with value 7200 to preserve the claim lease duration.",
        },
      ],
    });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(
      await call("config.set", {
        path: "/blocks/work/config/claimTtlSeconds",
        value: 123,
        expectRevision: "",
      }),
    ).toMatchObject({ ok: true });
    const configured = readFileSync(file, "utf8");
    expect(await call("skills.sync")).toMatchObject({ ok: true, warnings: [] });
    expect(readFileSync(file, "utf8")).toBe(configured);
  });
}, 30_000);

test("the upgraded delivery template is listed as a new version and this repo keeps two-hour claims", async () => {
  await withDelivery(async (_root, call) => {
    const listed = await call("template.list");
    expect(listed.ok).toBe(true);
    expect(listed.templates).toContainEqual(
      expect.objectContaining({ id: "harsha/delivery", version: "0.1.2" }),
    );
    expect(readFileSync(join(repo, ".forge/config.yaml"), "utf8")).toContain(
      "      claimTtlSeconds: 7200",
    );
  });
}, 30_000);

test("every delivery guidance value is literal skill prose, absent from template configuration", async () => {
  await withDelivery(async (root, call) => {
    expect(await call("skills.sync")).toMatchObject({ ok: true });
    const template = JSON.parse(
      readFileSync(
        join(repo, "templates/delivery/forge.template.json"),
        "utf8",
      ),
    ) as { config: { values?: unknown } };
    expect(template.config.values).toBeUndefined();
    expect(template.config).toMatchObject({
      blocks: { work: { config: { claimTtlSeconds: 7200 } } },
    });
    for (const [path, skill, guidance] of GUIDANCE) {
      const source = readFileSync(
        join(repo, `templates/delivery/skills/${skill}/SKILL.md`),
        "utf8",
      );
      expect(source).not.toContain(`{{values.${path}}}`);
      const guidanceText =
        readFileSync(join(root, rendered(skill)), "utf8") +
        (skill === "forge-build"
          ? readFileSync(
              join(root, ".agents/skills/forge-build/pull-request.md"),
              "utf8",
            )
          : "");
      expect(guidanceText).toContain(guidance);
    }
    for (const name of SKILLS)
      expect(
        readFileSync(
          join(repo, `templates/delivery/skills/${name}/SKILL.md`),
          "utf8",
        ),
      ).not.toContain("{{");
  });
}, 30_000);
