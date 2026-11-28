import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import type { WindowsDirectoryCreator } from "../contract/windows-security.ts";
import { readSid } from "./windows-security-read.ts";
import { verifyWindowsDescriptor } from "./windows-security.ts";

export type WindowsCreation = "private" | "refused" | "published_unverified";
export type CreationClock = {
  readonly end: number;
  readonly now: () => number;
};

const selfRelativeProtectedDacl = 0x9004;
const fullControl = 0x001f01ff;

export function privateDescriptor(sid: Buffer, directory: boolean): Buffer {
  const length = readSid(sid, 0, sid.length).next;
  const acl = 20 + length;
  const ace = 8 + length;
  const descriptor = Buffer.alloc(acl + 8 + ace);
  descriptor.writeUInt8(1, 0);
  descriptor.writeUInt16LE(selfRelativeProtectedDacl, 2);
  descriptor.writeUInt32LE(20, 4);
  descriptor.writeUInt32LE(acl, 16);
  sid.copy(descriptor, 20, 0, length);
  descriptor.writeUInt8(2, acl);
  descriptor.writeUInt16LE(8 + ace, acl + 2);
  descriptor.writeUInt16LE(1, acl + 4);
  descriptor.writeUInt8(directory ? 3 : 0, acl + 9);
  descriptor.writeUInt16LE(ace, acl + 10);
  descriptor.writeUInt32LE(fullControl, acl + 12);
  sid.copy(descriptor, acl + 16, 0, length);
  return descriptor;
}

const separator = (char: string | undefined) => char === "\\" || char === "/";
const extended = (path: string) => /^\\[\\?]\?\\/.test(path);

function normalize(path: string): string {
  if (extended(path)) return path;
  const spaces = path.search(/[^ ]|$/);
  const skip =
    separator(path[spaces]) ||
    (path[spaces + 1] === ":" && /[a-z]/i.test(path[spaces] ?? ""));
  let start = skip ? spaces : 0;
  let out = separator(path[start]) ? "\\" : "";
  if (out) start += 1;
  for (let i = start; i < path.length; i += 1)
    if (!separator(path[i])) out += path[i];
    else if (!separator(path[i + 1])) out += "\\";
  return out;
}

function rootLength(path: string): number {
  const prefixed = path.startsWith("\\\\?\\");
  const unc = path.startsWith("\\\\?\\UNC\\");
  if ((!prefixed || unc) && separator(path[0])) {
    if (!unc && !separator(path[1])) return 1;
    let left = 2;
    for (let i = unc ? 8 : 2; i < path.length; i += 1) {
      if (!separator(path[i])) continue;
      left -= 1;
      if (left === 0) return i;
    }
    return path.length;
  }
  const colon = prefixed ? 6 : 2;
  if (path.length < colon || path[colon - 1] !== ":") return 0;
  return separator(path[colon]) ? colon + 1 : colon;
}

export function directoryName(target: string): string | undefined {
  const device = extended(target) || /^[\\/]{2}[.?][\\/]/.test(target);
  const invalid = (char: string) => char < " " || '"<>|'.includes(char);
  if (!device && [...target].some(invalid)) return undefined;
  const path = normalize(target);
  if (!path.trim()) return undefined;
  const root = rootLength(path);
  if (path.length <= root) return undefined;
  let i = path.length - 1;
  while (i > root && !separator(path[i])) i -= 1;
  return path.slice(0, i);
}

function namesRoot(target: string): boolean {
  const full = win32.resolve(
    target.replace(/^\\\\\?\\(UNC\\)?/, (_, unc) => (unc ? "\\\\" : "")),
  );
  return win32.dirname(full) === full;
}

export function createPrivateWindowsDirectory(
  native: WindowsDirectoryCreator,
  target: string,
  clock: CreationClock,
): WindowsCreation {
  const expired = () => clock.now() >= clock.end;
  if (target.includes("\0") || expired()) return "refused";
  const parent = directoryName(target);
  if (!parent || namesRoot(target) || !native.isDirectory(parent))
    return "refused";
  const descriptor = privateDescriptor(native.user(), true);
  const name = `.forge-private-${randomUUID().replaceAll("-", "")}`;
  const staging = /[\\/:]$/.test(parent) ? parent + name : `${parent}\\${name}`;
  if (expired() || !native.createDirectory(staging, descriptor))
    return "refused";
  let published = false;
  try {
    if (!verifyWindowsDescriptor(native, staging, "dir", false) || expired())
      return "refused";
    published = native.move(staging, target);
    if (!published) return "refused";
  } finally {
    if (!published) native.removeDirectory(staging);
  }
  return verifyWindowsDescriptor(native, target, "dir", false)
    ? "private"
    : "published_unverified";
}
