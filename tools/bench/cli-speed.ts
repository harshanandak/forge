// Speed of the everyday CLI commands: wall time and peak memory of the built package.
// Run after `bun run build`: `node tools/bench/cli-speed.ts [--runs 9] [--gate] [--json out.json]`.
// Each command starts a fresh Node process in a disposable project, as an agent would.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Limit {
  readonly maxMs: number;
  readonly maxPeakMb?: number;
}

// The speed gate: `issue show` median on a hosted runner. Platforms without a limit only report.
const GATE_COMMAND = "issue show";
const LIMITS: Readonly<Record<string, Limit>> = {
  win32: { maxMs: 400, maxPeakMb: 70 },
  linux: { maxMs: 250 },
};

interface Row {
  readonly command: string;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly medianPeakMb: number;
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

const bin = resolve(import.meta.dirname, "../../dist/bin/forge.js");
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
const peakFile = join(folder, "peak.txt");
const preload = join(folder, "peak.mjs");
writeFileSync(
  preload,
  [
    'import { writeFileSync } from "node:fs";',
    'process.on("exit", () => {',
    "  try {",
    "    writeFileSync(process.env.FORGE_BENCH_PEAK, String(process.resourceUsage().maxRSS));",
    "  } catch {}",
    "});",
    "",
  ].join("\n"),
);

const env: Record<string, string> = {
  FORGE_DEVICE_ROOT: join(folder, "device"),
  FORGE_DEVICE_ID: "bench",
  FORGE_SESSION: "bench",
  FORGE_BENCH_PEAK: peakFile,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(folder, "gitconfig"),
};
for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "TEMP", "TMP"])
  if (process.env[name] !== undefined) env[name] = process.env[name];

function run(args: readonly string[]): {
  stdout: string;
  ms: number;
  peakMb: number;
} {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, bin, ...args],
    {
      cwd: project,
      env,
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
  return {
    stdout: result.stdout,
    ms,
    peakMb: Number(readFileSync(peakFile, "utf8")) / 1024,
  };
}

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

function measure(command: string, args: readonly string[]): Row {
  run(args); // warm the file cache once; not counted
  const samples = Array.from({ length: runs }, () => run(args));
  const times = samples.map((sample) => sample.ms);
  return {
    command,
    medianMs: median(times),
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    medianPeakMb: median(samples.map((sample) => sample.peakMb)),
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
  rows.push(measure("issue show", ["issue", "show", issueId]));
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
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
const jsonPath = flag("--json");
if (jsonPath)
  writeFileSync(jsonPath, JSON.stringify({ platform, rows }, null, 2));

if (gate) {
  const limit = LIMITS[platform];
  const row = rows.find((candidate) => candidate.command === GATE_COMMAND)!;
  if (limit === undefined) {
    console.log(`No speed limit is set for ${platform}; reported only.`);
  } else {
    const failures: string[] = [];
    if (row.medianMs > limit.maxMs)
      failures.push(
        `${GATE_COMMAND} median ${row.medianMs.toFixed(0)} ms is over the ${limit.maxMs} ms limit on ${platform}`,
      );
    if (limit.maxPeakMb !== undefined && row.medianPeakMb > limit.maxPeakMb)
      failures.push(
        `${GATE_COMMAND} peak ${row.medianPeakMb.toFixed(1)} MB is over the ${limit.maxPeakMb} MB limit on ${platform}`,
      );
    for (const message of failures) console.error(`::error::${message}`);
    if (failures.length > 0) process.exitCode = 1;
    else console.log(`Speed gate passed on ${platform}.`);
  }
}
