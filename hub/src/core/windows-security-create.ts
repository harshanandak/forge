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

const reserved = (char: string) => char < " " || '"<>|*?:'.includes(char);

function canonical(target: string): boolean {
  if (target.length >= 260 || target !== win32.resolve(target)) return false;
  const drive = /^[a-z]:\\/i.test(target);
  if (!drive && !/^\\\\[^\\]+\\[^\\]+/.test(target)) return false;
  return target
    .slice(drive ? 3 : 2)
    .split("\\")
    .every(
      (part) =>
        part.length <= 255 && !/[. ]$/.test(part) && ![...part].some(reserved),
    );
}

export function createPrivateWindowsDirectory(
  native: WindowsDirectoryCreator,
  target: string,
  clock: CreationClock,
): WindowsCreation {
  const expired = () => clock.now() >= clock.end;
  if (expired() || !canonical(target)) return "refused";
  const parent = win32.dirname(target);
  if (parent === target || !native.isDirectory(parent)) return "refused";
  const descriptor = privateDescriptor(native.user(), true);
  const name = `.forge-private-${randomUUID().replaceAll("-", "")}`;
  const staging = win32.join(parent, name);
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
