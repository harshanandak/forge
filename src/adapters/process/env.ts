import type { Platform } from "./platform.ts";

/**
 * Read one variable from a child environment. Windows names are case-insensitive, so `Path`,
 * `PATH` and `path` all match; when several differ only by case the first in code-unit order wins,
 * which is deterministic for any input.
 */
export function envValue(
  env: Readonly<Record<string, string>>,
  name: string,
  platform: Platform,
): string | undefined {
  if (platform !== "win32") return env[name];
  const wanted = name.toUpperCase();
  const key = Object.keys(env)
    .sort()
    .find((candidate) => candidate.toUpperCase() === wanted);
  return key === undefined ? undefined : env[key];
}
