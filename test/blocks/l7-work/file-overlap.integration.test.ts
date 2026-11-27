import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import {
  laneBin,
  laneCli,
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
  "embedded",
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
      const { good } = commands;
      const id = async (title: string, file: string) =>
        String(
          (await good("issue.create", { title, expectedFiles: [file] })).id,
        );
      const first = await id("Incumbent lane", sharedFile);
      const second = await id(
        "Candidate lane",
        mode === "disjoint" ? "src/ui/other.rs" : sharedFile,
      );
      const cli = (args: string[]) =>
        laneCli(root, repo, args, "coordinator", {
          FORGE_DEVICE_ID: "lane-fixture",
        });
      const claim = (id: string) => cli(["issue", "claim", id]);
      const start = (id: string) =>
        cli(["lane", "start", "--input", JSON.stringify(laneInput(id))]);
      const checkLane = (lane: Awaited<ReturnType<typeof start>>) => {
        expect(lane.ok, JSON.stringify(lane)).toBe(true);
        expect(existsSync(join(String(lane.result.worktree), ".git"))).toBe(
          true,
        );
      };
      if (mode === "racing" || mode === "embedded") {
        const { createAssembly, localContext } = (await import(
          new URL("../../../dist/src/assembly/index.js", import.meta.url).href
        )) as typeof import("../../../src/assembly/index.ts");
        const tree = (await import(
          new URL(
            "../../../dist/src/adapters/process/process-tree.js",
            import.meta.url,
          ).href
        )) as typeof import("../../../src/adapters/process/process-tree.ts");
        const containment = (await import(
          new URL(
            "../../../dist/src/adapters/process/containment.js",
            import.meta.url,
          ).href
        )) as typeof import("../../../src/adapters/process/containment.ts");
        const options = {
          root: repo,
          deviceRoot: join(root, "device"),
          oneShot: true,
        };
        const host = await createAssembly(options);
        const other =
          mode === "embedded" ? await createAssembly(options) : host;
        const context = localContext(
          host,
          { kind: "human", id: "local-cli" },
          "coordinator",
        );
        const mcp = createMcpHandlers(
          host.mcpCatalog,
          { expose: ["lane"] },
          {
            context: {
              ...context,
              session: {
                ...context.session,
                id: "coordinator",
                device: "lane-fixture",
              },
            },
          },
        );
        const { runCli } = (await import(
          new URL("../../../dist/src/surface/cli.js", import.meta.url).href
        )) as typeof import("../../../src/surface/cli.ts");
        for (const issue of [first, second]) expect(claim(issue).ok).toBe(true);
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        let arm = false;
        let held = false;
        const pause = async () => {
          if (!arm || held) return;
          held = true;
          entered.resolve();
          await resume.promise;
        };
        const open = containment.openContainment;
        const runTree = tree.runProcessTree;
        const spies = [
          spyOn(launch, "runProcess").mockImplementation((...args) => {
            if (advisoryGit(args[1])) arm = true;
            return runProcess(...args);
          }),
          spyOn(containment, "openContainment").mockImplementation(
            async (...args) => {
              await pause();
              return open(...args);
            },
          ),
          spyOn(tree, "runProcessTree").mockImplementation(async (...args) => {
            await pause();
            return runTree(...args);
          }),
        ];
        const attach = async (id: string) =>
          mode === "racing"
            ? mcp.callTool("lane_start", laneInput(id))
            : (
                await runCli(
                  (id === first ? host : other).catalog,
                  ["lane", "start", "--input", JSON.stringify(laneInput(id))],
                  {
                    caller: "human",
                    context: {
                      ...context,
                      session: { id: "coordinator", device: "lane-fixture" },
                    },
                  },
                )
              ).envelope;
        const admitting = attach(first);
        try {
          await Promise.race([entered.promise, admitting]);
          const secondStart = await attach(second);
          expect(secondStart?.ok, JSON.stringify(secondStart)).toBe(true);
          resume.resolve();
          const lane = await admitting;
          expect(lane?.ok, JSON.stringify(lane)).toBe(true);
          for (const result of [lane, secondStart])
            expect(mapWarnings(result!)).toContainEqual({
              code: "WORK_FILE_MAP_INCOMPLETE",
              message:
                "File overlap map incomplete (advisory skipped: shared process runner). Some overlap may be missing.",
            });
          expect(held).toBe(false);
        } finally {
          resume.resolve();
          await admitting;
          for (const spy of spies) spy.mockRestore();
          if (other !== host) await other.close();
          await host.close();
        }
        return;
      }
      expect(claim(first).ok).toBe(true);
      checkLane(start(first));
      const replay = start(first);
      checkLane(replay);
      const claimed = claim(second);
      expect(claimed.ok, JSON.stringify(claimed)).toBe(true);
      const started = start(second);
      checkLane(started);
      expect(hasIncompleteMap(replay)).toBe(true);
      expect(hasIncompleteMap(started)).toBe(true);
      if (mode === "stale default policy") {
        expect(mapWarnings(claimed)).toEqual([]);
        expect(laneGit(["rev-parse", trackedDefault], repo)).toBe(stale);
        expect(started.result.base).not.toBe(stale);
        return;
      }
      {
        if (mode === "disjoint") expect(mapWarnings(claimed)).toEqual([]);
        else {
          const row = mapWarnings(claimed).find(
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
  use: (commands: Commands, repo: string, root: string) => Promise<void>,
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
    await use(commands, repo, root);
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
const hasIncompleteMap = (reply: object) =>
  mapWarnings(reply).some(({ code }) => code === "WORK_FILE_MAP_INCOMPLETE");

for (const [fault, replacement] of Object.entries({
  "I/O error":
    'throw Object.assign(new Error("Lease read failed"), { code: "EIO" });',
  "missing expiry": "return {};",
  "wrong subject":
    'return { ...read.call(this, namespace, subject), subject: "issue:work-3" };',
}))
  test(`an advisory with a lease ${fault} preserves the healthy overlap`, async () => {
    await project(async ({ good }, repo, root) => {
      const damaged = String((await good("issue.create", planned)).id);
      const candidate = String((await good("issue.create", planned)).id);
      await good("issue.create", planned);
      const incumbent = String((await good("issue.create", planned)).id);
      await good("issue.claim", { id: incumbent });
      await good("issue.claim", { id: damaged });
      const state = new URL(
        "../../../dist/src/core/state/index.js",
        import.meta.url,
      );
      const preload = `data:text/javascript,${encodeURIComponent(`
        import { StateOwner } from ${JSON.stringify(state.href)};
        const read = StateOwner.prototype.lease;
        StateOwner.prototype.lease = function (namespace, subject) {
          if (namespace === "forge/work" && subject === "issue:work-1") {
            ${replacement}
          }
          return read.call(this, namespace, subject);
        };
      `)}`;
      const result = laneCli(
        root,
        repo,
        ["issue", "claim", candidate],
        "reader",
        {
          NODE_OPTIONS: `--import=${preload}`,
        },
      );
      expect(result).toMatchObject({
        exit: 0,
        ok: true,
        result: { id: candidate },
      });
      const warnings = mapWarnings(result);
      expect(warnings.map(({ code }) => code)).toEqual([
        "WORK_FILE_MAP_INCOMPLETE",
        "WORK_FILE_OVERLAP",
      ]);
      expect(warnings[1]?.message).toContain(`overlaps ${incumbent}`);
    });
  }, 30_000);

test("the later concurrent one-shot CLI claim reports overlap before lane start", async () => {
  await project(async ({ good }, repo, root) => {
    const first = String((await good("issue.create", planned)).id);
    const second = String((await good("issue.create", planned)).id);
    const reader = JSON.stringify(
      new URL("../../../dist/src/assembly/work-map-read.js", import.meta.url)
        .href,
    );
    const moduleUrl = (source: string) =>
      `data:text/javascript,${encodeURIComponent(source)}`;
    const checkpoint = "before work-map snapshot";
    const gatedReader = moduleUrl(`
      export * from ${reader};
      import { readWorkMap as read } from ${reader};
      export async function readWorkMap(...args) {
        await new Promise((resolve) => {
          process.stdin.once("data", resolve);
          process.stderr.write(${JSON.stringify(checkpoint + "\n")});
        });
        process.stdin.pause();
        return read(...args);
      }
    `);
    const preload = moduleUrl(`
      import { registerHooks } from "node:module";
      const gatedReader = ${JSON.stringify(gatedReader)};
      registerHooks({
        resolve(specifier, context, next) {
          const resolved = next(specifier, context);
          return resolved.url === ${reader} && context.parentURL !== gatedReader
            ? { ...resolved, url: gatedReader }
            : resolved;
        },
      });
    `);
    const session = "overlap-race";
    const device = { FORGE_DEVICE_ID: "lane-fixture" };
    const startClaim = (id: string) => {
      const child = spawn(
        "node",
        ["--import", preload, laneBin, "issue", "claim", id],
        {
          cwd: repo,
          env: {
            ...process.env,
            ...device,
            FORGE_DEVICE_ROOT: join(root, "device"),
            FORGE_SESSION: session,
          },
          timeout: 15_000,
          windowsHide: true,
        },
      );
      let stdout = "";
      let stderr = "";
      const ready = Promise.withResolvers<string>();
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.includes(checkpoint + "\n")) ready.resolve(checkpoint);
      });
      const done = new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.stdin.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      });
      return { child, done, checkpoint: Promise.race([ready.promise, done]) };
    };
    const claims = [startClaim(first), startClaim(second)] as const;
    try {
      expect(
        await Promise.all(claims.map(({ checkpoint }) => checkpoint)),
      ).toEqual([checkpoint, checkpoint]);
      const replies: ResultEnvelope[] = [];
      for (const { child, done } of claims) {
        child.stdin.end("scan");
        const { code, stdout, stderr } = await done;
        expect(code, stderr + stdout).toBe(0);
        replies.push(JSON.parse(stdout) as ResultEnvelope);
      }
      expect(replies[0]).toMatchObject({ ok: true, result: { id: first } });
      expect(replies[1]).toMatchObject({ ok: true, result: { id: second } });
      const claimOverlap = mapWarnings(replies[1]!).find(
        ({ code }) => code === "WORK_FILE_OVERLAP",
      );
      expect(claimOverlap?.message ?? "").toContain(sharedFile);
      expect(claimOverlap?.message ?? "").toContain(first);
    } finally {
      for (const { child } of claims) child.kill();
      await Promise.allSettled(claims.map(({ done }) => done));
    }
    const args = [
      "lane",
      "start",
      "--input",
      JSON.stringify(laneInput(second)),
    ];
    const original = laneCli(root, repo, args, session, device);
    expect(original.ok, JSON.stringify(original)).toBe(true);
    expect(hasIncompleteMap(original)).toBe(true);
    const replay = laneCli(root, repo, args, session, device);
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    expect(replay.result.worktree).toBe(original.result.worktree);
    expect(hasIncompleteMap(replay)).toBe(true);
  });
}, 30_000);

for (const entry of ["createAssembly", "wrapper", "runLocalCommand"] as const)
  test(`embedded ${entry} claims leave the sole supervisor free for another admission`, async () => {
    await project(async ({ good }, repo, root) => {
      const first = String((await good("issue.create", planned)).id);
      const second = String(
        (
          await good("issue.create", {
            ...planned,
            expectedFiles: ["elsewhere.rs"],
          })
        ).id,
      );
      const modulePath = (name: string) =>
        JSON.stringify(
          new URL(`../../../dist/src/${name}.js`, import.meta.url).href,
        );
      const run = modulePath("adapters/process/run");
      const heldRunner = `data:text/javascript,${encodeURIComponent(`
        export * from ${run};
        import { runProcess as run } from ${run};
        export async function runProcess(executable, args, options, platform, config) {
          supervisorLimits.add(config?.supervision?.maxConcurrent);
          if (args[0] === "--no-replace-objects" || args[0] === "ls-remote" || args[0] === "pr") {
            scans++;
            const pending = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
              { ...options, signal: gate.signal }, platform, config);
            entered.resolve();
            return pending;
          }
          return run(executable, args, options, platform, config);
        }
      `)}`;
      const driver = `
        import { registerHooks } from "node:module";
        globalThis.scans = 0;
        globalThis.gate = new AbortController();
        globalThis.entered = Promise.withResolvers();
        globalThis.supervisorLimits = new Set();
        const held = ${JSON.stringify(heldRunner)};
        registerHooks({ resolve(specifier, context, next) {
          const found = next(specifier, context);
          return found.url === ${run} && context.parentURL !== held
            ? { ...found, url: held } : found;
        } });
        const { createAssembly, withLocalCommandAssembly, localCall } =
          await import(${modulePath("assembly/index")});
        const { runLocalCommand } = await import(${modulePath("assembly/command")});
        const { runCli } = await import(${modulePath("surface/cli")});
        const options = { root: process.cwd(), deviceRoot: process.env.FORGE_DEVICE_ROOT, oneShot: true };
        const left = await createAssembly(options);
        const right = await createAssembly(options);
        const claim = ["issue", "claim", ${JSON.stringify(first)}];
        const run = async (assembly, args) =>
          (await runCli(assembly.catalog, args, localCall(assembly))).envelope;
        const write = process.stdout.write;
        let text = "";
        async function importedCommand() {
          process.stdout.write = (chunk) => { text += chunk; return true; };
          try { await runLocalCommand(claim); return JSON.parse(text); }
          finally { process.stdout.write = write; }
        }
        const mode = ${JSON.stringify(entry)};
        const claiming = mode === "wrapper" ? withLocalCommandAssembly(true, (assembly) => run(assembly, claim))
          : mode === "createAssembly" ? run(left, claim) : importedCommand();
        let started;
        try {
          await Promise.race([entered.promise, claiming]);
          started = await run(right, ["lane", "start", "--input", ${JSON.stringify(JSON.stringify(laneInput(second)))}]);
        } finally { gate.abort(); }
        const claimed = await claiming;
        await Promise.all([left.close(), right.close()]);
        console.log(JSON.stringify({ ok: true, result: { claimed, started, scans, limits: [...supervisorLimits] } }));
      `;
      const result = laneCli(
        root,
        repo,
        [],
        "coordinator",
        { FORGE_DEVICE_ID: "lane-fixture" },
        ["--input-type=module", "-e", driver, "--"],
      );
      expect(result.exit).toBe(0);
      expect(result.result.claimed).toMatchObject({
        ok: true,
        result: { id: first },
      });
      expect(result.result.started).toMatchObject({
        ok: true,
        result: { issue: second },
      });
      for (const reply of [result.result.claimed, result.result.started])
        expect(hasIncompleteMap(reply as object)).toBe(true);
      expect(result.result.scans).toBe(0);
      expect(result.result.limits).toEqual([1]);
    });
  }, 30_000);

function observedCli(
  root: string,
  repo: string,
  args: string[],
  delivered?: string,
  failList = false,
) {
  const capture = join(root, "processes.log");
  writeFileSync(capture, "");
  const moduleUrl = (source: string) =>
    `data:text/javascript,${encodeURIComponent(source)}`;
  const built = (module: string) =>
    new URL(`../../../dist/src/${module}.js`, import.meta.url).href;
  const run = built("adapters/process/run");
  const providers = built("assembly/providers");
  const wrappedRun = moduleUrl(`
    export * from ${JSON.stringify(run)};
    import { runProcess as run } from ${JSON.stringify(run)};
    import { appendFileSync } from "node:fs";
    export async function runProcess(executable, args, ...tail) {
      appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args) + "\\n");
      if (${JSON.stringify(delivered ?? "")} && args[0] === "pr") {
        if (args[1] !== "view" || args[2] !== ${JSON.stringify(delivered ?? "")})
          throw new Error("Expected normalized delivered PR URL");
        return { exitCode: 0, stdout: '{"state":"OPEN","headRefName":"feat/released"}',
          stderr: "", signal: null, timedOut: false, truncated: false, durationMs: 0 };
      }
      return run(executable, args, ...tail);
    }
  `);
  const wrappedProviders = moduleUrl(`
    export * from ${JSON.stringify(providers)};
    import { resolveOutside as resolve } from ${JSON.stringify(providers)};
    export function resolveOutside(executor, name, ...tail) {
      return name === "gh" ? { kind: "resolved", path: process.execPath }
        : resolve(executor, name, ...tail);
    }
  `);
  const hooks = moduleUrl(`
    import { registerHooks } from "node:module";
    if (${failList}) {
      const { Runtime } = await import(${JSON.stringify(built("core/runtime/index"))});
      const invoke = Runtime.prototype.invoke;
      Runtime.prototype.invoke = function(request, ...rest) {
        if (request.op === "issue.list") throw new Error("Fixture issue store read failed");
        return invoke.call(this, request, ...rest);
      };
    }
    const wrappers = ${JSON.stringify({ [run]: wrappedRun, ...(delivered ? { [providers]: wrappedProviders } : {}) })};
    registerHooks({ resolve(specifier, context, next) {
      const found = next(specifier, context);
      const wrapped = wrappers[found.url];
      return wrapped && context.parentURL !== wrapped ? { ...found, url: wrapped } : found;
    } });
  `);
  const reply = laneCli(
    root,
    repo,
    args,
    "coordinator",
    { FORGE_DEVICE_ID: "lane-fixture" },
    ["--import", hooks],
  );
  const calls = readFileSync(capture, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  return { reply, calls };
}

test("a short grant skips the advisory process", async () => {
  await project(async ({ good }, repo, root) => {
    const id = String((await good("issue.create", planned)).id);
    const { reply, calls } = observedCli(root, repo, [
      "issue",
      "claim",
      "--input",
      JSON.stringify({ id, ttlSeconds: 1 }),
    ]);
    expect(reply.ok).toBe(true);
    expect(calls.filter(advisoryGit)).toEqual([]);
    expect(mapWarnings(reply)[0]?.message ?? "").toContain(
      "claim lease is too short",
    );
  });
}, 30_000);

test("a branch collision refuses before any advisory reads", async () => {
  await project(async ({ good }, repo, root) => {
    const id = String((await good("issue.create", planned)).id);
    laneGit(["branch", `feat/${id}`], repo);
    const { reply, calls } = observedCli(root, repo, [
      "lane",
      "start",
      "--input",
      JSON.stringify(laneInput(id)),
    ]);
    expect(reply.error?.code).toBe("INPUT_CONFLICT");
    expect(calls.filter(advisoryGit)).toEqual([]);
  });
}, 30_000);

test("lane starts never launch an advisory-owned remote helper", async () => {
  await project(async ({ good }, repo, root) => {
    const first = String((await good("issue.create", planned)).id);
    const second = String(
      (
        await good("issue.create", {
          ...planned,
          expectedFiles: ["elsewhere.rs"],
        })
      ).id,
    );
    const remote = laneGit(["remote", "get-url", "origin"], repo);
    laneGit(["remote", "set-url", "origin", pathToFileURL(remote).href], repo);
    for (const id of [first, second]) {
      const { reply, calls } = observedCli(root, repo, [
        "lane",
        "start",
        "--input",
        JSON.stringify(laneInput(id)),
      ]);
      expect(reply.ok, JSON.stringify(reply)).toBe(true);
      expect(existsSync(join(String(reply.result.worktree), ".git"))).toBe(
        true,
      );
      expect(calls.filter(advisoryGit)).toEqual([]);
      expect(mapWarnings(reply)[0]?.message ?? "").toContain(
        "trusted default policy unavailable",
      );
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
    expect(hasIncompleteMap(replay)).toBe(true);
  });
}, 30_000);

test("advisory authority reads stay in the invoking renamed work instance", async () => {
  await project(async ({ good }, repo, root) => {
    const first = String((await good("labissue.create", planned)).id);
    const second = String((await good("labissue.create", planned)).id);
    const claim = (id: string) =>
      laneCli(root, repo, ["labissue", "claim", id], "coordinator");
    expect(claim(first).ok).toBe(true);
    const result = claim(second);
    expect(result.ok).toBe(true);
    expect(mapWarnings(result)[0]?.message ?? "").toContain(
      `overlaps ${first}`,
    );
  }, "  zlab:\n    source: {builtin: forge/work}\n    bind: {state: core}\n    rename: {issue: labissue, attempt: labattempt, lane: lablane}\n    config: {idPrefix: lab}\n");
}, 30_000);

test("a delivered open PR with a trailing slash keeps a released holder visible", async () => {
  await project(async ({ good }, repo, root) => {
    const first = String((await good("issue.create", planned)).id);
    const second = String((await good("issue.create", planned)).id);
    const url = "https://github.com/example/overlap/pull/17/";
    await good("issue.claim", { id: first });
    await good("issue.link", { id: first, relation: "delivers", url });
    await good("issue.release", { id: first });
    const { reply, calls } = observedCli(
      root,
      repo,
      ["issue", "claim", second],
      url.slice(0, -1),
    );
    expect(reply.ok).toBe(true);
    expect(calls.find((args) => args[0] === "pr")).toEqual([
      "pr",
      "view",
      url.slice(0, -1),
      "--json",
      "state,headRefName",
    ]);
    expect(
      mapWarnings(reply).find(({ code }) => code === "WORK_FILE_OVERLAP")
        ?.message ?? "",
    ).toContain("feat/released");
  });
}, 30_000);

test("a long CLI claim refuses a PR launcher with an unknown process tree", async () => {
  await project(async ({ good }, repo, root) => {
    const holder = String((await good("issue.create", planned)).id);
    const candidate = String((await good("issue.create", planned)).id);
    await good("issue.claim", { id: holder });
    for (let n = 1; n <= 31; n++)
      await good("issue.link", {
        id: holder,
        relation: "delivers",
        url: `https://github.com/example/overlap/pull/${n}`,
      });
    await good("issue.release", { id: holder });

    const bin = mkdtempSync(join(homedir(), "forge-advisory-bin-"));
    try {
      const launches = join(root, "launcher-pids.jsonl");
      const gitTrace = join(root, "git-trace.jsonl");
      const fixture = join(root, "native-fixture.cjs");
      writeFileSync(launches, "");
      writeFileSync(gitTrace, "");
      writeFileSync(
        fixture,
        `require("node:fs").appendFileSync(${JSON.stringify(launches)},
          JSON.stringify([process.ppid, process.pid]) + "\\n");
        console.log(JSON.stringify({state: "OPEN", headRefName: "feat/released"}));`,
      );
      const windows = process.platform === "win32";
      const launcher = join(bin, windows ? "gh.cmd" : "gh");
      const forward = `"${process.execPath}" "${fixture}"`;
      writeFileSync(
        launcher,
        windows
          ? `@echo off\r\n${forward} %*\r\n`
          : `#!/bin/sh\n${forward} "$@"\nexit $?\n`,
      );
      if (!windows) chmodSync(launcher, 0o755);
      writeFileSync(
        join(bin, ".gitconfig"),
        `[trace2]\n\teventTarget = ${gitTrace.replaceAll("\\", "/")}\n`,
      );

      const result = laneCli(
        root,
        repo,
        [
          "issue",
          "claim",
          "--input",
          JSON.stringify({ id: candidate, ttlSeconds: 600 }),
        ],
        "reader",
        {
          PATH: [bin, process.env.PATH ?? process.env.Path].join(delimiter),
          PATHEXT: ".CMD;.EXE",
          HOME: bin,
          USERPROFILE: bin,
          FORGE_DEVICE_ID: "lane-fixture",
        },
      );
      expect(result).toMatchObject({
        exit: 0,
        ok: true,
        result: { id: candidate },
      });
      const trees = readFileSync(launches, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      const gitProcesses = readFileSync(gitTrace, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.includes('"event":"start"'));
      expect(gitProcesses.length).toBeGreaterThan(0);
      expect(trees, "batch/interpreter and native child PIDs").toEqual([]);
      expect(
        gitProcesses.length * (windows ? 2 : 1) + trees.length * 2,
      ).toBeLessThanOrEqual(64);
      expect(hasIncompleteMap(result)).toBe(true);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
}, 30_000);

test("a broken lane registry preserves claim overlap and reports incomplete evidence", async () => {
  await project(async ({ good }, repo, root) => {
    const first = String((await good("issue.create", planned)).id);
    const second = String((await good("issue.create", planned)).id);
    const claim = (id: string) =>
      laneCli(root, repo, ["issue", "claim", id], "coordinator");
    expect(claim(first).ok).toBe(true);
    writeFileSync(join(repo, ".git", "forge-lanes.json"), "{");
    const result = claim(second);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(mapWarnings(result).map(({ code }) => code)).toContain(
      "WORK_FILE_OVERLAP",
    );
    expect(hasIncompleteMap(result)).toBe(true);
  });
}, 30_000);

test("a failed holder read marks the successful claim incomplete", async () => {
  await project(async ({ good }, repo, root) => {
    const id = String((await good("issue.create", planned)).id);
    const { reply } = observedCli(
      root,
      repo,
      ["issue", "claim", id],
      undefined,
      true,
    );
    expect(reply.ok).toBe(true);
    expect(hasIncompleteMap(reply)).toBe(true);
  });
}, 30_000);

test("advisory authority reads do not repeat prefix discovery per issue", async () => {
  await project(async ({ good }, repo, root) => {
    for (let i = 0; i < 64; i++) await good("issue.create", planned);
    const { reply, calls } = observedCli(root, repo, [
      "issue",
      "claim",
      "sample-64",
    ]);
    expect(reply.ok).toBe(true);
    expect(
      calls.filter((args) => args.includes("remote.origin.url")),
    ).toHaveLength(1);
    expect(calls.length).toBeLessThanOrEqual(65);
  });
}, 30_000);
