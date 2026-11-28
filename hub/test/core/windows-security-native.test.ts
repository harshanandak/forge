import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { WindowsSecurityReader } from "../../src/contract/windows-security.ts";
import { decodeWindowsDescriptor } from "../../src/core/windows-security-read.ts";
import { verifyWindowsDescriptor } from "../../src/core/windows-security.ts";
import {
  nativeFixtures,
  type HandleProbe,
} from "./protect-windows-native-fixture.ts";
import { reference, type DiskRequest } from "./protect-windows-reference.ts";

const adapter = new URL(
  "../../src/adapters/windows-security.ts",
  import.meta.url,
);

function withReadFault(
  reader: WindowsSecurityReader,
  request: DiskRequest,
): WindowsSecurityReader {
  return {
    user: () => reader.user(),
    read(path, directory) {
      if (path !== request.fault) return reader.read(path, directory);
      if (!request.bytes)
        throw new Error("Injected security descriptor failure");
      return Buffer.from(request.bytes, "base64");
    },
  };
}

function readsEmptyAncestor(probe: HandleProbe, owner: string): boolean {
  if (probe.OpenError || probe.AclError || !probe.Descriptor) return false;
  const directory =
    probe.KindError === 0 && probe.Directory && probe.ReparseError === 4390;
  const descriptor = decodeWindowsDescriptor(
    Buffer.from(probe.Descriptor, "base64"),
  );
  return (
    directory && descriptor.owner === owner && descriptor.dacl?.length === 0
  );
}

test.skipIf(process.platform !== "win32")(
  "Windows same-handle ACL reader matches PowerShell across rows 01–29",
  async () => {
    const reader = existsSync(adapter)
      ? await (
          (await import(adapter.href)) as {
            windowsSecurityReader(): Promise<WindowsSecurityReader>;
          }
        ).windowsSecurityReader()
      : undefined;
    const fixtures = await nativeFixtures();
    try {
      const oracle = reference(fixtures.cases.map(({ request }) => request));
      expect(oracle).toHaveLength(fixtures.cases.length);
      const observations = fixtures.cases.map(
        ({ row, variant, request, expected, stored }, index) => ({
          row,
          variant,
          expected,
          stored,
          reference: oracle[index]!.ok,
          native: reader
            ? verifyWindowsDescriptor(
                withReadFault(reader, request),
                request.path,
                request.kind,
                request.chain,
              )
            : "native reader absent",
        }),
      );
      for (const result of observations) console.log(JSON.stringify(result));
      const emptyAncestor = fixtures.cases.find(
        ({ row }) => row === "26",
      )?.probe;
      if (!emptyAncestor)
        throw new Error("Missing empty ancestor handle probe");
      const readControl = readsEmptyAncestor(
        emptyAncestor.readControl,
        emptyAncestor.owner,
      );
      const withAttributes = readsEmptyAncestor(
        emptyAncestor.withAttributes,
        emptyAncestor.owner,
      );
      const overlapped = readsEmptyAncestor(
        emptyAncestor.overlapped,
        emptyAncestor.owner,
      );
      const nativeOpen = readsEmptyAncestor(
        emptyAncestor.nativeOpen,
        emptyAncestor.owner,
      );
      console.log(
        JSON.stringify({
          row: "26",
          handleProbe: emptyAncestor,
          readControl,
          withAttributes,
          overlapped,
          nativeOpen,
        }),
      );
      expect(observations.map(({ reference }) => reference)).toEqual(
        observations.map(({ expected }) => expected),
      );
      expect(readControl || withAttributes || overlapped || nativeOpen).toBe(
        true,
      );
      expect(observations.map(({ native }) => native)).toEqual(
        observations.map(({ reference }) => reference),
      );
      const rows = [
        ...new Set(observations.map(({ row }) => Number.parseInt(row, 10))),
      ].sort((a, b) => a - b);
      expect(rows).toEqual(Array.from({ length: 29 }, (_, index) => index + 1));
      console.log(
        `NATIVE COVERED ${rows.length} OF 29: ${observations.length} cases`,
      );
    } finally {
      await fixtures.close();
    }
  },
  60_000,
);
