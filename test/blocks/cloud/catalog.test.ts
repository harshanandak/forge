// The forge/cloud block: cloud.login is declared in a block, so the catalog, the CLI and MCP all come
// from that one declaration. Nothing here reaches a network.
import { afterEach, expect, spyOn, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blockCapture } from "../../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../../src/assembly/first-party.ts";
import { createAssembly, type Assembly } from "../../../src/assembly/index.ts";
import { runCli } from "../../../src/surface/cli.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import type {
  AmbientContext,
  ResultEnvelope,
} from "../../../src/generated/types.ts";
import {
  approved,
  credentialJson,
  json,
  network,
  ORIGIN,
  PROJECT,
  PROJECT_ID,
  SECRET,
  startBody,
  pending,
  type Step,
} from "../../assembly/cloud-fixture.ts";

const repo = resolve(import.meta.dirname, "../../..");
const transpiler = new Bun.Transpiler({ loader: "ts" });

interface Open {
  readonly assembly: Assembly;
  readonly root: string;
  /** The checkout root, which holds the project identity and the binding. */
  readonly checkout: string;
  readonly home: string;
  readonly net: ReturnType<typeof network>;
  readonly lines: string[];
  readonly ambient: AmbientContext;
  readonly close: () => Promise<void>;
}
let open: Open | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** The block as the build leaves it: its folder, with the entry emitted from its .cts source. */
function stage(into: string): string {
  const target = join(into, "cloud");
  cpSync(join(repo, "src/blocks/cloud"), target, {
    recursive: true,
    filter: (path) => !path.endsWith(".cts"),
  });
  writeFileSync(
    join(target, "entry.cjs"),
    transpiler.transformSync(
      readFileSync(join(repo, "src/blocks/cloud/entry.cts"), "utf8"),
    ),
  );
  return target;
}

async function openCloud(
  steps: Step[],
  options: { nested?: boolean; renames?: readonly string[] } = {},
): Promise<Open> {
  const work = mkdtempSync(join(tmpdir(), "forge-cloud-block-"));
  const checkout = join(work, "project");
  // A nested call: the assembly runs from a folder inside the checkout, whose root holds .git.
  const root = options.nested === true ? join(checkout, "pkg") : checkout;
  if (options.nested === true)
    mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(join(checkout, ".forge"), { recursive: true });
  const home = join(work, "home");
  const deviceRoot = join(work, "device");
  mkdirSync(join(root, ".forge"), { recursive: true });
  mkdirSync(home);
  writeFileSync(
    join(root, ".forge", "config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks:
        options.renames === undefined
          ? { cloud: { source: { builtin: "forge/cloud" } } }
          : Object.fromEntries(
              options.renames.map((noun) => [
                noun,
                {
                  source: { builtin: "forge/cloud" },
                  rename: { cloud: noun },
                },
              ]),
            ),
    }),
  );
  writeFileSync(
    join(checkout, ".forge", "project.json"),
    `${JSON.stringify({ schema: 1, id: PROJECT_ID })}\n`,
  );
  const staged = stage(join(work, "builtins"));
  const source = fileURLToPath(firstPartyBlocks["forge/cloud"]!);
  const original = blockCapture.open.bind(blockCapture);
  const capture = spyOn(blockCapture, "open").mockImplementation((path) =>
    original(path === source ? staged : path),
  );
  const net = network(...steps);
  const lines: string[] = [];
  const assembly = await createAssembly({
    root,
    deviceRoot,
    providers: {
      env: {
        HOME: home,
        USERPROFILE: home,
        FORGE_DEVICE_ID: "dev-1",
        FORGE_NO_BROWSER: "1",
      },
      cloudLogin: {
        fetch: net.fetch,
        wait: () => Promise.resolve(),
        progress: (line) => lines.push(line),
      },
    },
  });
  return {
    assembly,
    root,
    checkout,
    home,
    net,
    lines,
    ambient: {
      actor: { kind: "human", id: "tester" },
      project: { id: assembly.root, root: assembly.root },
      device: { id: assembly.deviceRoot },
    },
    close: async () => {
      await assembly.close();
      capture.mockRestore();
      rmSync(work, { recursive: true, force: true });
    },
  };
}

function call(
  o: Open,
  input: unknown,
  more: { caller?: "agent" | "human"; dryRun?: boolean } = {},
): Promise<ResultEnvelope> {
  return o.assembly.catalog.invoke({
    schemaVersion: "forge.invocation/1",
    requestId: "cloud-1",
    op: "cloud.login",
    input,
    caller: more.caller ?? "human",
    context: o.ambient,
    ...(more.dryRun === undefined ? {} : { dryRun: more.dryRun }),
  });
}

const INPUT = { origin: ORIGIN, project: PROJECT };
const login: Step[] = [
  () => json(startBody()),
  pending,
  () => approved(credentialJson(Date.now())),
];

test("forge/cloud is a registered first-party source that resolves to its folder", () => {
  expect(Object.keys(firstPartyBlocks)).toContain("forge/cloud");
  expect(
    fileURLToPath(firstPartyBlocks["forge/cloud"]!).replaceAll("\\", "/"),
  ).toMatch(/src\/blocks\/cloud\/?$/);
}, 30_000);

test("cloud.login is declared by the block for a person only, so it is in the catalog and not an MCP tool", async () => {
  open = await openCloud(login);
  const entry = open.assembly.catalog
    .list()
    .find((candidate) => candidate.op === "cloud.login");
  expect(entry).toBeDefined();
  expect(entry?.admitted).toBe(true);
  expect(entry?.declaration.callers).toEqual(["human"]);
  expect(entry?.declaration.context).toBe("device");
  expect(entry?.declaration.effects).toEqual([
    "files:write",
    "external:forge-cloud",
    "external:process",
  ]);
  expect(entry?.declaration.idempotent).toBe(false);
  expect(entry?.docs.title.length).toBeGreaterThan(0);
  // The input schema names the two fields and does not constrain the top-level type, so every input
  // reaches the service, which gives the one fixed refusal; the shared validator would echo a value.
  expect(Object.keys(entry?.inputSchema.properties ?? {})).toEqual([
    "origin",
    "project",
  ]);
  expect(entry?.inputSchema.type).toBeUndefined();
  expect(entry?.outputSchema?.type).toBe("object");
  const tools = createMcpHandlers(open.assembly.catalog, { budget: 100 })
    .listTools()
    .map((tool) => tool.name);
  expect(tools).not.toContain("cloud_login");
}, 60_000);

test("a person's login runs through the catalog: code printed, credential saved, binding written, token never returned", async () => {
  open = await openCloud(login);
  const envelope = await call(open, INPUT);
  expect(envelope).toMatchObject({
    ok: true,
    op: "cloud.login",
    status: "OK",
    result: {
      origin: ORIGIN,
      project: PROJECT,
      device: "dev-1",
      tokenId: "0123456789abcdef",
      binding: "created",
    },
  });
  expect(open.net.calls.map((c) => c.url.split("/").pop())).toEqual([
    "loginstart",
    "loginpoll",
    "loginpoll",
  ]);
  expect(open.lines.some((line) => line.includes("BCDF-GHJK"))).toBe(true);
  expect(
    existsSync(join(open.home, ".forge", "cloud", "credentials.json")),
  ).toBe(true);
  expect(existsSync(join(open.root, ".forge", "cloud.json"))).toBe(true);
  const text = JSON.stringify(envelope) + open.lines.join("\n");
  expect(text).not.toContain("fct_");
  expect(text).not.toContain(SECRET);
}, 60_000);

test("a login from a folder inside the checkout reads and writes the checkout root's files", async () => {
  open = await openCloud(login, { nested: true });
  expect(open.root).not.toBe(open.checkout);
  const envelope = await call(open, INPUT);
  expect(envelope.ok).toBe(true);
  expect(existsSync(join(open.checkout, ".forge", "cloud.json"))).toBe(true);
  expect(existsSync(join(open.root, ".forge", "cloud.json"))).toBe(false);
}, 60_000);

test("an agent caller and a dry run are refused before any request", async () => {
  open = await openCloud(login);
  const agent = await call(open, INPUT, { caller: "agent" });
  expect(agent.ok).toBe(false);
  const preview = await call(open, INPUT, { dryRun: true });
  expect(preview.ok).toBe(false);
  expect(open.net.calls).toHaveLength(0);
  expect(
    existsSync(join(open.home, ".forge", "cloud", "credentials.json")),
  ).toBe(false);
}, 60_000);

test("an input that carries a token is refused as invalid and the value is never echoed", async () => {
  open = await openCloud(login);
  const envelope = await call(open, { ...INPUT, token: "fct_x" });
  expect(envelope.ok).toBe(false);
  if (!envelope.ok) expect(envelope.error.code).toBe("INPUT_INVALID");
  expect(JSON.stringify(envelope)).not.toContain("fct_x");
  // The credential as a property name is not echoed either.
  const named = await call(open, { [`fct_0123456789abcdef.${SECRET}`]: 1 });
  expect(named.ok).toBe(false);
  expect(JSON.stringify(named)).not.toContain("fct_");
  expect(JSON.stringify(named)).not.toContain(SECRET);
  expect(open.net.calls).toHaveLength(0);
}, 60_000);

for (const noun of ["first", "second"]) {
  test(`two cloud instances preserve ${noun} CLI spelling and help`, async () => {
    open = await openCloud([], { renames: ["first", "second"] });
    const options = { caller: "human" as const, context: open.ambient };
    const help = await runCli(open.assembly.catalog, ["--help"], options);
    expect(help.exitCode).toBe(0);
    for (const name of ["first", "second"]) expect(help.stdout).toContain(name);
    const reply = await runCli(
      open.assembly.catalog,
      [
        noun,
        "login",
        "--input",
        '{"origin":"http://invalid","project":"proj"}',
      ],
      options,
    );
    expect(reply.exitCode).toBe(6);
    expect(JSON.parse(reply.stdout)).toMatchObject({
      op: `${noun}.login`,
      error: { code: "INPUT_INVALID" },
    });
    expect(open.net.calls).toHaveLength(0);
  }, 60_000);
}
