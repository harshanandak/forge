// Operator tool: converts an isolated kernel backup of the forge/work namespace into forge-cloud-dump-page/1
// files (forge-1231). This is the inert typed seam of the tests-first commit: it converts nothing, so every run
// reports NOT_EXECUTED until the converter lands.

export const TABLES = [
  "state_records",
  "state_events",
  "state_leases",
  "state_requests",
  "domain_cloud_requests",
] as const;
export type Table = (typeof TABLES)[number];
export type Status = "PASS" | "FAIL" | "INCOMPLETE" | "NOT_EXECUTED";

/** Rows, stored bytes (SQL column-byte measure) and the sha256 of the JSON of the rows in key order. */
export interface Totals {
  readonly rows: number;
  readonly bytes: number;
  readonly digest: string;
}
export interface Options {
  /** The isolated backup file, and the sha256 the lead recorded for it. */
  readonly backup: string;
  readonly digest: string;
  /** With `out` the run writes page files, the sequence map and the manifest; without it the run is a dry run. */
  readonly out?: string;
  readonly pageBytes?: number;
}
export interface Report {
  readonly status: Status;
  readonly code: string | null;
  readonly selected: Readonly<Record<Table, Totals>>;
  readonly excluded: Readonly<Record<string, Readonly<Record<string, Totals>>>>;
  readonly sequence: { readonly count: number; readonly digest: string };
  readonly predictedFloorPairs: number;
  readonly pages: number;
  readonly contentDigest: string;
}

const none: Totals = { rows: 0, bytes: 0, digest: "" };
export function convert(_options: Options): Promise<Report> {
  return Promise.resolve({
    status: "NOT_EXECUTED",
    code: null,
    selected: Object.fromEntries(
      TABLES.map((table) => [table, none]),
    ) as Record<Table, Totals>,
    excluded: {},
    sequence: { count: 0, digest: "" },
    predictedFloorPairs: 0,
    pages: 0,
    contentDigest: "",
  });
}

export const exitCode = (report: Report): number =>
  report.status === "PASS" ? 0 : 1;
