export interface Options {
  dump: string;
  backup: string;
  manifest: string;
  out: string;
}
interface Entry {
  namespace: string;
  key: string;
  kind: string;
  change: string;
  beforeRevision: number | null;
  after: unknown;
}
interface Report {
  pages: number;
  delta: Entry[];
  absentInCloud: string[];
  counts: Record<string, number>;
  notCarriedBack: { scope: string; reason: string; count: number }[];
}
export function compute(_options: Options): Promise<Report> {
  return Promise.reject(new Error("not implemented"));
}
