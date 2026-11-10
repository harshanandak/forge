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
  const total = Number(match[1]),
    failures = Number(failed?.[1] ?? 0);
  if (!count(total) || !count(failures) || failures > total) return malformed;
  return {
    kind: "recognized",
    testCount: total,
    failed: failures,
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
  if (current?.failed) return current;
  if (next.failed) return next;
  if (current?.kind === "malformed") return current;
  if (next.kind === "malformed") return next;
  return current?.testCount === 0 ? current : next;
}

function hasReportKey(text: string): boolean {
  // Consume whole string tokens so escaped quotes in values cannot become keys.
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/g))
    if (
      /^"num(?:Total|Failed)Tests"$/.test(match[0]) &&
      /^\s*:/.test(text.slice(match.index + match[0].length))
    )
      return true;
  return false;
}

/** One stream's object and string state, independent of summary-line buffering. */
class StructuredReports {
  leading = false;
  private first = true;
  private bytes = 0;
  private trailing = false;
  private closed = false;
  private prefix = "";
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private name = "";
  private last = 0;
  private key = false;
  private property = false;
  private evidence = false;
  private overflow = false;
  private chunks: Buffer[] = [];
  private tail: Buffer | undefined;
  private at = 0;
  private kept = 0;
  private result: OutputReport | undefined;
  private budget: { remaining: number };
  constructor(budget: { remaining: number }) {
    this.budget = budget;
  }
  push(chunk: Uint8Array): void {
    for (const byte of chunk) {
      const space = byte === 32 || (byte >= 9 && byte <= 13);
      if (this.first && !space) {
        this.first = false;
        this.leading = byte === 123;
      }
      if (!this.first) this.bytes++;
      if (byte === 10) this.prefix = "";
      if (!this.depth) {
        if (this.closed && !space) this.trailing = true;
        if (this.prefix.length < 128) this.prefix += String.fromCharCode(byte);
        if (
          byte !== 123 ||
          /^\s*\((?:pass|fail|skip|todo)\)/.test(
            stripVTControlCharacters(this.prefix),
          )
        )
          continue;
        this.last = 0;
      }
      if (!this.overflow) {
        if (!this.tail || this.at === this.tail.length) {
          const size = Math.min(4096, this.budget.remaining);
          if (!size) this.overflow = true;
          else {
            this.tail = Buffer.allocUnsafe(size);
            this.chunks.push(this.tail);
            this.budget.remaining -= size;
            this.at = 0;
          }
        }
        if (!this.overflow) {
          this.tail![this.at++] = byte;
          this.kept++;
        }
      }
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (byte === 92) this.escaped = true;
        else if (byte === 34) {
          this.quoted = false;
          this.property =
            this.key && /^(?:numTotalTests|numFailedTests)$/.test(this.name);
          this.last = byte;
          continue;
        }
        if (this.name.length < 17) this.name += String.fromCharCode(byte);
        continue;
      }
      if (space) continue;
      if (byte === 58 && this.property) this.evidence = true;
      this.property = false;
      if (byte === 34) {
        this.quoted = true;
        this.key = this.last === 123 || this.last === 44;
        this.name = "";
      } else if (byte === 123) this.depth++;
      else if (byte === 125 && --this.depth === 0) {
        if (this.evidence)
          this.result = retainFailure(
            this.result,
            this.overflow
              ? malformed
              : jsonReport(
                  Buffer.concat(this.chunks, this.kept).toString("utf8"),
                ),
          );
        for (const part of this.chunks) this.budget.remaining += part.length;
        this.chunks = [];
        this.tail = undefined;
        this.kept = 0;
        this.evidence = this.overflow = false;
        this.closed = true;
      }
      this.last = byte;
    }
  }
  report(): OutputReport | undefined {
    if (this.leading && this.bytes > REPORT_LIMIT) return malformed;
    return this.evidence ? retainFailure(this.result, malformed) : this.result;
  }
  primary(): OutputReport | undefined {
    if (!this.leading) return undefined;
    if (this.bytes > REPORT_LIMIT)
      return {
        ...malformed,
        detail: `Structured report exceeds ${REPORT_LIMIT} bytes and cannot be read whole`,
      };
    const report = this.report();
    return report && this.trailing ? malformed : report;
  }
}

/** Scans one stream line by line, keeping only the summary lines it has seen. */
class SummaryLines {
  bytes = 0;
  structured = false;
  jest: OutputReport | undefined;
  vitest: OutputReport | undefined;
  pytest: OutputReport | undefined;
  bun: OutputReport | undefined;
  bunHint = false;
  bunFailures = 0;
  bunFooter = false;
  zero = false;
  hint = false;
  invalid = false;
  nodeFailure = false;
  private nodeLines: string[] = [];
  private bunPassed: number | undefined;
  private bunFailed: number | undefined;
  private bunBailTotal: number | undefined;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private overlong = false;
  get incompleteBun(): boolean {
    return (
      (this.bunPassed !== undefined && this.bunFailed !== undefined) ||
      (this.bunFooter && !this.bun)
    );
  }

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
    if (valid && total === 0) this.zero = true;
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
    this.nodeLines.push(/^(?:ℹ |# )\w+ \d+(?:\.\d+)?$/.test(text) ? text : "");
    if (this.nodeLines.length > 8) this.nodeLines.shift();
    const node =
      /^(ℹ |# )tests (\d+)\n\1suites \d+\n\1pass \d+\n\1fail (\d+)\n\1cancelled (\d+)\n\1skipped \d+\n\1todo \d+\n\1duration_ms \d+(?:\.\d+)?$/.exec(
        this.nodeLines.join("\n"),
      );
    // Complete Node summaries can only add failure evidence, never counts or a pass.
    if (
      node &&
      (!Number(node[2]) || Number(node[3]) > 0 || Number(node[4]) > 0)
    )
      this.nodeFailure = true;
    if (!text) return;
    if (/^\s*\{/.test(text) && hasReportKey(text)) this.structured = true;
    const jest = /^\s*Tests:\s*(.*?)\s*(\d+)\s+total\s*$/.exec(text)?.slice(1);
    if (jest) this.jest = retainFailure(this.jest, summary("Jest", jest));
    const vitest = /^\s*Tests\s+(.*?)\((\d+)\)\s*$/.exec(text)?.slice(1);
    if (vitest)
      this.vitest = retainFailure(this.vitest, summary("Vitest", vitest));
    if (
      (/^\s*Tests:/.test(text) && !jest) ||
      (/^\s*Tests\s+.*\(/.test(text) && !vitest)
    )
      this.invalid = true;
    const bunOutcome = /^\s*(\d+) (pass|fail)\s*$/.exec(text);
    if (bunOutcome) {
      this.bunHint = true;
      if (bunOutcome[2] === "pass") this.bunPassed = Number(bunOutcome[1]);
      else {
        this.bunFailed = Number(bunOutcome[1]);
        if (count(this.bunFailed))
          this.bunFailures = Math.max(this.bunFailures, this.bunFailed);
      }
    }
    const bunTotal =
      /^\s*Ran (\d+) tests? across \d+ files?\.(?:\s+\[.*\])?\s*$/.exec(text);
    if (/^\s*Ran .* tests? across /.test(text) && !bunTotal)
      this.invalid = true;
    if (bunTotal) {
      this.bunFooter = true;
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
  const budget = { remaining: REPORT_LIMIT };
  const objects = {
    stdout: new StructuredReports(budget),
    stderr: new StructuredReports(budget),
  };
  const structured: Buffer[] | undefined = format === "json" ? [] : undefined;
  let structuredBytes = 0,
    overflow = false;
  function keep(chunk: Uint8Array): void {
    if (!structured || overflow) return;
    const room = REPORT_LIMIT - structuredBytes;
    if (chunk.length > room) overflow = true;
    structured.push(Buffer.from(chunk.subarray(0, room)));
    structuredBytes += Math.min(chunk.length, room);
  }
  return {
    push(stream, chunk) {
      if (format === "auto") objects[stream].push(chunk);
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
      if (format === "json" && stderr.structured) reports.push(malformed);
      // An overflowing object is never read whole, so its counts may lie past what was kept.
      if (format === "json")
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
      if (format === "auto") {
        const structuredReports = reports.some(
          (report) => report.kind === "recognized",
        )
          ? [objects.stdout.report(), objects.stderr.report()]
          : [
              objects.stdout.primary(),
              stderr.structured ||
              (stdout.structured && !objects.stdout.leading)
                ? malformed
                : undefined,
            ];
        reports.unshift(
          ...structuredReports.filter((report) => report !== undefined),
        );
      }
      const failed = reports.find(
        (report) => report.kind === "recognized" && report.failed! > 0,
      );
      if (failed) return failed;
      const invalid = reports.find((report) => report.kind === "malformed");
      const failures = stdout.bunFailures + stderr.bunFailures;
      if (
        invalid ||
        stdout.invalid ||
        stderr.invalid ||
        stdout.incompleteBun ||
        stderr.incompleteBun ||
        failures
      )
        return failures
          ? { ...(invalid ?? malformed), failed: failures }
          : (invalid ?? malformed);
      const zero = reports.find((report) => report.testCount === 0);
      if (zero) return zero;
      if (reports.length) {
        const report = reports[0]!;
        return (stdout.nodeFailure || stderr.nodeFailure) &&
          report.kind === "recognized" &&
          report.testCount !== 0
          ? { ...report, failed: 1 }
          : report;
      }
      if (stdout.nodeFailure || stderr.nodeFailure)
        return {
          kind: "recognized",
          testCount: null,
          failed: 1,
          detail: "Node test summary reports zero, failed or cancelled tests",
        };
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
