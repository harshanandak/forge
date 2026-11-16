import {
  realFileProbe,
  resolveExecutable,
} from "../src/adapters/process/resolve.ts";

export function gitExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const selected = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const found = resolveExecutable(
    "git",
    selected,
    process.platform,
    realFileProbe,
  );
  if (found.kind !== "resolved")
    throw new Error(`${found.reason} ${found.remedy}`);
  return found.path;
}
