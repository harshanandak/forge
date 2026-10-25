import type {
  OutputRecognizer,
  OutputReport,
  ReportFormat,
  RunnerOutputPort,
} from "../../ports/runner-output.ts";
import { stripVTControlCharacters } from "node:util";

const unknown: OutputReport = {
  kind: "unknown",
  testCount: null,
  failed: null,
  detail:
    "Unrecognized output; result uses only the exit code, test count unknown",
};
const malformed: OutputReport = {
  kind: "malformed",
  testCount: null,
  failed: null,
  detail: "Recognized report is malformed or incomplete",
};
// Summaries are short lines; longer lines are skipped, never buffered.
const LINE_LIMIT = 65_536;
// A structured report is read whole; a larger one is reported, never guessed at.
const REPORT_LIMIT = 8_388_608;
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function jsonReport(text: string): OutputReport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return malformed;
  }
  if (typeof value !== "object" || value === null) return malformed;
  const report = value as Record<string, unknown>;
  // Jest and Vitest use these fields in their JSON reports.
  if (
    !count(report.numTotalTests) ||
    !count(report.numFailedTests) ||
    report.numFailedTests > report.numTotalTests
  )
    return malformed;
  if (report.success !== undefined && typeof report.success !== "boolean")
    return malformed;
  return {
    kind: "recognized",
    testCount: report.numTotalTests,
    failed:
      report.success === false
        ? Math.max(1, report.numFailedTests)
        : report.numFailedTests,
    detail: "Structured test report",
  };
}
function summary(
  kind: "Jest" | "Vitest",
  match: readonly string[],
): OutputReport {
  const failed = /(\d+)\s+failed/.exec(match[0] ?? "");
  return {
    kind: "recognized",
    testCount: Number(match[1]),
    failed: Number(failed?.[1] ?? 0),
    detail: `${kind} test summary`,
  };
}
function pytest(line: string): OutputReport {
  let total = 0,
    failed = 0;
  for (const term of line.split(/,\s*/)) {
    const match =
      /^(\d+)\s+(passed|failed|skipped|deselected|xfailed|xpassed|errors?|warnings?|reruns?)$/.exec(
        term,
      );
    if (!match) return unknown;
    const n = Number(match[1]);
    if (!count(n)) return unknown;
    if (!/^(?:deselected|warnings?|reruns?)$/.test(match[2]!)) total += n;
    if (/^(?:failed|errors?)$/.test(match[2]!)) failed += n;
    if (!count(total) || !count(failed)) return unknown;
  }
  return {
    kind: "recognized",
    testCount: total,
    failed,
    detail: "Pytest test summary",
  };
}

function retainFailure(
  current: OutputReport | undefined,
  next: OutputReport,
): OutputReport {
  return current?.failed ? current : next;
}

/** Scans one stream line by line, keeping only the summary lines it has seen. */
class SummaryLines {
  bytes = 0;
  jest: OutputReport | undefined;
  vitest: OutputReport | undefined;
  pytest: OutputReport | undefined;
  bun: OutputReport | undefined;
  bunHint = false;
  zero = false;
  hint = false;
  private bunPassed: number | undefined;
  private bunFailed: number | undefined;
  private bunBailTotal: number | undefined;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private overlong = false;

  push(chunk: Uint8Array): void {
    this.bytes += chunk.length;
    for (let start = 0; ;) {
      const end = chunk.indexOf(10, start);
      this.hold(chunk.subarray(start, end < 0 ? chunk.length : end));
      if (end < 0) return;
      this.line();
      start = end + 1;
    }
  }
  end(): void {
    if (this.pendingBytes) this.line();
  }
  private hold(part: Uint8Array): void {
    if (this.overlong || !part.length) return;
    this.pendingBytes += part.length;
    if (this.pendingBytes > LINE_LIMIT) {
      this.overlong = true;
      this.pending = [];
    } else this.pending.push(Buffer.from(part));
  }
  private bunSummary(total: number, failed: number): void {
    const valid = count(total) && count(failed) && failed <= total;
    const next: OutputReport = valid
      ? {
          kind: "recognized",
          testCount: total,
          failed,
          detail: "Bun test summary",
        }
      : malformed;
    const fallback = retainFailure(this.bun, next);
    const testCount = total + (this.bun?.testCount ?? 0);
    const failures = failed + (this.bun?.failed ?? 0);
    this.bun =
      valid &&
      this.bun?.kind !== "malformed" &&
      count(testCount) &&
      count(failures)
        ? {
            kind: "recognized",
            testCount,
            failed: failures,
            detail: "Bun test summary",
          }
        : fallback.failed
          ? fallback
          : malformed;
  }
  private line(): void {
    const text = this.overlong
      ? ""
      : stripVTControlCharacters(
          Buffer.concat(this.pending).toString("utf8"),
        ).replace(/\r$/, "");
    this.pending = [];
    this.pendingBytes = 0;
    this.overlong = false;
    if (!text) return;
    const jest = /^\s*Tests:\s*(.*?)\s*(\d+)\s+total\s*$/.exec(text)?.slice(1);
    if (jest) this.jest = retainFailure(this.jest, summary("Jest", jest));
    const vitest = /^\s*Tests\s+(.*?)\((\d+)\)\s*$/.exec(text)?.slice(1);
    if (vitest)
      this.vitest = retainFailure(this.vitest, summary("Vitest", vitest));
    const bunOutcome = /^\s*(\d+) (pass|fail)\s*$/.exec(text);
    if (bunOutcome) {
      this.bunHint = true;
      if (bunOutcome[2] === "pass") this.bunPassed = Number(bunOutcome[1]);
      else this.bunFailed = Number(bunOutcome[1]);
    }
    const bunTotal =
      /^\s*Ran (\d+) tests? across \d+ files?\.(?:\s+\[.*\])?\s*$/.exec(text);
    if (bunTotal) {
      this.bunHint = true;
      const total = Number(bunTotal[1]);
      const passed = this.bunPassed,
        failed = this.bunFailed;
      // Bail prints a footer without counters, followed by its failure count.
      this.bunBailTotal =
        passed === undefined && failed === undefined ? total : undefined;
      if (
        count(passed) &&
        count(failed) &&
        count(total) &&
        passed <= total - failed
      )
        this.bunSummary(total, failed);
      else if (passed !== undefined && failed !== undefined)
        this.bun = retainFailure(this.bun, malformed);
      this.bunPassed = undefined;
      this.bunFailed = undefined;
    }
    const bail = /^\s*Bailed out after (\d+) failures?\s*$/.exec(text);
    if (bail) {
      this.bunHint = true;
      const failed = Number(bail[1]);
      if (this.bunBailTotal !== undefined && failed > 0)
        this.bunSummary(this.bunBailTotal, failed);
      this.bunBailTotal = undefined;
    }
    if (
      /no test(?:s| files)? (?:found|collected)|collected 0 items/i.test(text)
    )
      this.zero = true;
    const candidate =
      /^[\t ]*(.*?)[\t ]+in[\t ]+\d+(?:\.\d+)?s(?:[\t ]+\(.*\))?[\t ]*=*[\t ]*$/.exec(
        text,
      )?.[1];
    // Any line can end "in 3s"; only a parsed summary is evidence.
    const parsed =
      candidate === undefined
        ? undefined
        : pytest(candidate.replace(/^=+\s*|\s*=+$/g, ""));
    if (parsed?.kind === "recognized")
      this.pytest = retainFailure(this.pytest, parsed);
    if (/^\s*Tests:|^\s*Tests\s+\d+.*\(|"numTotalTests"/.test(text))
      this.hint = true;
  }
}

function recognizer(format: ReportFormat): OutputRecognizer {
  const stdout = new SummaryLines(),
    stderr = new SummaryLines();
  let structured: Buffer[] | undefined = format === "json" ? [] : undefined;
  let structuredBytes = 0,
    decided = format === "json",
    overflow = false;
  function keep(chunk: Uint8Array): void {
    let part = chunk;
    if (!decided) {
      const start = part.findIndex(
        (byte) => byte !== 32 && (byte < 9 || byte > 13),
      );
      if (start < 0) return;
      decided = true;
      if (part[start] !== 0x7b) return;
      structured = [];
      part = part.subarray(start);
    }
    if (!structured || overflow) return;
    const room = REPORT_LIMIT - structuredBytes;
    if (part.length > room) overflow = true;
    structured.push(Buffer.from(part.subarray(0, room)));
    structuredBytes += Math.min(part.length, room);
  }
  return {
    push(stream, chunk) {
      if (stream === "stdout") {
        stdout.push(chunk);
        if (format !== "exit-code") keep(chunk);
      } else stderr.push(chunk);
    },
    observed: () => ({ stdout: stdout.bytes, stderr: stderr.bytes }),
    report() {
      if (format === "exit-code") return unknown;
      stdout.end();
      stderr.end();
      const text = structured ? Buffer.concat(structured).toString("utf8") : "";
      const reports: OutputReport[] = [];
      // An overflowing object is never read whole, so its counts may lie past what was kept.
      if (
        format === "json" ||
        (structured && (overflow || /"num(?:Total|Failed)Tests"/.test(text)))
      )
        reports.push(
          overflow
            ? {
                ...malformed,
                detail: `Structured report exceeds ${REPORT_LIMIT} bytes and cannot be read whole`,
              }
            : jsonReport(text.trim()),
        );
      for (const report of [
        stdout.jest,
        stderr.jest,
        stdout.vitest,
        stderr.vitest,
        stdout.bun,
        stderr.bun,
      ])
        if (report) reports.push(report);
      if (stdout.zero || stderr.zero)
        reports.push({
          kind: "recognized",
          testCount: 0,
          failed: 0,
          detail: "Runner reported zero tests",
        });
      for (const report of [stdout.pytest, stderr.pytest])
        if (report) reports.push(report);
      const failed = reports.find(
        (report) => report.kind === "recognized" && report.failed! > 0,
      );
      if (failed) return failed;
      if (reports.length) return reports[0]!;
      if (stdout.hint || stderr.hint || stdout.bunHint || stderr.bunHint)
        return malformed;
      return unknown;
    },
  };
}

export function createRunnerOutput(): RunnerOutputPort {
  return {
    recognize: recognizer,
    parse(stdout, stderr, format) {
      const output = recognizer(format);
      output.push("stdout", Buffer.from(stdout));
      output.push("stderr", Buffer.from(stderr));
      return output.report();
    },
  };
}
