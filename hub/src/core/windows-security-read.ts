const objectTypes = [5, 6, 7, 8, 11, 12, 15, 16];

export type WindowsAce = {
  type: number;
  flags: number;
  mask: number | null;
  sid: string | null;
  tail: Buffer;
};
export type WindowsDescriptor = {
  owner: string | null;
  protectedDacl: boolean;
  dacl: WindowsAce[] | null;
};

function invalid(): never {
  throw new Error("Invalid Windows security descriptor");
}

export function readSid(bytes: Buffer, offset: number, end: number) {
  const count = bytes.readUInt8(offset + 1);
  const next = offset + 8 + 4 * count;
  if (bytes.readUInt8(offset) !== 1 || count > 15 || next > end) invalid();
  let sid = `S-1-${bytes.readUIntBE(offset + 2, 6)}`;
  for (let pos = offset + 8; pos < next; pos += 4)
    sid += `-${bytes.readUInt32LE(pos)}`;
  return { sid, next };
}

function readAcl(bytes: Buffer, offset: number): WindowsAce[] {
  const end = offset + bytes.readUInt16LE(offset + 2);
  const count = bytes.readUInt16LE(offset + 4);
  let start = offset + 8;
  if (offset < 20 || end < start || end > bytes.length) invalid();
  const aces = [];
  for (let i = 0; i < count; i++) {
    const type = bytes.readUInt8(start);
    const flags = bytes.readUInt8(start + 1);
    const size = bytes.readUInt16LE(start + 2);
    const next = start + size;
    if (size < 4 || size % 4 !== 0 || next > end) invalid();
    if (type > 16) {
      const tail = bytes.subarray(next, next);
      aces.push({ type, flags, mask: null, sid: null, tail });
    } else {
      const mask = bytes.readUInt32LE(start + 4);
      let sidOffset = start + 8;
      if (objectTypes.includes(type)) {
        const objectFlags = bytes.readUInt32LE(sidOffset);
        sidOffset +=
          4 + (objectFlags & 1 ? 16 : 0) + (objectFlags & 2 ? 16 : 0);
      } else if (type === 4) sidOffset += 4;
      const { sid, next: sidEnd } = readSid(bytes, sidOffset, next);
      aces.push({ type, flags, mask, sid, tail: bytes.subarray(sidEnd, next) });
    }
    start = next;
  }
  return aces;
}

export function decodeWindowsDescriptor(bytes: Buffer): WindowsDescriptor {
  const flags = bytes.readUInt16LE(2);
  if (bytes.readUInt8(0) !== 1 || !(flags & 0x8000)) invalid();
  const sidAt = (position: number) => {
    const offset = bytes.readUInt32LE(position);
    if (offset === 0) return null;
    if (offset < 20) invalid();
    return readSid(bytes, offset, bytes.length).sid;
  };
  const owner = sidAt(4);
  sidAt(8);
  const offset = bytes.readUInt32LE(16);
  return {
    owner,
    protectedDacl: Boolean(flags & 0x1000),
    dacl: flags & 4 && offset ? readAcl(bytes, offset) : null,
  };
}
