import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";

export type AttributionRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => { status: number | null; stdout: string; stderr?: string; error?: Error };
export function cleanupAttribution(
  root: string,
  cleanup: () => void,
  run: AttributionRunner = spawnSync,
  {
    tool = process.env.FORGE_HANDLE_EXE,
    unavailable = process.env.FORGE_HANDLE_UNAVAILABLE,
  }: { tool?: string; unavailable?: string } = {},
): void {
  try {
    cleanup();
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (
      process.platform === "win32" &&
      ["EBUSY", "EPERM"].includes(error?.code ?? "")
    ) {
      const snapshots = [...new Set([error.path ?? root, root])].map((path) => {
        const at = new Date().toISOString();
        try {
          if (unavailable) throw new Error(unavailable);
          if (!tool) throw new Error("handle unavailable: not configured");
          const result = run(
            tool,
            ["-accepteula", "-nobanner", "-a", "-u", "-v", path],
            { encoding: "utf8", timeout: 10_000, windowsHide: true },
          );
          return {
            path,
            at,
            status: result.status,
            output: result.stdout,
            ...(result.error || result.status !== 0
              ? {
                  failure: `attribution failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
                }
              : {}),
          };
        } catch (failure) {
          return {
            path,
            at,
            status: null,
            failure: `attribution failed: ${String(failure)}`,
          };
        }
      });
      error.message += `\nCleanup attribution: ${JSON.stringify(snapshots)}`;
    }
    throw cause;
  }
}
