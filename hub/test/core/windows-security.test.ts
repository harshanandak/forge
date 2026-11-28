import { expect, test } from "bun:test";
import { verifyWindowsDescriptor } from "../../src/core/windows-security.ts";
import { fixtures } from "./protect-windows-fixture.ts";
import { reference } from "./protect-windows-reference.ts";

test.skipIf(process.platform !== "win32")(
  "portable ACL predicates match Windows PowerShell across rows 01–29",
  () => {
    const fixture = fixtures();
    const oracle = reference(fixture.cases.map(({ request }) => request));
    expect(oracle).toHaveLength(fixture.cases.length);
    const observations = fixture.cases.map(
      ({ row, variant, request, expected }, index) => {
        const result = verifyWindowsDescriptor(
          {
            user: () => fixture.user,
            read(path, directory) {
              const entry = request.descriptors[path];
              if (!entry || entry.directory !== directory)
                throw new Error("Cannot read fixture path");
              return Buffer.from(entry.bytes, "base64");
            },
          },
          request.path,
          request.kind,
          request.chain,
        );
        return {
          row,
          variant,
          expected,
          reference: oracle[index]!.ok,
          core: result,
        };
      },
    );
    for (const result of observations) console.log(JSON.stringify(result));
    expect(observations.map(({ reference }) => reference)).toEqual(
      observations.map(({ expected }) => expected),
    );
    expect(observations.map(({ core }) => core)).toEqual(
      observations.map(({ reference }) => reference),
    );
    const rows = [
      ...new Set(observations.map(({ row }) => Number.parseInt(row, 10))),
    ].sort((a, b) => a - b);
    expect(rows).toEqual(Array.from({ length: 29 }, (_, index) => index + 1));
    console.log(
      `REFERENCE COVERED ${rows.length} OF 29: ${observations.length} cases`,
    );
  },
  60_000,
);
