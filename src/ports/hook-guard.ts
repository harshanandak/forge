export interface HookGuardPort {
  command(input: unknown): unknown;
  output(input: unknown): unknown;
  inspect(mode: "metadata" | "summary", path: string): unknown;
}
