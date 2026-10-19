/** Parsed evidence from a declared report format; implementations own format-specific grammar. */
export interface OutputReport {
  readonly kind: "recognized" | "unknown" | "malformed";
  readonly testCount: number | null;
  readonly failed: number | null;
  readonly detail: string;
}
export type ReportFormat = "auto" | "json" | "exit-code";
export interface RunnerOutputPort {
  parse(stdout: string, stderr: string, report: ReportFormat): OutputReport;
}
