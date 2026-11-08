// Where the memory and start-up time of one command go: V8 heap spaces, native memory, the modules
// loaded, same-job A/B builds, the cost of starting a program, and a CPU profile split.
// Not a gate. Run after `bun run build`: `node tools/bench/footprint.ts`.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const folder = mkdtempSync(join(tmpdir(), "forge-footprint-"));
const project = join(folder, "project");
const copies: string[] = [];
mkdirSync(join(project, ".forge"), { recursive: true });
writeFileSync(
  join(project, ".forge/config.yaml"),
  [
    "schemaVersion: forge.config/1",
    "blocks:",
    "  work:",
    "    source:",
    "      builtin: forge/work",
    "  memory:",
    "    source:",
    "      builtin: forge/memory",
    "  check:",
    "    source:",
    "      builtin: forge/check",
    "    config:",
    "      commands:",
    "        probe: node --version",
    "",
  ].join("\n"),
);
writeFileSync(join(folder, "gitconfig"), "");
const dump = join(folder, "dump.json");
const preload = join(folder, "dump.mjs");
writeFileSync(
  preload,
  [
    'import { registerHooks, syncBuiltinESMExports } from "node:module";',
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import v8 from "node:v8";',
    'import vm from "node:vm";',
    "const loaded = [];",
    "const events = [];",
    "const mark = (label) => events.push([label, process.memoryUsage.rss() / 1048576]);",
    'mark("start");',
    'registerHooks({ load(url, context, next) { loaded.push(url); mark("load " + url); return next(url, context); } });',
    'const makeContext = vm.createContext; vm.createContext = function (...a) { mark("vm.createContext"); try { return makeContext.apply(this, a); } finally { mark("vm.createContext done"); } };',
    'const runScript = vm.Script.prototype.runInContext; vm.Script.prototype.runInContext = function (...a) { mark("vm run"); try { return runScript.apply(this, a); } finally { mark("vm run done"); } };',
    "syncBuiltinESMExports();",
    'process.on("exit", () => {',
    "  const mb = (bytes) => Math.round(bytes / 104857.6) / 10;",
    "  const memory = process.memoryUsage();",
    "  const status = {};",
    "  try { for (const line of readFileSync('/proc/self/status', 'utf8').split(String.fromCharCode(10))) { const i = line.indexOf(':'); const key = line.slice(0, i); if (['VmRSS', 'RssAnon', 'RssFile', 'RssShmem', 'VmData'].includes(key)) status[key] = Math.round(parseInt(line.slice(i + 1).trim(), 10) / 102.4) / 10; } } catch {}",
    "  const space = Object.fromEntries(v8.getHeapSpaceStatistics().map((s) => [s.space_name, mb(s.space_size)]));",
    "  writeFileSync(process.env.FORGE_FOOTPRINT, JSON.stringify({",
    "    peak: mb(process.resourceUsage().maxRSS * 1024), heapUsed: mb(memory.heapUsed), heapTotal: mb(memory.heapTotal),",
    "    external: mb(memory.external), arrayBuffers: mb(memory.arrayBuffers),",
    "    newSpace: space.new_space, oldSpace: space.old_space, codeSpace: space.code_space, loaded, events, status,",
    "  }));",
    "});",
    "",
  ].join("\n"),
);
const env: Record<string, string> = {
  FORGE_DEVICE_ROOT: join(folder, "device"),
  FORGE_DEVICE_ID: "footprint",
  FORGE_SESSION: "footprint",
  FORGE_FOOTPRINT: dump,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(folder, "gitconfig"),
};
for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "TEMP", "TMP"])
  if (process.env[name] !== undefined) env[name] = process.env[name];

interface Report {
  peak: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  newSpace: number;
  oldSpace: number;
  codeSpace: number;
  loaded: string[];
  events: [string, number][];
  status: Record<string, number>;
}

function run(
  bin: string,
  args: readonly string[],
): { stdout: string; ms: number; report: Report } {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, bin, ...args],
    { cwd: project, env, encoding: "utf8", timeout: 60_000, windowsHide: true },
  );
  const ms = performance.now() - started;
  if (result.error || result.status !== 0)
    throw new Error(
      `forge ${args.join(" ")} failed (${result.status}): ${result.error?.message ?? result.stderr}`,
    );
  return {
    stdout: result.stdout,
    ms,
    report: JSON.parse(readFileSync(dump, "utf8")) as Report,
  };
}

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

/** A copy of the shipped dist beside it (the package's own node_modules still resolve), changed by `edit`. */
function variantBin(
  name: string,
  edit: (dir: string) => void,
  source: string = join(root, "dist"),
): string {
  // A new, uniquely named folder beside dist (the package's own node_modules still resolve from
  // there). Only folders made here are recorded, so cleanup never touches one that already existed.
  const dir = mkdtempSync(join(root, `${name}-`));
  copies.push(dir);
  cpSync(source, dir, { recursive: true });
  edit(dir);
  return join(dir, "bin/forge.js");
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string };
  children?: number[];
}

/** Self time by kind of work, plus the inclusive time of a few named steps. */
function profileSummary(path: string): string[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as {
    nodes: ProfileNode[];
    samples: number[];
    timeDeltas: number[];
  };
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of data.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id);
  const kind = (node: ProfileNode): string => {
    const { functionName, url } = node.callFrame;
    if (functionName === "(idle)") return "idle (waiting on a child or I/O)";
    if (functionName === "(garbage collector)") return "garbage collection";
    if (
      /node:internal\/(?:modules|process\/esm_loader|bootstrap\/realm)|node:internal\/url/.test(
        url,
      )
    )
      return "module loading and resolution";
    if (
      /dist\/src\/(?:contract|generated)\//.test(url) ||
      /declarations\.js$/.test(url)
    )
      return "schema and contract setup";
    if (url.includes("config-yaml")) return "yaml";
    if (url.includes("/dist/src/")) return "forge code";
    return "node internals and native calls";
  };
  const own = new Map<string, number>();
  const inclusive = new Map<string, number>();
  const named: readonly (readonly [string, RegExp])[] = [
    ["reading and checking block files", /^captureBlock$/],
    ["running git (process adapter)", /^runProcess$/],
    ["opening the Windows job and koffi", /^(?:openWindowsJob|loadNativeApi)$/],
    ["project detection", /^detectProject$/],
  ];
  let total = 0;
  data.samples.forEach((id, index) => {
    const ms = (data.timeDeltas[index] ?? 0) / 1000;
    total += ms;
    const label = kind(nodes.get(id)!);
    own.set(label, (own.get(label) ?? 0) + ms);
    const seen = new Set<string>();
    for (
      let at: number | undefined = id;
      at !== undefined;
      at = parent.get(at)
    ) {
      const name = nodes.get(at)!.callFrame.functionName;
      for (const [step, pattern] of named)
        if (!seen.has(step) && pattern.test(name)) {
          seen.add(step);
          inclusive.set(step, (inclusive.get(step) ?? 0) + ms);
        }
    }
  });
  // The biggest native and Node-internal frames, with the Forge or package code that called them.
  const native = new Map<string, { ms: number; from: Map<string, number> }>();
  data.samples.forEach((id, index) => {
    const node = nodes.get(id)!;
    if (kind(node) !== "node internals and native calls") return;
    const ms = (data.timeDeltas[index] ?? 0) / 1000;
    const where = (n: ProfileNode): string =>
      `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").slice(-2).join("/")}`;
    let caller = "(no Forge or package frame)";
    for (let at = parent.get(id); at !== undefined; at = parent.get(at)) {
      const up = nodes.get(at)!;
      if (/dist\/src\/|node_modules/.test(up.callFrame.url)) {
        caller = where(up);
        break;
      }
    }
    const label = node.callFrame.functionName || "(anonymous)";
    const entry = native.get(label) ?? { ms: 0, from: new Map() };
    entry.ms += ms;
    entry.from.set(caller, (entry.from.get(caller) ?? 0) + ms);
    native.set(label, entry);
  });
  const nativeRows = [...native]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, 14)
    .map(([name, entry]) => {
      const top = [...entry.from].sort((a, b) => b[1] - a[1])[0]!;
      return `| \`${name}\` | ${entry.ms.toFixed(1)} | ${top[0]} (${top[1].toFixed(1)}) |`;
    });
  return [
    "CPU profile of one `issue show` (self time in ms; the profile adds overhead):",
    "",
    "| Kind of work | ms | Share |",
    "| ------------ | -: | ----: |",
    ...[...own]
      .sort((a, b) => b[1] - a[1])
      .map(
        ([name, ms]) =>
          `| ${name} | ${ms.toFixed(0)} | ${((100 * ms) / total).toFixed(0)}% |`,
      ),
    "",
    "Inclusive time of named steps (they overlap the rows above):",
    "",
    ...[...inclusive].map(([name, ms]) => `- ${name}: ${ms.toFixed(0)} ms`),
    "",
    'Top frames inside "node internals and native calls" (self ms, and the Forge or package code that called them):',
    "",
    "| Frame | ms | Main caller (ms) |",
    "| ----- | -: | ---------------- |",
    ...nativeRows,
    "",
  ];
}

const lines: string[] = [];
try {
  const bin = join(root, "dist/bin/forge.js");
  const created = JSON.parse(
    run(bin, ["issue", "create", "--input", '{"title":"footprint"}']).stdout,
  ) as { result: { id: string } };
  const id = created.result.id;
  const version = run(bin, ["--version"]).report;
  const show = run(bin, ["issue", "show", id]).report;
  lines.push(
    `Footprint on ${process.platform}, Node ${process.versions.node}. Sizes in MB; spaces are committed V8 memory.`,
    "",
    "| Command | Peak RSS | Heap used | Heap total | New space | Old space | Code space | External | Array buffers | Modules |",
    "| ------- | -------: | --------: | ---------: | --------: | --------: | ---------: | -------: | ------------: | ------: |",
    ...(
      [
        ["--version", version],
        ["issue show", show],
      ] as const
    ).map(
      ([name, r]) =>
        `| ${name} | ${r.peak} | ${r.heapUsed} | ${r.heapTotal} | ${r.newSpace} | ${r.oldSpace} | ${r.codeSpace} | ${r.external} | ${r.arrayBuffers} | ${r.loaded.length} |`,
    ),
    "",
    `Peak RSS grew by ${(show.peak - version.peak).toFixed(1)} MB between --version and issue show; heap total grew by ${(show.heapTotal - version.heapTotal).toFixed(1)} MB.`,
    "",
    "Modules loaded for `issue show`, by folder:",
    "",
  );
  const groups = new Map<string, number>();
  for (const url of show.loaded) {
    const path = url.replace(/^file:\/\/\/?/, "");
    const key = url.startsWith("node:")
      ? "node built-ins"
      : (/(dist\/src\/(?:adapters|blocks|core)\/[^/]+|dist\/src\/[^/.]+|node_modules\/(?:@[^/]+\/)?[^/]+|dist\/bin|dist\/src)/.exec(
          path,
        )?.[1] ?? "other");
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const [key, count] of [...groups].sort((a, b) => b[1] - a[1]))
    lines.push(`- ${key}: ${count}`);

  // Resident memory outside the V8 heap: the Linux split, and growth by event.
  if (show.status.VmRSS !== undefined)
    lines.push(
      "",
      "Resident memory split (Linux, MB):",
      "",
      "| Command | VmRSS | Anonymous | File-backed | Shared | VmData |",
      "| ------- | ----: | --------: | ----------: | -----: | -----: |",
      ...(
        [
          ["--version", version],
          ["issue show", show],
        ] as const
      ).map(
        ([name, r]) =>
          `| ${name} | ${r.status.VmRSS} | ${r.status.RssAnon} | ${r.status.RssFile} | ${r.status.RssShmem} | ${r.status.VmData} |`,
      ),
    );
  const growth = new Map<string, number>();
  const groupOf = (label: string): string => {
    if (!label.startsWith("load ")) return label;
    const url = label.slice(5);
    if (url.startsWith("node:")) return url;
    const inDist = /dist\/src\/((?:adapters|blocks|core)\/[^/]+|[^/.]+)/.exec(
      url,
    );
    if (inDist) return `dist/src/${inDist[1]}`;
    const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(url);
    return pkg ? `node_modules/${pkg[1]}` : "dist/bin";
  };
  show.events.forEach(([, rss], index) => {
    if (index === 0) return;
    const [before, was] = show.events[index - 1]!;
    const key = groupOf(before);
    growth.set(key, (growth.get(key) ?? 0) + rss - was);
  });
  lines.push(
    "",
    "Resident memory growth of one `issue show`, that follows each step until the next module load or block run (loading the module and running Forge code before the next step) (MB; `vm` rows are the block sandbox):",
    "",
    ...[...growth]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([key, mb]) => `- ${key}: ${mb.toFixed(1)}`),
    "",
  );

  // Same job, interleaved, each against the shipped build.
  const variants = [
    { label: "shipped", bin, ms: [] as number[], peak: [] as number[] },
    {
      label: "yaml package files instead of the bundle",
      bin: variantBin("dist-no-yaml-bundle", (dir) =>
        writeFileSync(
          join(dir, "src/adapters/config-yaml/yaml.js"),
          'export { isMap, isNode, isScalar, parseDocument, stringify } from "yaml";\n',
        ),
      ),
      ms: [] as number[],
      peak: [] as number[],
    },
    {
      label: "no young-generation cap",
      bin: variantBin("dist-no-cap", (dir) => {
        const file = join(dir, "bin/forge.js");
        const source = readFileSync(file, "utf8");
        const stripped = source.replace(
          /\(await import\("node:v8"\)\)\.setFlagsFromString\("--semi-space-growth-factor=1"\);/,
          "",
        );
        if (stripped === source) throw new Error("cap line not found");
        writeFileSync(file, stripped);
      }),
      ms: [] as number[],
      peak: [] as number[],
    },
  ];
  // The build of the base branch, made by the workflow in a second checkout, run on this same runner.
  const baseDist = process.env.FORGE_BASE_DIST;
  if (
    baseDist !== undefined &&
    baseDist !== "" &&
    existsSync(join(resolve(baseDist), "bin/forge.js"))
  )
    variants.splice(1, 0, {
      label: "origin/main build (the base of this branch)",
      bin: variantBin("dist-base", () => {}, resolve(baseDist)),
      ms: [] as number[],
      peak: [] as number[],
    });
  variants.push({
    label: "block capture resolving paths in JavaScript (as before)",
    bin: variantBin("dist-js-realpath", (dir) => {
      const file = join(dir, "src/adapters/node-runtime/capture.js");
      const source = readFileSync(file, "utf8");
      const changed = source.replace(
        "const realpath = realpathSync.native;",
        "const realpath = realpathSync;",
      );
      if (changed === source) throw new Error("realpath line not found");
      writeFileSync(file, changed);
    }),
    ms: [] as number[],
    peak: [] as number[],
  });
  // One-shot block reuse switched off: every block is read twice per command again.
  variants.push({
    label: "block reuse within one command switched off",
    bin: variantBin("dist-no-reuse", (dir) => {
      const file = join(dir, "src/assembly/command.js");
      const source = readFileSync(file, "utf8");
      const changed = source.replace(
        'oneShot: argv[0] !== "--mcp"',
        "oneShot: false",
      );
      if (changed === source) throw new Error("oneShot line not found");
      writeFileSync(file, changed);
    }),
    ms: [] as number[],
    peak: [] as number[],
  });
  for (let n = 0; n < 11; n += 1)
    for (const variant of variants) {
      const result = run(variant.bin, ["issue", "show", id]);
      if (n === 0) continue; // warm-up round
      variant.ms.push(result.ms);
      variant.peak.push(result.report.peak);
    }
  lines.push(
    "",
    "`issue show`, interleaved in this job, median of 10:",
    "",
    "| Build | Median ms | Median peak MB |",
    "| ----- | --------: | -------------: |",
    ...variants.map(
      (v) =>
        `| ${v.label} | ${median(v.ms).toFixed(0)} | ${median(v.peak).toFixed(1)} |`,
    ),
    "",
  );
  // node:sqlite in a fresh process: its import, an open and a first statement, read-only and read-write.
  const sqliteProbe = join(folder, "sqlite-probe.mjs");
  writeFileSync(
    sqliteProbe,
    [
      'import { readFileSync } from "node:fs";',
      "const status = () => { const o = {}; try { for (const line of readFileSync('/proc/self/status', 'utf8').split(String.fromCharCode(10))) { const i = line.indexOf(':'); const key = line.slice(0, i); if (key === 'RssAnon' || key === 'RssFile') o[key] = Math.round(parseInt(line.slice(i + 1).trim(), 10) / 102.4) / 10; } } catch {} return o; };",
      "const rss = () => Math.round(process.memoryUsage.rss() / 104857.6) / 10;",
      "const steps = [];",
      "const mark = (label) => steps.push({ label, rss: rss(), ...status() });",
      'mark("start");',
      'const { DatabaseSync } = await import("node:sqlite");',
      'mark("import node:sqlite");',
      "const db = new DatabaseSync(process.argv[2], { readOnly: process.argv[3] === 'ro' });",
      'mark("open");',
      "db.prepare('select count(*) as n from sqlite_master').get();",
      'mark("first statement");',
      "db.exec('PRAGMA cache_size=0; PRAGMA mmap_size=0');",
      'mark("cache_size 0 and mmap_size 0");',
      "db.close();",
      'mark("close");',
      "console.log(JSON.stringify(steps));",
      "",
    ].join("\n"),
  );
  for (const mode of ["ro", "rw"] as const) {
    const probed = spawnSync(
      process.execPath,
      [sqliteProbe, join(project, ".forge/state.sqlite"), mode],
      {
        cwd: project,
        env,
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
      },
    );
    if (probed.status !== 0) {
      lines.push(
        `node:sqlite probe (${mode}) failed: ${probed.stderr.slice(0, 300)}`,
        "",
      );
      continue;
    }
    const steps = JSON.parse(probed.stdout) as {
      label: string;
      rss: number;
      RssAnon?: number;
      RssFile?: number;
    }[];
    lines.push(
      `node:sqlite in a fresh process, ${mode === "ro" ? "read-only open (as issue show does)" : "read-write open"} (MB):`,
      "",
      "| Step | RSS | Change | Anonymous | File-backed |",
      "| ---- | --: | -----: | --------: | ----------: |",
      ...steps.map(
        (step, index) =>
          `| ${step.label} | ${step.rss} | ${index === 0 ? "" : (step.rss - steps[index - 1]!.rss).toFixed(1)} | ${step.RssAnon ?? "n/a"} | ${step.RssFile ?? "n/a"} |`,
      ),
      "",
    );
  }

  // Memory by phase of one `issue show`: marks written by a patched copy of the build, so the growth
  // is charged to what Forge was doing (importing, reading blocks, waiting on git, the call itself).
  const phaseDir = variantBin("dist-phases", (dir) => {
    const mark = (label: string): string =>
      `process.stderr.write("MARK|${label}|" + [process.memoryUsage.rss(), process.memoryUsage().heapUsed, process.memoryUsage().heapTotal, process.memoryUsage().external].map((n) => (n / 1048576).toFixed(1)).join("|") + String.fromCharCode(10));`;
    const patch = (
      file: string,
      edits: readonly (readonly [string, string])[],
    ) => {
      const path = join(dir, file);
      let source = readFileSync(path, "utf8");
      for (const [from, to] of edits) {
        if (!source.includes(from)) continue;
        source = source.replace(from, () => to);
      }
      writeFileSync(path, source);
    };
    patch("bin/forge.js", [
      [
        'const { runLocalCommand } = await import("../src/assembly/command.js");',
        `${mark("bin: before importing the command graph")} const { runLocalCommand } = await import("../src/assembly/command.js"); ${mark("command graph imported (every static import loaded)")}`,
      ],
      [
        "process.exitCode = await runLocalCommand(argv);",
        `process.exitCode = await runLocalCommand(argv); ${mark("command finished")}`,
      ],
    ]);
    patch("src/assembly/index.js", [
      [
        'found = captureBlock(resolveConfiguredBlock(root, source), blockCapture, undefined, "builtin" in source);',
        `${mark("block capture starts")} found = captureBlock(resolveConfiguredBlock(root, source), blockCapture, undefined, "builtin" in source); ${mark("block capture ends")}`,
      ],
      [
        "async invoke(request) {",
        `async invoke(request) { ${mark("invoke starts")}`,
      ],
      [
        "derived.push(...(await pending));",
        `derived.push(...(await pending)); ${mark("git answer received")}`,
      ],
      [
        "const result = await direct.invoke(call, request);",
        `${mark("call dispatch starts")} const result = await direct.invoke(call, request); ${mark("call dispatch ends")}`,
      ],
    ]);
  });
  const phased = spawnSync(process.execPath, [phaseDir, "issue", "show", id], {
    cwd: project,
    env,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  const marks = phased.stderr
    .split(String.fromCharCode(10))
    .filter((line) => line.startsWith("MARK|"))
    .map((line) => line.split("|").slice(1));
  if (phased.status === 0 && marks.length > 0)
    lines.push(
      "Memory by phase of one `issue show` (MB; a copy of the build writes a mark at each step):",
      "",
      "| Step | RSS | RSS change | Heap used | Heap total | External |",
      "| ---- | --: | ---------: | --------: | ---------: | -------: |",
      ...marks.map(
        (mark, index) =>
          `| ${mark[0]} | ${mark[1]} | ${index === 0 ? "" : (Number(mark[1]) - Number(marks[index - 1]![1])).toFixed(1)} | ${mark[2]} | ${mark[3]} | ${mark[4]} |`,
      ),
      "",
    );
  else lines.push(`Phase marks failed: ${phased.stderr.slice(0, 300)}`, "");

  // Starting one program through the process adapter: the first call pays module and native setup.
  const launchScript = join(folder, "launch.mjs");
  const adapter = pathToFileURL(
    join(root, "dist/src/adapters/process/index.js"),
  ).href;
  writeFileSync(
    launchScript,
    [
      'import { createRequire } from "node:module";',
      'import { spawnSync } from "node:child_process";',
      `const { createProcessPort } = await import(${JSON.stringify(adapter)});`,
      "let koffiMs = null;",
      'if (process.platform === "win32") {',
      "  const t = performance.now();",
      `  const koffi = createRequire(${JSON.stringify(join(root, "package.json"))})("koffi");`,
      '  koffi.load("kernel32.dll");',
      "  koffiMs = performance.now() - t;",
      "}",
      "const env = {};",
      'for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot"]) if (process.env[name] !== undefined) env[name] = process.env[name];',
      "const port = createProcessPort({ supervision: { cleanupTimeoutMs: 2000, pollIntervalMs: 25, drainTimeoutMs: 500, maxConcurrent: 1 } });",
      'const git = port.resolve("git", env);',
      "const options = { cwd: process.cwd(), env, timeoutMs: 30000, maxOutputBytes: 65536 };",
      "const cold = performance.now();",
      "spawnSync(git.path, ['--version'], { cwd: process.cwd(), env, windowsHide: true });",
      "const plainFirst = performance.now() - cold;",
      "const timed = async () => { const t = performance.now(); await port.run(git, ['--version'], options); return performance.now() - t; };",
      "const calls = [await timed(), await timed(), await timed()];",
      "const t = performance.now();",
      "spawnSync(git.path, ['--version'], { cwd: process.cwd(), env, windowsHide: true });",
      "console.log(JSON.stringify({ koffiMs, calls, plainFirst, plain: performance.now() - t }));",
      "",
    ].join("\n"),
  );
  const launch = spawnSync(process.execPath, [launchScript], {
    cwd: project,
    env,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  if (launch.status === 0) {
    const timing = JSON.parse(launch.stdout) as {
      koffiMs: number | null;
      calls: number[];
      plainFirst: number;
      plain: number;
    };
    lines.push(
      "Starting `git --version` through the process adapter in a fresh process (ms):",
      "",
      "| koffi load alone | plain spawnSync, first | adapter 1st call | adapter 2nd | adapter 3rd | plain spawnSync, last |",
      "| ---------------: | ---------------------: | ---------------: | ----------: | ----------: | --------------------: |",
      `| ${timing.koffiMs === null ? "n/a" : timing.koffiMs.toFixed(0)} | ${timing.plainFirst.toFixed(0)} | ${timing.calls.map((c) => c.toFixed(0)).join(" | ")} | ${timing.plain.toFixed(0)} |`,
      "",
    );
  } else lines.push(`Process adapter timing failed: ${launch.stderr}`, "");

  // File-system calls one `issue show` makes through `node:fs`, by call and by where the path is.
  const tally = join(folder, "tally.mjs");
  const tallyOut = join(folder, "tally.json");
  writeFileSync(
    tally,
    [
      'import fs, { writeFileSync } from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const rows = new Map();",
      "const where = (arg) => {",
      '  const text = String(arg?.href ?? arg ?? "").replaceAll("\\\\", "/");',
      '  if (text.includes("node_modules")) return "node_modules";',
      '  if (text.includes("/dist/src/blocks/")) return "shipped block files";',
      '  if (text.includes("/dist/src/")) return "dist/src";',
      '  if (text.includes("/.forge/") || text.includes("forge-footprint")) return "project and device state";',
      '  return "other";',
      "};",
      'const names = ["openSync", "statSync", "lstatSync", "fstatSync", "realpathSync", "readFileSync", "readSync", "readdirSync", "existsSync", "closeSync", "accessSync", "readlinkSync"];',
      "const wrap = (host, name, label) => {",
      "  const original = host[name];",
      '  if (typeof original !== "function") return;',
      "  host[name] = function (...args) {",
      "    const t = performance.now();",
      "    try { return original.apply(this, args); } finally {",
      '      const key = label + " | " + where(args[0]);',
      "      const row = rows.get(key) ?? { calls: 0, ms: 0 };",
      "      row.calls += 1; row.ms += performance.now() - t; rows.set(key, row);",
      "    }",
      "  };",
      "};",
      'wrap(fs.realpathSync, "native", "realpathSync.native");',
      "const nativeRealpath = fs.realpathSync.native;",
      "for (const name of names) wrap(fs, name, name);",
      "fs.realpathSync.native = nativeRealpath;",
      "syncBuiltinESMExports();",
      'process.on("exit", () => writeFileSync(process.env.FORGE_FS_TALLY, JSON.stringify([...rows])));',
      "",
    ].join("\n"),
  );
  const tallied = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(tally).href, bin, "issue", "show", id],
    {
      cwd: project,
      env: { ...env, FORGE_FS_TALLY: tallyOut },
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    },
  );
  if (tallied.status === 0) {
    const rows = (
      JSON.parse(readFileSync(tallyOut, "utf8")) as [
        string,
        { calls: number; ms: number },
      ][]
    ).sort((a, b) => b[1].ms - a[1].ms);
    lines.push(
      "",
      "File-system calls made through `node:fs` by one `issue show` (the module loader's own reads are not counted; they are in the profile below):",
      "",
      "| Call and path | Calls | ms |",
      "| ------------- | ----: | -: |",
      ...rows
        .slice(0, 14)
        .map(
          ([key, row]) => `| ${key} | ${row.calls} | ${row.ms.toFixed(1)} |`,
        ),
      "",
      `Total: ${rows.reduce((sum, [, row]) => sum + row.calls, 0)} calls, ${rows.reduce((sum, [, row]) => sum + row.ms, 0).toFixed(1)} ms.`,
      "",
    );
  } else
    lines.push(
      `File-system tally failed (${tallied.status} ${tallied.signal ?? ""} ${tallied.error?.message ?? ""}): ${tallied.stderr} ${tallied.stdout.slice(0, 300)}`,
      "",
    );

  // Where one `issue show` spends its time, from a CPU profile of the shipped build.
  const profiles = join(folder, "profiles");
  const profiled = spawnSync(
    process.execPath,
    ["--cpu-prof", `--cpu-prof-dir=${profiles}`, bin, "issue", "show", id],
    { cwd: project, env, encoding: "utf8", timeout: 60_000, windowsHide: true },
  );
  const profile = readdirSync(profiles).find((name) =>
    name.endsWith(".cpuprofile"),
  );
  if (profiled.status === 0 && profile !== undefined)
    lines.push(...profileSummary(join(profiles, profile)));
} finally {
  for (const copy of copies)
    rmSync(copy, { recursive: true, force: true, maxRetries: 5 });
  rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
}
const text = lines.join("\n");
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
