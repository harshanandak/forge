export const HOOK_READ_TOOLS: readonly string[] = [];
export const hookForgeToolNames = (
  _serverName: string,
): readonly string[] => [];
export const HOOK_TIMEOUT_MS = 0;
export const HOOK_STOP_TIMEOUT_MS = 0;
export const HOOK_STOP_TEXT_MAX = 0;
export const HOOK_PATHS = {};

export async function readInput(): Promise<void> {
  for await (const chunk of process.stdin) void chunk;
}
