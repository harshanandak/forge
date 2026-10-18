import { posix, win32 } from "node:path";

export type Platform = NodeJS.Platform;

/** The path flavour for a platform, so Windows paths are handled the same way on any host. */
export function pathFor(platform: Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}
