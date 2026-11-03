import { expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveBlock, sourceFor } from "../../src/assembly/capture.ts";
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { runCli } from "../../src/surface/cli.ts";

setDefaultTimeout(30_000);

const example = resolve(import.meta.dirname, "../../examples/hello-block");

for (const [spec, displayed, suggestion] of [
  ["blocks/foo", '"blocks/foo"', '"./blocks/foo"'],
  ["blocks\\foo", '"blocks\\\\foo"', '"./blocks/foo"'],
  [
    "blocks/foo\nINJECTED",
    '"blocks/foo\\nINJECTED"',
    '"./blocks/foo\\nINJECTED"',
  ],
  [
    "blocks/foo\rINJECTED",
    '"blocks/foo\\rINJECTED"',
    '"./blocks/foo\\rINJECTED"',
  ],
  ["blocks/\u001b[2Jfoo", '"blocks/\\u001b[2Jfoo"', '"./blocks/\\u001b[2Jfoo"'],
  ["blocks/\u2028foo", '"blocks/\\u2028foo"', '"./blocks/\\u2028foo"'],
  ["blocks/\u2029foo", '"blocks/\\u2029foo"', '"./blocks/\\u2029foo"'],
  ['blocks/"foo', '"blocks/\\"foo"', '"./blocks/\\"foo"'],
  [
    "x".repeat(3000) + "/foo",
    '"' + "x".repeat(200) + '..."',
    '"./' + "x".repeat(198) + '..."',
  ],
] as const) {
  for (const verb of ["check", "add"]) {
    test(`${verb} refuses ${displayed} with an explicit local path hint and unchanged config`, async () => {
      const root = mkdtempSync(join(tmpdir(), "forge-block-source-"));
      let assembly: Awaited<ReturnType<typeof createAssembly>> | undefined;
      try {
        cpSync(example, join(root, "blocks/foo"), { recursive: true });
        mkdirSync(join(root, ".forge"));
        const config = join(root, ".forge/config.yaml");
        writeFileSync(
          config,
          "# Keep this config byte for byte.\nblocks: {}\n",
        );
        const before = readFileSync(config);
        assembly = await createAssembly({
          root,
          deviceRoot: join(root, "device"),
          providers: { env: {} },
        });
        const reply = await runCli(
          assembly.catalog,
          ["block", verb, spec],
          localCall(assembly),
        );
        expect(reply.exitCode).toBe(6);
        expect(reply.envelope).toMatchObject({
          ok: false,
          error: { code: "INPUT_INVALID", retry: "never" },
        });
        expect(readFileSync(config)).toEqual(before);
        if (reply.envelope.ok) throw new Error("expected invalid package name");
        expect(reply.envelope.error.message).toContain(displayed);
        expect(reply.envelope.error.message).toContain("not a package name");
        expect(reply.envelope.error.message).toContain("local block folder");
        expect(reply.envelope.error.message).toContain(suggestion);
        expect(reply.envelope.error.message).toContain("./");
        expect(
          Array.from(reply.envelope.error.message, (c) =>
            c.charCodeAt(0),
          ).filter(
            (code) =>
              code < 32 ||
              (code >= 0x7f && code <= 0x9f) ||
              code === 0x2028 ||
              code === 0x2029,
          ),
        ).toEqual([]);
        expect(reply.envelope.error.message.length).toBeLessThanOrEqual(4000);
      } finally {
        await assembly?.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("explicit relative paths still check and add the local block", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-block-explicit-"));
  let assembly: Awaited<ReturnType<typeof createAssembly>> | undefined;
  try {
    cpSync(example, join(root, "blocks/foo"), { recursive: true });
    assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
      providers: { env: {} },
    });
    expect(sourceFor("./blocks/foo")).toEqual({ path: "./blocks/foo" });
    expect(resolveBlock(root, sourceFor("./blocks/foo"))).toBe(
      join(root, "blocks/foo"),
    );
    for (const verb of ["check", "add"]) {
      const reply = await runCli(
        assembly.catalog,
        ["block", verb, "./blocks/foo"],
        localCall(assembly),
      );
      expect(reply.exitCode).toBe(0);
      expect(reply.envelope).toMatchObject({
        ok: true,
        result: { blockId: "example.org/hello" },
      });
    }
    expect(readFileSync(join(root, ".forge/config.yaml"), "utf8")).toContain(
      "./blocks/foo",
    );
  } finally {
    await assembly?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const spec of ["hello-block", "@example/hello-block"]) {
  test(`valid package ${spec} keeps installed-package lookup despite a local folder`, () => {
    const root = mkdtempSync(join(tmpdir(), "forge-block-package-"));
    try {
      mkdirSync(join(root, spec), { recursive: true });
      const installed = join(root, "node_modules", spec);
      mkdirSync(installed, { recursive: true });
      expect(sourceFor(spec)).toEqual({ package: spec });
      expect(resolveBlock(root, sourceFor(spec))).toBe(installed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("invalid specs without separators keep the original refusal", () => {
  expect(() =>
    resolveBlock(import.meta.dirname, sourceFor("invalid name")),
  ).toThrow("INPUT_INVALID: Expected an installed package name");
});
