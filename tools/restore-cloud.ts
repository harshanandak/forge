export type Fetch = (input: string, init: RequestInit) => Promise<Response>;
export class Refusal extends Error {}
export function tokenFrom(_source: { file?: string; env?: string }): string {
  throw new Refusal("not implemented");
}
export function transfer(_options: {
  pages: string;
  origin: string;
  project: string;
  token: string;
  report: string;
  fetch?: Fetch;
}): Promise<{ match: boolean; restored: boolean }> {
  return Promise.reject(new Refusal("not implemented"));
}
