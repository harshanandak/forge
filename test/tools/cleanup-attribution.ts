import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";

export type AttributionRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => { status: number | null; stdout: string; stderr?: string; error?: Error };
export function cleanupAttribution(
  _root: string,
  _cleanup: () => void,
  _run?: AttributionRunner,
  _settings?: { tool?: string; unavailable?: string },
): void {
  throw new Error("not implemented");
}
