import { readFileSync, writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
export const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;
export function jobRecord(
  log: string,
  env: NodeJS.ProcessEnv,
  timings: Record<string, number> = {},
  now = Date.now(),
) {
  const status: Record<string, string> = {};
  let current: string | undefined;
  for (const line of stripVTControlCharacters(log).split(/\r?\n/)) {
    const hit = /^(?:::group::|##\[group\])?(.+\.test\.ts):$/.exec(line);
    if (hit) {
      current = hit[1]!.replaceAll("\\", "/");
      status[current] ??= "skip";
    }
    if (/^\s*\d+ tests? (?:failed|skipped):|^Ran \d+ tests/.test(line))
      current = undefined;
    if (!current) continue;
    if (/^\(fail\)|^error:|^unhandled error/i.test(line))
      status[current] = "fail";
    if (/^\(pass\)/.test(line) && status[current] !== "fail")
      status[current] = "pass";
  }
  return {
    run_id: env.GITHUB_RUN_ID,
    run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    head_sha: env.CI_HEAD,
    os: env.RUNNER_OS,
    node: env.CI_NODE,
    shard: env.CI_SHARD ?? "all",
    wallMs: now - Number(env.CI_JOB_STARTED),
    files: Object.fromEntries(
      Object.entries(status).map(([name, status]) => [
        name,
        { durationMs: timings[name] ?? null, status },
      ]),
    ),
  };
}
if (import.meta.main) {
  const started = performance.now();
  const directory = process.env.RUNNER_TEMP!;
  const log = readFileSync(`${directory}/ci-tests.log`, "utf8");
  const timings = readJson<{ files: Record<string, number> }>(
    process.env.CI_TIMINGS!,
  ).files;
  const record = jobRecord(log, process.env, timings);
  writeFileSync(`${directory}/ci-record.json`, JSON.stringify(record));
  console.log(
    `CI record: ${Object.keys(record.files).length} files, ${performance.now() - started} ms read/parse/write, ${Buffer.byteLength(JSON.stringify(record))} bytes`,
  );
}
