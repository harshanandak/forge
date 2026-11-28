import { win32 } from "node:path";
import type { WindowsSecurityReader } from "../contract/windows-security.ts";
import {
  decodeWindowsDescriptor,
  readSid,
  type WindowsAce,
  type WindowsDescriptor,
} from "./windows-security-read.ts";

const allowed = [0, 5, 9, 11];
const denied = [1, 6, 10, 12];
const auditOrAlarm = [2, 3, 7, 8, 13, 14, 15, 16];
const fullControl = 0x001f01ff;
const replacementRights = 0x500d0040;
const inheritOnly = 8;
const inherited = 16;
const trustedOwners = [
  "S-1-5-18",
  "S-1-5-32-544",
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
];

function normalizedAcl(aces: WindowsAce[] | null, directory: boolean) {
  if (!aces) return null;
  return aces.flatMap((ace) => {
    if (ace.mask === 0 || auditOrAlarm.includes(ace.type)) return [];
    if (ace.flags & inheritOnly && (!directory || !(ace.flags & 3))) return [];
    const discard = directory ? (ace.flags & 3 ? 0 : 4) : 15;
    return [{ ...ace, flags: ace.flags & ~(0xc0 | discard) }];
  });
}

function propagation(flags: number) {
  const children = flags & 3;
  const self = flags & inheritOnly ? 0 : 1;
  const grandchildren = flags & 4 ? 0 : children << 3;
  return self | (children << 1) | grandchildren;
}

function compactsToFullControl(first: WindowsAce, second: WindowsAce) {
  if (
    first.mask === null ||
    second.mask === null ||
    (first.flags | second.flags) & inherited ||
    !first.tail.equals(second.tail)
  )
    return false;
  if (first.flags === second.flags)
    return first.flags === 3 && (first.mask | second.mask) === fullControl;
  if (first.mask !== fullControl || second.mask !== fullControl) return false;
  if ((first.flags & 15) === (second.flags & 15)) return first.flags === 3;
  return (propagation(first.flags) | propagation(second.flags)) === 31;
}

function isPrivate(
  descriptor: WindowsDescriptor,
  user: string,
  directory: boolean,
  strict: boolean,
) {
  if (descriptor.owner !== user) return false;
  const aces = normalizedAcl(descriptor.dacl, directory);
  const first = aces?.[0];
  if (
    !aces ||
    !first ||
    !aces.every((ace) => ace.type === 0 && ace.sid === user)
  )
    return false;
  if (!strict) return true;
  if (!descriptor.protectedDacl) return false;
  const second = aces[1];
  if (!second) return first.flags === 3 && first.mask === fullControl;
  return aces.length === 2 && compactsToFullControl(first, second);
}

function safeAncestor(
  descriptor: WindowsDescriptor,
  trusted: ReadonlySet<string>,
) {
  if (!descriptor.owner || !trusted.has(descriptor.owner)) return false;
  const aces = normalizedAcl(descriptor.dacl, true);
  return (
    aces !== null &&
    aces.every((ace) => {
      if (denied.includes(ace.type)) return true;
      if (!allowed.includes(ace.type)) return false;
      const replacement =
        !(ace.flags & inheritOnly) && (ace.mask ?? 0) & replacementRights;
      return !replacement || trusted.has(ace.sid ?? "");
    })
  );
}

export function verifyWindowsDescriptor(
  reader: WindowsSecurityReader,
  target: string,
  kind: "dir" | "file",
  chain: boolean,
): boolean {
  if (target.includes("\0")) return false;
  try {
    const sid = reader.user();
    const user = readSid(sid, 0, sid.length).sid;
    const path = win32.resolve(target);
    const read = (path: string, directory: boolean) =>
      decodeWindowsDescriptor(reader.read(path, directory));
    if (chain) {
      const trusted = new Set([user, ...trustedOwners]);
      for (let dir = path; ; dir = win32.dirname(dir)) {
        if (!safeAncestor(read(dir, true), trusted)) return false;
        if (win32.dirname(dir) === dir) break;
      }
    }
    const directory = kind === "dir";
    return isPrivate(
      read(path, directory),
      user,
      directory,
      directory && !chain,
    );
  } catch {
    return false;
  }
}
