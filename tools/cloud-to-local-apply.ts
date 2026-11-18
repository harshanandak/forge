export interface Options {
  report: string;
  manifest: string;
  store: string;
  write: boolean;
}
export function apply(
  _options: Options,
): Promise<{ mode: "dry-run" | "applied"; new: number; changed: number }> {
  return Promise.reject(new Error("not implemented"));
}
