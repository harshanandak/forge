import { expect, test } from "bun:test";
import { decodeWindowsDescriptor } from "../../src/core/windows-security-read.ts";
import { verifyWindowsDescriptor } from "../../src/core/windows-security.ts";
import { fixtures } from "./protect-windows-fixture.ts";
import { reference } from "./protect-windows-reference.ts";

const systemSid = Buffer.from("010100000000000512000000", "hex");
const everyoneSid = Buffer.from("010100000000000100000000", "hex");
const path = "C:\\forge-acl-malformed";

function ace(type: number, flags: number, body: Buffer, opaque = 0) {
  const bytes = Buffer.alloc(4 + body.length + opaque);
  bytes[0] = type;
  bytes[1] = flags;
  bytes.writeUInt16LE(bytes.length, 2);
  body.copy(bytes, 4);
  return bytes;
}

function descriptor(owner: Buffer, otherAce?: Buffer, sacl?: Buffer) {
  const ownerMask = Buffer.from("ff011f00", "hex");
  const ownerAce = ace(0, 3, Buffer.concat([ownerMask, owner]));
  const aces = otherAce ? [otherAce, ownerAce] : [ownerAce];
  const acl = Buffer.alloc(8);
  acl[0] = 4;
  acl.writeUInt16LE(8 + ownerAce.length + (otherAce?.length ?? 0), 2);
  acl.writeUInt16LE(aces.length, 4);
  const dacl = Buffer.concat([acl, ...aces]);
  const header = Buffer.alloc(20);
  header[0] = 1;
  header.writeUInt16LE(sacl ? 0x9014 : 0x9004, 2);
  header.writeUInt32LE(header.length, 4);
  header.writeUInt32LE(header.length + owner.length, 8);
  const daclOffset = header.length + 2 * owner.length;
  if (sacl) header.writeUInt32LE(daclOffset + dacl.length, 12);
  header.writeUInt32LE(daclOffset, 16);
  return Buffer.concat([header, owner, owner, dacl, sacl ?? Buffer.alloc(0)]);
}

function cases(owner: Buffer) {
  const compound = Buffer.concat([
    Buffer.from("0000000001000000", "hex"),
    systemSid,
  ]);
  const common = Buffer.concat([Buffer.alloc(4), everyoneSid]);
  const object = Buffer.concat([Buffer.alloc(8), everyoneSid]);
  const invalidSacl = Buffer.from("0200ffff01000000", "hex");
  return [
    {
      name: "compound ACE trailing bytes",
      bytes: descriptor(owner, ace(4, 0, compound, 4)),
      expected: false,
    },
    {
      name: "common callback ACE within opaque limit",
      bytes: descriptor(owner, ace(9, 8, common, 65456)),
      expected: true,
    },
    {
      name: "common callback ACE beyond opaque limit",
      bytes: descriptor(owner, ace(9, 8, common, 65460)),
      expected: false,
    },
    {
      name: "object callback ACE within opaque limit",
      bytes: descriptor(owner, ace(11, 0, object, 65420)),
      expected: true,
    },
    {
      name: "object callback ACE beyond opaque limit",
      bytes: descriptor(owner, ace(11, 0, object, 65424)),
      expected: false,
    },
    {
      name: "SACL header with truncated body",
      bytes: descriptor(owner, undefined, invalidSacl),
      expected: false,
    },
  ];
}

function isPrivate(owner: Buffer, bytes: Buffer) {
  return verifyWindowsDescriptor(
    { user: () => owner, read: () => bytes },
    path,
    "dir",
    false,
  );
}

for (const { name, bytes, expected } of cases(systemSid)) {
  test(`portable ACL decoder handles ${name}`, () => {
    if (expected) expect(() => decodeWindowsDescriptor(bytes)).not.toThrow();
    else expect(() => decodeWindowsDescriptor(bytes)).toThrow();
    expect(isPrivate(systemSid, bytes)).toBe(expected);
  }, 5_000);
}

test.skipIf(process.platform !== "win32")(
  "portable ACL byte cases match Windows PowerShell 5.1",
  () => {
    const { user } = fixtures();
    const vectors = cases(user);
    const oracle = reference(
      vectors.map(({ bytes }) => ({
        path,
        kind: "dir",
        chain: false,
        descriptors: {
          [path]: { directory: true, bytes: bytes.toString("base64") },
        },
      })),
    );
    expect(oracle).toHaveLength(vectors.length);
    const observations = vectors.map(({ name, bytes, expected }, index) => ({
      name,
      expected,
      reference: oracle[index]!.ok,
      core: isPrivate(user, bytes),
    }));
    for (const observation of observations)
      console.log(JSON.stringify(observation));
    expect(observations.map(({ reference }) => reference)).toEqual(
      observations.map(({ expected }) => expected),
    );
    expect(observations.map(({ core }) => core)).toEqual(
      observations.map(({ reference }) => reference),
    );
  },
  30_000,
);
