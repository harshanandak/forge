import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readJson, type jobRecord } from "./ci-record.ts";
type Entry = ReturnType<typeof jobRecord>;
type Job = Record<string, string | null>;
export type Run = Record<"id" | "run_attempt", number> &
  Record<"head_sha" | "event" | "conclusion", string | null> & {
    jobs: Job[];
    records: Entry[];
  };
export const percentile = (values: number[], p: number) =>
  values.toSorted((a, b) => a - b).at(Math.ceil(values.length * p) - 1);
const minutes = (job: Job) =>
  job.runner_name && job.started_at && job.completed_at
    ? Math.max(0, Date.parse(job.completed_at) - Date.parse(job.started_at)) /
      60000
    : 0;
const wall = (a: Run) => {
  const end = a.jobs.find(
    (j) =>
      j.name === "CI Gate" && /^(success|failure)$/.test(j.conclusion ?? ""),
  )?.completed_at;
  const start = Math.min(
    ...a.jobs.flatMap((j) =>
      j.runner_name && j.started_at ? [Date.parse(j.started_at)] : [],
    ),
  );
  return end && Number.isFinite(start)
    ? (Date.parse(end) - start) / 60000
    : undefined;
};
const cost = (a: Run) => a.jobs.reduce((sum, j) => sum + minutes(j), 0);
const fileRows = (a: Run) => a.records.flatMap((r) => Object.entries(r.files));
const verdict = (value: number | undefined, target: number) =>
  value === undefined ? "UNKNOWN" : value <= target ? "PASS" : "MISS";
export function report(attempts: Run[]): string {
  attempts = attempts.toSorted(
    (a, b) => a.id - b.id || a.run_attempt - b.run_attempt,
  );
  const heads = [
    ...Map.groupBy(attempts, (a) => `${a.event}/${a.head_sha}`).values(),
  ];
  const runs = [...Map.groupBy(attempts, (a) => a.id).values()];
  const samples = (final: boolean) =>
    heads.flatMap((g) => {
      const v = wall(g.at(final ? -1 : 0)!);
      return v === undefined ? [] : [v];
    });
  const target = (label: string, values: number[], p: number, limit: number) =>
    `${label} gate p${p * 100}: ${percentile(values, p)?.toFixed(2) ?? "unknown"} min, target <= ${limit}: ${verdict(percentile(values, p), limit)} (n=${values.length})`;
  const flakes = runs.filter(
    (g) =>
      g[0]!.run_attempt === 1 &&
      g[0]!.conclusion === "failure" &&
      g.some(
        (a) => a.conclusion === "success" && a.head_sha === g[0]!.head_sha,
      ),
  );
  const rate = runs.length ? (flakes.length / runs.length) * 100 : undefined;
  const cancelled = runs
    .filter((g) => g.at(-1)!.conclusion === "cancelled")
    .flat()
    .reduce((sum, a) => sum + cost(a), 0);
  const slow = (rows: [string, number][]) =>
    JSON.stringify(rows.toSorted((a, b) => b[1] - a[1]).slice(0, 10));
  return `Sources: GitHub job metadata for wall/runner minutes; ci-record artifacts for file wall durations; runner cost, cancellations and slowest lists have no numeric target in forge-832. Wall: first runner start to completed CI Gate per attempt, grouped by event/head; cancelled/incomplete gates excluded.
${[false, true].flatMap((final) => [target(final ? "final" : "first", samples(final), 0.5, 8), target(final ? "final" : "first", samples(final), 0.9, 10)]).join("\n")}
${runs.map((g) => `Run ${g[0]!.id}: ${g.reduce((sum, a) => sum + cost(a), 0).toFixed(2)} runner min (${g.length} attempts, ${g.flatMap((a) => a.records).length} artifacts)`).join("\n")}
Flaky runs per 100: ${rate?.toFixed(2) ?? "unknown"}, target <= 2: ${verdict(rate, 2)} (same run/head fail then pass; symptoms, not root cause)
${flakes.map((g) => `Flake ${g[0]!.id}: ${[...new Set(fileRows(g[0]!).flatMap(([name, f]) => (f.status === "fail" ? [name] : [])))].join(", ") || "unknown (no failing-file artifact)"}`).join("\n")}
Cancelled-run minutes: ${cancelled.toFixed(2)} (all attempts of ultimately cancelled runs)
Slow jobs (minutes): ${slow(attempts.flatMap((a) => a.jobs.map((j): [string, number] => [j.name ?? "unknown", minutes(j)])))}
Slow files (minutes): ${slow(
    attempts.flatMap((a) =>
      fileRows(a)
        .filter(([, f]) => f.durationMs !== null)
        .map(([name, f]): [string, number] => [name, f.durationMs! / 60000]),
    ),
  )}
File coverage: ${attempts.filter((a) => a.records.length).length}/${attempts.length} attempts with artifacts; older/missing records have metadata only, no inferred file attribution.`;
}
const gh = (command: string, args: string[] = []) =>
  execFileSync("gh", [...command.split(" ").filter(Boolean), ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
if (import.meta.main) {
  const repo = "harshanandak/forge";
  const api = <T>(path: string, options = ""): T =>
    JSON.parse(gh(`api ${options}`, [`repos/${repo}/actions/${path}`])) as T;
  const list = <T>(path: string, key: string) =>
    api<Record<string, T[]>[]>(
      `${path}?per_page=100`,
      "--paginate --slurp",
    ).flatMap((p) => p[key]!);
  const selected = JSON.parse(
    gh(
      `run list --repo ${repo} --workflow ci.yml --json databaseId,headSha,event,attempt,headBranch --jq`,
      [
        'map(select(.event == "pull_request" or .headBranch == "main") | {id: .databaseId, head_sha: .headSha, event: .event, run_attempt: .attempt})',
        ...process.argv.slice(2),
      ],
    ),
  ) as Run[];
  const attempts: Run[] = [];
  for (const run of selected) {
    const directory = mkdtempSync(`${tmpdir()}/ci-report-`);
    try {
      const artifacts = list<{ name: string; expired: boolean }>(
        `runs/${run.id}/artifacts`,
        "artifacts",
      ).filter((a) => a.name.startsWith("ci-record-") && !a.expired);
      if (artifacts.length)
        gh(`run download ${run.id} --repo ${repo} --dir`, [
          directory,
          ...artifacts.flatMap((a) => ["--name", a.name]),
        ]);
      const paths = [...new Bun.Glob("**/ci-record.json").scanSync(directory)];
      const records = paths.map((p) => readJson<Entry>(`${directory}/${p}`));
      for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
        const path = `runs/${run.id}/attempts/${attempt}`;
        attempts.push({
          ...api<Run>(path),
          jobs: list<Job>(`${path}/jobs`, "jobs"),
          records: records.filter(
            (r) => r.run_attempt === attempt && r.head_sha === run.head_sha,
          ),
        });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  console.log(report(attempts));
}
