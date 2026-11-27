import { Buffer } from "node:buffer";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import type { ResolvedExecutable } from "../ports/process.ts";

const ghBuildInfo = Buffer.from("\xff Go buildinf:", "latin1");
const ghModule = Buffer.from(
  "path\tgithub.com/cli/cli/v2/cmd/gh\nmod\tgithub.com/cli/cli/v2\t",
);
const gitVersionFormat = Buffer.from("git version %s");
const gitForWindows = Buffer.from("Git for Windows\0", "utf16le");
const gitDispatchTarget = Buffer.from("bin\\git.exe\0", "utf16le");

function hasGitHubCliBuildInfo(block: Buffer): boolean {
  for (
    let at = block.indexOf(ghBuildInfo);
    at >= 0;
    at = block.indexOf(ghBuildInfo, at + 1)
  ) {
    if (block.subarray(at + 32, at + 256).includes(ghModule)) return true;
  }
  return false;
}

function matchesBuild(
  fd: number,
  size: number,
  matches: (block: Buffer) => boolean,
): boolean {
  const step = 1024 * 1024;
  if (size > 128 * step) return false;
  const data = Buffer.alloc(step + 256);
  for (let offset = 0; offset < size; offset += step) {
    const count = readSync(fd, data, 0, data.length, offset);
    if (matches(data.subarray(0, count))) return true;
  }
  return false;
}

function nativeHeader(magic: Buffer, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return magic.readUInt16BE(0) === 0x4d5a;
  const header = magic.readUInt32BE(0);
  if (platform === "darwin")
    return [
      0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
      0xcafebabf, 0xbfbafeca,
    ].includes(header);
  return header === 0x7f454c46;
}

function sameFile(initial: BigIntStats, current: BigIntStats): boolean {
  return (
    current.isFile() &&
    initial.dev === current.dev &&
    initial.ino === current.ino &&
    initial.size === current.size &&
    initial.mtimeNs === current.mtimeNs &&
    initial.ctimeNs === current.ctimeNs
  );
}

export function pinAdvisoryExecutable(
  executable: ResolvedExecutable,
  platform: NodeJS.Platform,
  program: "git" | "gh",
):
  | { executable: ResolvedExecutable; cost: 1 | 2; unchanged(): boolean }
  | undefined {
  if (platform === "win32" && !/\.exe$/i.test(executable.path)) return;
  let fd: number | undefined;
  try {
    fd = openSync(executable.path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(fd, { bigint: true });
    if (!info.isFile()) return;
    const magic = Buffer.alloc(4);
    if (
      readSync(fd, magic, 0, magic.length, 0) !== magic.length ||
      !nativeHeader(magic, platform)
    )
      return;
    const size = Number(info.size);
    const cost =
      program === "gh"
        ? matchesBuild(fd, size, hasGitHubCliBuildInfo)
          ? 1
          : undefined
        : gitCost(fd, size, platform, executable.path);
    const unchanged = () => {
      try {
        return sameFile(info, lstatSync(executable.path, { bigint: true }));
      } catch {
        return false;
      }
    };
    if (cost !== undefined && unchanged())
      return { executable, cost, unchanged };
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function gitCost(
  fd: number,
  size: number,
  platform: NodeJS.Platform,
  path: string,
): 1 | 2 | undefined {
  if (matchesBuild(fd, size, (block) => block.includes(gitVersionFormat)))
    return 1;
  if (
    platform === "win32" &&
    /[\\/](?:cmd|bin)[\\/]git\.exe$/i.test(path) &&
    matchesBuild(
      fd,
      size,
      (block) =>
        block.includes(gitForWindows) && block.includes(gitDispatchTarget),
    )
  )
    return 2;
}
