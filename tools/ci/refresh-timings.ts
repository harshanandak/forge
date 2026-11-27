import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type jobRecord } from "./ci-record.ts";
import { downloadRecords } from "./ci-report.ts";
import { selectSourceFiles } from "./source-selection.ts";
import { discoverSourceFiles } from "./test-shards.ts";

type Entry = ReturnType<typeof jobRecord>;

const LOOKBACK = 100;

export function selectCandidateRuns(
  runs: { databaseId: number; headSha: string; attempt: number }[],
  limit: number,
): { id: number; head_sha: string; run_attempt: number }[] {
  return runs
    .toSorted((a, b) => b.databaseId - a.databaseId)
    .slice(0, limit)
    .map((run) => ({
      id: run.databaseId,
      head_sha: run.headSha,
      run_attempt: run.attempt,
    }));
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const isTestShard = (record: Entry) =>
  record.os === "Windows" &&
  record.node === "24" &&
  /^\d+\/\d+$/.test(record.shard);

export function refreshTimings(
  records: Entry[],
  selected: readonly string[],
  old: Readonly<Record<string, number>>,
): Record<string, number> {
  const samples = new Map<string, number[]>();
  for (const record of records.filter(isTestShard))
    for (const [file, { durationMs }] of Object.entries(record.files))
      if (durationMs !== null) {
        const seen = samples.get(file) ?? [];
        seen.push(durationMs);
        samples.set(file, seen);
      }
  const files: Record<string, number> = {};
  for (const file of [...selected].sort()) {
    const values = samples.get(file);
    if (values?.length) files[file] = Math.round(median(values)!);
    else if (file in old) files[file] = old[file]!;
  }
  return files;
}

if (import.meta.main) {
  const count = Number(
    process.argv.find((arg) => arg.startsWith("--runs="))?.split("=")[1] ??
      "10",
  );
  if (!Number.isInteger(count) || count <= 0)
    throw new Error("expected --runs=<positive integer>");
  const repo = "harshanandak/forge";
  const candidates = selectCandidateRuns(
    JSON.parse(
      execFileSync(
        "gh",
        [
          "run",
          "list",
          "--repo",
          repo,
          "--workflow",
          "ci.yml",
          "--branch",
          "main",
          "--status",
          "success",
          "--json",
          "databaseId,headSha,attempt",
          "--limit",
          String(LOOKBACK),
        ],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      ),
    ) as { databaseId: number; headSha: string; attempt: number }[],
    LOOKBACK,
  );
  const kept: Entry[] = [];
  const used: number[] = [];
  for (const run of candidates) {
    if (used.length >= count) break;
    const directory = mkdtempSync(`${tmpdir()}/refresh-timings-`);
    try {
      const found = downloadRecords(run, directory).filter(
        (record) =>
          record.run_attempt === run.run_attempt &&
          record.head_sha === run.head_sha &&
          isTestShard(record),
      );
      if (found.length) {
        kept.push(...found);
        used.push(run.id);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (used.length < count)
    throw new Error(
      `only ${used.length}/${count} successful main runs with Windows Node 24 test-shard records in the last ${LOOKBACK} runs`,
    );
  const selected = selectSourceFiles(discoverSourceFiles(), "24");
  const path = "test/timings.json";
  const old = (
    JSON.parse(readFileSync(path, "utf8")) as {
      files: Record<string, number>;
    }
  ).files;
  const files = refreshTimings(kept, selected, old);
  writeFileSync(path, `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
  console.log(
    `refresh-timings: ${kept.length} records from ${used.length} runs (${used.toSorted((a, b) => a - b).join(", ")}); ${Object.keys(files).length}/${selected.length} selected files have timings`,
  );
}
