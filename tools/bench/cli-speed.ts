// Speed of the everyday CLI commands: wall time and peak memory of the built package.
// Run after `bun run build`: `node tools/bench/cli-speed.ts [--runs 9] [--gate] [--base <dist>] [--json out.json]`.
// Each command starts a fresh Node process in a disposable project, as an agent would.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  GATED_PAIRS,
  gateDecision,
  medianPairedDelta,
  sampleOrder,
} from "./speed-compare.ts";
import { recordSpeedSample, type SpeedSample } from "./speed-samples.ts";

interface Limit {
  /** Absolute ceiling on the median. A slow runner can pass it, so it fails the job only when the same-job comparison with the base build fails too (or the base is missing); otherwise it warns. */
  readonly ceilingMs: number;
  /** Absolute cap on the median peak memory, which does not move with the runner. */
  readonly maxPeakMb: number;
}

// The speed gate, on `issue show` on a hosted runner. Peak memory is checked against
// an absolute cap. Time is checked against the build of the base branch, run in the same job and
// interleaved with this build, so runner speed cancels out. The absolute time is a ceiling that only
// warns while that comparison passes.
// Platforms without a limit only report.
const GATE_COMMAND = "issue show";
const gatedSamples: SpeedSample[] = [];
const LIMITS: Readonly<Record<string, Limit>> = {
  win32: { ceilingMs: 500, maxPeakMb: 70 },
  linux: { ceilingMs: 350, maxPeakMb: 85 },
};

interface Row {
  readonly command: string;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  /** Every timed run, in run order, for the comparison with the base build. */
  readonly timesMs: readonly number[];
  readonly medianPeakMb: number;
  /** Every run's peak memory, in run order, for the paired comparison with the base build. */
  readonly peaksMb: readonly number[];
}

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const runs = Number(flag("--runs") ?? 9);
if (!Number.isInteger(runs) || runs < 1)
  throw new Error("--runs must be a positive integer");
const gate = argv.includes("--gate");
// A pull request only warns when the absolute peak is over its cap; a push to main fails.
const pullRequest = argv.includes("--pull-request");
const pairs = Number(flag("--pairs") ?? GATED_PAIRS);
if (!Number.isInteger(pairs) || pairs < 1)
  throw new Error("--pairs must be a positive integer");

const bin = resolve(import.meta.dirname, "../../dist/bin/forge.js");
// `--base <dist folder>`: the base branch's build, measured against this one in the same job.
const baseDist = flag("--base");
const baseBin =
  baseDist === undefined ? undefined : resolve(baseDist, "bin/forge.js");
const folder = mkdtempSync(join(tmpdir(), "forge-bench-"));
const project = join(folder, "project");
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
// A preload records the child's own peak resident memory on exit; time includes Node start-up.
// Each run gets its own file, so a missing or stale reading can never be taken for a new one.
let runCounter = 0;
const preload = join(folder, "peak.mjs");
writeFileSync(
  preload,
  [
    'import { writeFileSync } from "node:fs";',
    "if (process.env.FORGE_BENCH_PLANT) {",
    "  globalThis.planted = Buffer.alloc(3 * 1024 * 1024, 1);",
    "  const end = performance.now() + 40;",
    "  while (performance.now() < end);",
    "}",
    'process.on("exit", () => {',
    "  writeFileSync(process.env.FORGE_BENCH_PEAK, String(process.resourceUsage().maxRSS));",
    "});",
    "",
  ].join("\n"),
);

const env: Record<string, string> = {
  FORGE_DEVICE_ROOT: join(folder, "device"),
  FORGE_DEVICE_ID: "bench",
  FORGE_SESSION: "bench",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(folder, "gitconfig"),
};
for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "TEMP", "TMP"])
  if (process.env[name] !== undefined) env[name] = process.env[name];

function run(
  args: readonly string[],
  program: string = bin,
): {
  stdout: string;
  ms: number;
  peakMb: number;
} {
  runCounter += 1;
  const peakFile = join(folder, `peak-${runCounter}.txt`);
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, program, ...args],
    {
      cwd: project,
      env: {
        ...env,
        FORGE_BENCH_PEAK: peakFile,
        ...(program === bin ? { FORGE_BENCH_PLANT: "1" } : {}),
      },
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    },
  );
  const ms = performance.now() - started;
  if (result.error || result.status !== 0)
    throw new Error(
      `forge ${args.join(" ")} failed (${result.status}): ${result.error?.message ?? result.stderr}\n${result.stdout}`,
    );
  // The reading must exist for this run and be a positive number; anything else fails the run
  // instead of letting the memory gate pass on nothing.
  if (!existsSync(peakFile))
    throw new Error(
      `forge ${args.join(" ")} wrote no peak memory reading (${peakFile} is missing)`,
    );
  const text = readFileSync(peakFile, "utf8").trim();
  const peakKb = text === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(peakKb) || peakKb <= 0)
    throw new Error(
      `forge ${args.join(" ")} wrote an unusable peak memory reading: "${text}"`,
    );
  return { stdout: result.stdout, ms, peakMb: peakKb / 1024 };
}

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

function toRow(
  command: string,
  samples: readonly { ms: number; peakMb: number }[],
): Row {
  const times = samples.map((sample) => sample.ms);
  return {
    command,
    medianMs: median(times),
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    timesMs: times,
    medianPeakMb: median(samples.map((sample) => sample.peakMb)),
    peaksMb: samples.map((sample) => sample.peakMb),
  };
}

function measure(command: string, args: readonly string[]): Row {
  run(args); // warm the file cache once; not counted
  return toRow(
    command,
    Array.from({ length: runs }, () => {
      const sample = run(args);
      if (command === GATE_COMMAND)
        recordSpeedSample(gatedSamples, "current", sample.ms);
      return sample;
    }),
  );
}

/** This build and the base build, alternating who goes first, so both see the same runner. */
function measurePair(
  command: string,
  args: readonly string[],
  baseProgram: string,
): { current: Row; base: Row } {
  run(args);
  run(args, baseProgram);
  const current: { ms: number; peakMb: number }[] = [];
  const base: { ms: number; peakMb: number }[] = [];
  for (const side of sampleOrder(pairs)) {
    const sample = run(args, side === "current" ? bin : baseProgram);
    (side === "current" ? current : base).push(sample);
    if (command === GATE_COMMAND)
      recordSpeedSample(gatedSamples, side, sample.ms);
  }
  return {
    current: toRow(command, current),
    base: toRow(`${command} (origin/main build)`, base),
  };
}

const rows: Row[] = [];
try {
  run(["--version"]);
  // Seed a few issues outside the timed runs so list and show have work to do.
  let issueId = "";
  for (let n = 0; n < 10; n += 1) {
    const created = JSON.parse(
      run([
        "issue",
        "create",
        "--input",
        JSON.stringify({ title: `seed ${n}` }),
      ]).stdout,
    ) as { result: { id: string } };
    issueId = created.result.id;
  }
  rows.push(measure("--version", ["--version"]));
  rows.push(measure("help", ["help"]));
  rows.push(
    measure("issue create", [
      "issue",
      "create",
      "--input",
      JSON.stringify({ title: "bench" }),
    ]),
  );
  if (baseBin !== undefined && existsSync(baseBin)) {
    const pair = measurePair(GATE_COMMAND, ["issue", "show", issueId], baseBin);
    rows.push(pair.current, pair.base);
  } else rows.push(measure(GATE_COMMAND, ["issue", "show", issueId]));
  rows.push(measure("issue list", ["issue", "list", "--limit", "50"]));
  rows.push(
    measure("memory add", [
      "memory",
      "add",
      "--input",
      JSON.stringify({ level: "project", text: "bench note" }),
    ]),
  );
  rows.push(
    measure("memory search", [
      "memory",
      "search",
      "--input",
      JSON.stringify({ level: "project", query: "bench" }),
    ]),
  );
  rows.push(measure("config show", ["config", "show"]));
  rows.push(measure("check list", ["check", "list"]));
} finally {
  rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
}

const platform = process.platform;
const table = [
  `CLI speed on ${platform}, Node ${process.versions.node}, median of ${runs} runs after one warm-up. Time is wall time of a fresh process; memory is that process's own peak.`,
  "",
  "| Command | Median ms | Min ms | Max ms | Median peak MB |",
  "| ------- | --------: | -----: | -----: | -------------: |",
  ...rows.map(
    (row) =>
      `| ${row.command} | ${row.medianMs.toFixed(0)} | ${row.minMs.toFixed(0)} | ${row.maxMs.toFixed(0)} | ${row.medianPeakMb.toFixed(1)} |`,
  ),
  "",
].join("\n");
console.log(table);
const speedSamples = { command: GATE_COMMAND, samples: gatedSamples };
console.log(JSON.stringify(speedSamples));
// Every run's peak memory, so the paired limit can be checked against the real spread.
for (const row of rows)
  if (row.command.startsWith(GATE_COMMAND))
    console.log(`peaks ${row.command}: ${JSON.stringify(row.peaksMb)}`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
const jsonPath = flag("--json");
if (jsonPath)
  writeFileSync(
    jsonPath,
    JSON.stringify({ platform, rows, speedSamples }, null, 2),
  );

if (gate) {
  const limit = LIMITS[platform];
  const row = rows.find((candidate) => candidate.command === GATE_COMMAND)!;
  if (limit === undefined) {
    console.log(`No speed limit is set for ${platform}; reported only.`);
  } else {
    const baseRow = rows.find(
      (candidate) =>
        candidate.command === `${GATE_COMMAND} (origin/main build)`,
    );
    const { failures, warnings } = gateDecision(limit, row, baseRow, {
      command: GATE_COMMAND,
      platform,
      pullRequest,
      baseMissing: `the origin/main build was not found${baseDist === undefined ? " (no --base folder was given)" : ` at ${baseDist}`}, so the check against the base branch cannot run; build the base branch first`,
    });
    for (const message of warnings) console.log(`::warning::${message}`);
    for (const message of failures) console.error(`::error::${message}`);
    if (failures.length > 0) process.exitCode = 1;
    else console.log(`Speed gate passed on ${platform}.`);
    if (baseRow !== undefined)
      console.log(
        `${GATE_COMMAND} peak over the origin/main build: median of ${pairs} paired differences is ${medianPairedDelta(row.peaksMb, baseRow.peaksMb).toFixed(2)} MB`,
      );
  }
}
