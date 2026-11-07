/**
 * The one place tests spell PowerShell's startup flags (see test/structure/powershell-spawn).
 * -NoProfile skips profile scripts and -NonInteractive refuses prompts, so a spawn pays only for
 * PowerShell's own cold start, which CI warms once per Windows job.
 */
export const POWERSHELL_FLAGS = ["-NoProfile", "-NonInteractive"] as const;

export function powerShellArgs(command: string): string[] {
  return [...POWERSHELL_FLAGS, "-Command", command];
}
