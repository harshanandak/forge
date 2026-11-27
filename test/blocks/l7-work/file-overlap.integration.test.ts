import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import {
  laneCommands,
  laneGit,
  laneRepository,
} from "./lane-repository-fixture.ts";

const brief = ".worktrees/briefs/overlap.md";
const sharedFile = "src/ui/ask.rs";
const launch = (await import(
  new URL("../../../dist/src/adapters/process/run.js", import.meta.url).href
)) as typeof import("../../../src/adapters/process/run.ts");
const runProcess = launch.runProcess;
const advisoryGit = (args: readonly string[]) =>
  args[0] === "--no-replace-objects" || args[0] === "ls-remote";
const mapWarnings = (reply: object) =>
  (reply as Pick<ResultEnvelope, "warnings">).warnings.filter(({ code }) =>
    code.startsWith("WORK_FILE"),
  );

for (const mode of [
  "disjoint",
  "shared",
  "racing",
  "stale default policy",
] as const)
  test(`local CLI overlap: ${mode}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "forge-overlap-")));
    let commands: Awaited<ReturnType<typeof laneCommands>> | undefined;
    try {
      const { repo } = laneRepository(
        root,
        brief,
        mode === "stale default policy" ? { base: "main" } : {},
      );
      const configPath = join(repo, ".forge/config.yaml");
      const config = readFileSync(configPath, "utf8");
      if (mode === "stale default policy")
        writeFileSync(
          configPath,
          config.replace(
            "config: {",
            `config: { generatedFiles: [{glob: ${sharedFile}, regenerate: {argv: [fixture]}}],`,
          ),
        );
      laneGit(["add", ".forge/config.yaml"], repo);
      laneGit(["commit", "-m", "project policy"], repo);
      laneGit(["push", "origin", "main"], repo);
      const trackedDefault = "refs/remotes/origin/main";
      const stale = laneGit(["rev-parse", trackedDefault], repo);
      if (mode === "stale default policy") {
        writeFileSync(configPath, config);
        laneGit(["add", ".forge/config.yaml"], repo);
        laneGit(["commit", "-m", "stop excluding the shared file"], repo);
        laneGit(["push", "origin", "main"], repo);
        laneGit(["update-ref", trackedDefault, stale], repo);
      }
      commands = await laneCommands(root, repo);
      const { call, good } = commands;
      const id = async (title: string, file: string) =>
        String(
          (await good("issue.create", { title, expectedFiles: [file] })).id,
        );
      const first = await id("Incumbent lane", sharedFile);
      const second = await id(
        "Candidate lane",
        mode === "disjoint" ? "src/ui/other.rs" : sharedFile,
      );
      const claim = (id: string) => call("issue.claim", { id });
      const start = (id: string) =>
        call("lane.start", { id, brief, branch: `feat/${id}` });
      const checkLane = (lane: Awaited<ReturnType<typeof start>>) => {
        expect(lane.ok, JSON.stringify(lane)).toBe(true);
        expect(existsSync(join(String(lane.result.worktree), ".git"))).toBe(
          true,
        );
      };
      if (mode === "racing") {
        const both = Promise.withResolvers<void>();
        let arrivals = 0;
        const spy = spyOn(launch, "runProcess").mockImplementation(
          async (...args) => {
            if (
              advisoryGit(args[1]) &&
              args[1][1] === "rev-parse" &&
              arrivals < 2
            ) {
              if (++arrivals === 2) both.resolve();
              await both.promise;
            }
            return runProcess(...args);
          },
        );
        const replies = await Promise.all([
          claim(first),
          claim(second),
        ]).finally(() => spy.mockRestore());
        for (const reply of replies)
          expect(reply.ok, JSON.stringify(reply)).toBe(true);
        expect(
          mapWarnings(replies[0]).some(
            ({ code }) => code === "WORK_FILE_OVERLAP",
          ),
        ).toBe(true);
        expect(
          mapWarnings(replies[1]).some(
            ({ code }) => code === "WORK_FILE_OVERLAP",
          ),
        ).toBe(true);
        const lane = await start(second);
        checkLane(lane);
        const repeated = await start(second);
        checkLane(repeated);
        expect(repeated.result.worktree).toBe(lane.result.worktree);
        expect(
          mapWarnings(lane).some(({ code }) => code === "WORK_FILE_OVERLAP"),
        ).toBe(true);
        return;
      }
      expect((await claim(first)).ok).toBe(true);
      checkLane(await start(first));
      const replay = await start(first);
      checkLane(replay);
      const claimed = await claim(second);
      expect(claimed.ok, JSON.stringify(claimed)).toBe(true);
      const started = await start(second);
      checkLane(started);
      expect(mapWarnings(replay)).toEqual([]);
      if (mode === "stale default policy") {
        expect(mapWarnings(claimed)).toEqual([]);
        expect(laneGit(["rev-parse", trackedDefault], repo)).toBe(stale);
        expect(started.result.base).not.toBe(stale);
        expect(
          mapWarnings(started).find(({ code }) => code === "WORK_FILE_OVERLAP")
            ?.message ?? "",
        ).toContain(sharedFile);
        return;
      }
      for (const reply of [claimed, started]) {
        if (mode === "disjoint") expect(mapWarnings(reply)).toEqual([]);
        else {
          const row = mapWarnings(reply).find(
            ({ code }) => code === "WORK_FILE_OVERLAP",
          );
          expect(row?.message ?? "").toContain(sharedFile);
          expect(row?.message).toContain(first);
          expect(row?.message).toContain("Incumbent lane");
          expect(row?.message).toContain(`feat/${first}`);
          expect(row?.message).toMatch(/finish .* first/i);
        }
      }
    } finally {
      try {
        await commands?.dispose();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

type Commands = Awaited<ReturnType<typeof laneCommands>>;
async function project(
  use: (commands: Commands, repo: string) => Promise<void>,
  configure = "",
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "forge-advisory-")));
  let commands: Commands | undefined;
  try {
    const { repo } = laneRepository(root, brief);
    const path = join(repo, ".forge/config.yaml");
    if (configure) writeFileSync(path, readFileSync(path, "utf8") + configure);
    laneGit(["add", ".forge/config.yaml"], repo);
    laneGit(["commit", "-m", "advisory policy"], repo);
    laneGit(["push", "origin", "main"], repo);
    commands = await laneCommands(root, repo);
    await use(commands, repo);
  } finally {
    try {
      await commands?.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

const planned = { title: "Shared file", expectedFiles: [sharedFile] };
const laneInput = (id: string) => ({ id, brief, branch: `feat/${id}` });
const hasOverlap = (reply: object) =>
  mapWarnings(reply).some(({ code }) => code === "WORK_FILE_OVERLAP");

test("a short grant skips the advisory process", async () => {
  await project(async ({ call, good }) => {
    const id = String((await good("issue.create", planned)).id);
    const seen: string[] = [];
    const spy = spyOn(launch, "runProcess").mockImplementation((...args) => {
      if (advisoryGit(args[1])) seen.push(args[1][0]!);
      return runProcess(...args);
    });
    try {
      const reply = await call("issue.claim", { id, ttlSeconds: 1 });
      expect(reply.ok).toBe(true);
      expect(seen).toEqual([]);
      expect(mapWarnings(reply)[0]?.message ?? "").toContain(
        "claim lease is too short",
      );
    } finally {
      spy.mockRestore();
    }
  });
}, 30_000);

test("a branch collision refuses before any advisory reads", async () => {
  await project(async ({ call, good }, repo) => {
    const id = String((await good("issue.create", planned)).id);
    laneGit(["branch", `feat/${id}`], repo);
    let reads = 0;
    const spy = spyOn(launch, "runProcess").mockImplementation((...args) => {
      if (advisoryGit(args[1])) reads++;
      return runProcess(...args);
    });
    try {
      const reply = await call("lane.start", laneInput(id));
      expect(reply.error?.code).toBe("INPUT_CONFLICT");
      expect(reads).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
}, 30_000);

test("a paused advisory leaves another disjoint lane free to publish", async () => {
  await project(async ({ call, good }) => {
    const first = String((await good("issue.create", planned)).id);
    const second = String(
      (
        await good("issue.create", {
          ...planned,
          expectedFiles: ["elsewhere.rs"],
        })
      ).id,
    );
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let paused = false;
    const spy = spyOn(launch, "runProcess").mockImplementation(
      async (...args) => {
        if (!paused && advisoryGit(args[1])) {
          paused = true;
          entered.resolve();
          await resume.promise;
        }
        return runProcess(...args);
      },
    );
    const firstStart = call("lane.start", laneInput(first));
    try {
      await Promise.race([entered.promise, firstStart]);
      expect(paused).toBe(true);
      const next = await call("lane.start", laneInput(second));
      expect(next.ok, JSON.stringify(next)).toBe(true);
    } finally {
      resume.resolve();
      await firstStart;
      spy.mockRestore();
    }
  });
}, 30_000);

test("a successful lane replay sees a claim made after its original start", async () => {
  await project(async ({ call, good }) => {
    const first = String((await good("issue.create", planned)).id);
    const second = String((await good("issue.create", planned)).id);
    await good("issue.claim", { id: first });
    const original = await good("lane.start", laneInput(first));
    await good("issue.claim", { id: second });
    const replay = await call("lane.start", laneInput(first));
    expect(replay.ok).toBe(true);
    expect(replay.result.worktree).toBe(original.worktree);
    expect(hasOverlap(replay)).toBe(true);
  });
}, 30_000);

test("advisory authority reads stay in the invoking renamed work instance", async () => {
  await project(async ({ call, good }) => {
    const first = String((await good("labissue.create", planned)).id);
    const second = String((await good("labissue.create", planned)).id);
    await good("labissue.claim", { id: first });
    const result = await call("labissue.claim", { id: second });
    expect(result.ok).toBe(true);
    expect(mapWarnings(result)[0]?.message ?? "").toContain(
      `overlaps ${first}`,
    );
  }, "  zlab:\n    source: {builtin: forge/work}\n    bind: {state: core}\n    rename: {issue: labissue, attempt: labattempt, lane: lablane}\n    config: {idPrefix: lab}\n");
}, 30_000);

test("a delivered open PR with a trailing slash keeps a released holder visible", async () => {
  await project(async ({ call, good }) => {
    const first = String((await good("issue.create", planned)).id);
    const second = String((await good("issue.create", planned)).id);
    const url = "https://github.com/example/overlap/pull/17/";
    await good("issue.claim", { id: first });
    await good("issue.link", { id: first, relation: "delivers", url });
    await good("issue.release", { id: first });
    const spy = spyOn(launch, "runProcess").mockImplementation((...args) =>
      args[1][0] === "pr"
        ? Promise.resolve({
            exitCode: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              headRefName: "feat/released",
            }),
            stderr: "",
            signal: null,
            timedOut: false,
            truncated: false,
            durationMs: 0,
          })
        : runProcess(...args),
    );
    try {
      const result = await call("issue.claim", { id: second });
      expect(result.ok).toBe(true);
      expect(
        mapWarnings(result).find(({ code }) => code === "WORK_FILE_OVERLAP")
          ?.message ?? "",
      ).toContain("feat/released");
    } finally {
      spy.mockRestore();
    }
  });
}, 30_000);

test("advisory authority reads do not repeat prefix discovery per issue", async () => {
  await project(async ({ call, good }) => {
    for (let i = 0; i < 64; i++) await good("issue.create", planned);
    let processes = 0;
    let prefix = 0;
    const spy = spyOn(launch, "runProcess").mockImplementation((...args) => {
      processes++;
      if (args[1].includes("remote.origin.url")) prefix++;
      return runProcess(...args);
    });
    try {
      expect((await call("issue.claim", { id: "sample-64" })).ok).toBe(true);
      expect(prefix).toBe(1);
      expect(processes).toBeLessThanOrEqual(65);
    } finally {
      spy.mockRestore();
    }
  });
}, 30_000);
