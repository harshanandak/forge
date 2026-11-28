import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { WindowsSecurityReader } from "../../src/contract/windows-security.ts";
import {
  decodeWindowsDescriptor,
  readSid,
} from "../../src/core/windows-security-read.ts";
import { verifyWindowsDescriptor } from "../../src/core/windows-security.ts";
import { nativeFixtures } from "./protect-windows-native-fixture.ts";
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
      expect(observations.map(({ reference }) => reference)).toEqual(
        observations.map(({ expected }) => expected),
      );
      const user = reader!.user();
      const me = readSid(user, 0, user.length).sid;
      for (const [
        index,
        { variant, request, stored },
      ] of fixtures.cases.entries()) {
        if (!variant.endsWith("junction")) continue;
        const bytes = stored.at(-1)!;
        const link = decodeWindowsDescriptor(Buffer.from(bytes, "base64"));
        expect([
          link.owner,
          link.protectedDacl,
          link.dacl?.map(({ type, mask, sid }) => [type, mask, sid]),
        ]).toEqual([me, true, [[0, 0x1f01ff, me]]]);
        const linkDescriptor = withReadFault(reader!, {
          ...request,
          fault: request.path,
          bytes,
        });
        expect(
          verifyWindowsDescriptor(
            linkDescriptor,
            request.path,
            request.kind,
            request.chain,
          ),
        ).toBe(true);
        const { native, reference } = observations[index]!;
        expect([variant, native, reference]).toEqual([variant, false, false]);
        expect(() => reader!.read(request.path, true)).toThrow(
          "Cannot verify Windows reparse status: 0",
        );
      }
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
