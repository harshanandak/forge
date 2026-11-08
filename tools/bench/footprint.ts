// Where the memory and start-up time of one command go: V8 heap spaces, native memory, the modules
// loaded, and a same-job A/B of the bundled yaml against the yaml package. Not a gate.
// Run after `bun run build`: `node tools/bench/footprint.ts`.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
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
const copy = join(root, "dist-ab");
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
    'import { registerHooks } from "node:module";',
    'import { writeFileSync } from "node:fs";',
    'import v8 from "node:v8";',
    "const loaded = [];",
    "registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });",
    'process.on("exit", () => {',
    "  const mb = (bytes) => Math.round(bytes / 104857.6) / 10;",
    "  const memory = process.memoryUsage();",
    "  const space = Object.fromEntries(v8.getHeapSpaceStatistics().map((s) => [s.space_name, mb(s.space_size)]));",
    "  writeFileSync(process.env.FORGE_FOOTPRINT, JSON.stringify({",
    "    peak: mb(process.resourceUsage().maxRSS * 1024), heapUsed: mb(memory.heapUsed), heapTotal: mb(memory.heapTotal),",
    "    external: mb(memory.external), arrayBuffers: mb(memory.arrayBuffers),",
    "    newSpace: space.new_space, oldSpace: space.old_space, codeSpace: space.code_space, loaded,",
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
    "Peak RSS grew by " +
      `${(show.peak - version.peak).toFixed(1)} MB between --version and issue show; heap total grew by ${(show.heapTotal - version.heapTotal).toFixed(1)} MB.`,
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

  // Same job, interleaved: the shipped bundle of yaml against the package's own files.
  cpSync(join(root, "dist"), join(copy, "."), { recursive: true });
  writeFileSync(
    join(copy, "src/adapters/config-yaml/yaml.js"),
    'export { isMap, isNode, isScalar, parseDocument, stringify } from "yaml";\n',
  );
  const bundled: number[] = [];
  const packaged: number[] = [];
  const bundledPeak: number[] = [];
  const packagedPeak: number[] = [];
  for (let n = 0; n < 11; n += 1) {
    const a = run(bin, ["issue", "show", id]);
    const b = run(join(copy, "bin/forge.js"), ["issue", "show", id]);
    if (n === 0) continue; // warm-up pair
    bundled.push(a.ms);
    packaged.push(b.ms);
    bundledPeak.push(a.report.peak);
    packagedPeak.push(b.report.peak);
  }
  lines.push(
    "",
    "`issue show`, yaml bundled in one file against the yaml package's own files (median of 10, interleaved):",
    "",
    "| yaml | Median ms | Median peak MB |",
    "| ---- | --------: | -------------: |",
    `| bundled | ${median(bundled).toFixed(0)} | ${median(bundledPeak).toFixed(1)} |`,
    `| package files | ${median(packaged).toFixed(0)} | ${median(packagedPeak).toFixed(1)} |`,
    "",
  );
} finally {
  rmSync(copy, { recursive: true, force: true, maxRetries: 5 });
  rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
}
const text = lines.join("\n");
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
