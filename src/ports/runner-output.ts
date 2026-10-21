import type { OutputObserver } from "./process.ts";

/** Parsed evidence from a declared report format; implementations own format-specific grammar. */
export interface OutputReport {
  readonly kind: "recognized" | "unknown" | "malformed";
  readonly testCount: number | null;
  readonly failed: number | null;
  readonly detail: string;
}
export type ReportFormat = "auto" | "json" | "exit-code";
/** Recognizes a report while output streams, keeping only what recognition needs. */
export interface OutputRecognizer extends OutputObserver {
  /** Bytes seen per stream, so a caller can confirm it saw the whole output. */
  observed(): { readonly stdout: number; readonly stderr: number };
  report(): OutputReport;
}
export interface RunnerOutputPort {
  parse(stdout: string, stderr: string, report: ReportFormat): OutputReport;
  recognize(report: ReportFormat): OutputRecognizer;
}
