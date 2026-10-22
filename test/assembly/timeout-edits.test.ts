import {
  afterEach,
  beforeEach,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { runCli } from "../../src/surface/cli.ts";
import { blockCapture } from "../../src/assembly/capture.ts";

setDefaultTimeout(30_000);

let root: string;
let file: string;
let assembly: Awaited<ReturnType<typeof createAssembly>>;
let restore: () => void;
const initial = JSON.stringify({ blocks: { check: { commands: {} } } });
const patch = [
  {
    op: "set",
    path: "/blocks/check/operationTimeouts",
    value: { "check.rnu": 3000 },
  },
];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-timeout-edits-"));
  mkdirSync(join(root, ".forge"));
  file = join(root, ".forge/config.yaml");
  writeFileSync(file, initial);
  const open = blockCapture.open.bind(blockCapture);
  const capture = spyOn(blockCapture, "open").mockImplementation((path) => {
    const handle = open(path);
    return {
      ...handle,
      value: {
        read: (name, budget) =>
          name.endsWith(".cjs")
            ? new TextEncoder().encode("module.exports={};")
            : handle.value.read(name, budget),
      },
    };
  });
  restore = () => capture.mockRestore();
  assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
    providers: { env: {} },
  });
});

afterEach(async () => {
  await assembly.close();
  restore();
  rmSync(root, { recursive: true, force: true });
});

const call = async (noun: string, verb: string, input: unknown) =>
  (
    await runCli(
      assembly.catalog,
      [noun, verb, "--input", JSON.stringify(input)],
      localCall(assembly),
    )
  ).envelope;
const revision = async () => {
  const shown = await call("config", "show", {});
  return (shown.result as { revision: string }).revision;
};

test("preview reports the undeclared timeout key without writing", async () => {
  const preview = await call("config", "preview", { patch });
  expect(preview, JSON.stringify(preview)).toMatchObject({
    result: { valid: false, error: { code: "INPUT_INVALID" } },
  });
  expect(JSON.stringify(preview.result)).toContain("check.rnu");
  expect(readFileSync(file, "utf8")).toBe(initial);
});

for (const verb of ["apply", "set"] as const)
  test(`${verb} refuses undeclared timeout keys before writing`, async () => {
    const expectRevision = await revision();
    const input =
      verb === "apply"
        ? { patch, expectRevision }
        : { path: patch[0]!.path, value: patch[0]!.value, expectRevision };
    const result = await call("config", verb, input);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INPUT_INVALID" },
    });
    expect(JSON.stringify(result)).toContain("check.rnu");
    expect(readFileSync(file, "utf8")).toBe(initial);
  });

test("template import refuses undeclared timeout keys before writing", async () => {
  writeFileSync(
    join(root, "bad.json"),
    JSON.stringify({
      schemaVersion: "forge.template/1",
      id: "example.org/bad",
      version: "1.0.0",
      summary: "bad timeout",
      config: {
        schemaVersion: "forge.config/1",
        blocks: {
          check: {
            source: { builtin: "forge/check" },
            operationTimeouts: { "check.rnu": 3000 },
          },
        },
      },
    }),
  );
  const result = await call("template", "import", {
    template: "bad.json",
    expectRevision: await revision(),
  });
  expect(result).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
  expect(JSON.stringify(result)).toContain("check.rnu");
  expect(readFileSync(file, "utf8")).toBe(initial);
});

test("source and timeout edits validate the completed proposed document", async () => {
  const switchPatch = [
    {
      op: "set",
      path: "/blocks/check/operationTimeouts",
      value: { "memory.search": 3000 },
    },
    {
      op: "set",
      path: "/blocks/check/source",
      value: { builtin: "forge/memory" },
    },
    { op: "set", path: "/blocks/check/config", value: {} },
  ];
  expect(
    (await call("config", "preview", { patch: switchPatch })).result,
  ).toMatchObject({ valid: true });
  expect(
    await call("config", "apply", {
      patch: switchPatch,
      expectRevision: await revision(),
    }),
  ).toMatchObject({ ok: true });
  expect((await call("config", "show", {})).result).toMatchObject({
    valid: true,
  });
  const invalidSwitch = [
    {
      op: "set",
      path: "/blocks/check/source",
      value: { builtin: "forge/check" },
    },
    { op: "set", path: "/blocks/check/config", value: { commands: {} } },
  ];
  const invalid = await call("config", "preview", { patch: invalidSwitch });
  expect(invalid.result).toMatchObject({ valid: false });
  expect(JSON.stringify(invalid.result)).toContain("memory.search");
});

for (const [name, repair] of [
  [
    "removing",
    [{ op: "remove", path: "/blocks/check/operationTimeouts/check.rnu" }],
  ],
  [
    "fixing",
    [
      {
        op: "set",
        path: "/blocks/check/operationTimeouts",
        value: { "check.run": 3000 },
      },
    ],
  ],
] as const)
  test(`${name} an existing bad timeout key remains possible`, async () => {
    writeFileSync(
      file,
      JSON.stringify({
        blocks: {
          check: { commands: {}, operationTimeouts: { "check.rnu": 3000 } },
        },
      }),
    );
    expect(
      (await call("config", "preview", { patch: repair })).result,
    ).toMatchObject({ valid: true });
    expect(
      await call("config", "apply", {
        patch: repair,
        expectRevision: await revision(),
      }),
    ).toMatchObject({ ok: true });
    expect((await call("config", "show", {})).result).toMatchObject({
      valid: true,
    });
  });
