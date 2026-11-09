import { afterEach, beforeEach, expect, test } from "bun:test";
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
import {
  createAssembly,
  localCall,
  localContext,
  type Assembly,
} from "../../src/assembly/index.ts";
import { runCli } from "../../src/surface/cli.ts";
import { localIdentityResolver } from "../../src/assembly/identity.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import type { SurfaceCatalog } from "../../src/surface/catalog.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { relay } from "../fixtures/owner-approval.ts";
import { dispatch } from "../../src/surface/dispatch.ts";

const repo = resolve(import.meta.dirname, "../..");
let work: string;
let assembly: Assembly;

type Envelope = {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string };
};
/** `forge <argv>` through the generated CLI, as one plain command in the given session. */
async function forge(argv: readonly string[], session = "agent-one") {
  const previous = process.env.FORGE_SESSION;
  process.env.FORGE_SESSION = session;
  const options = localCall(assembly);
  if (previous === undefined) delete process.env.FORGE_SESSION;
  else process.env.FORGE_SESSION = previous;
  const response = await runCli(assembly.catalog, argv, options);
  return JSON.parse(response.stdout) as Envelope;
}

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "forge-held-"));
  const block = join(work, "blocks", "work");
  cpSync(join(repo, "src/blocks/work"), block, {
    recursive: true,
    filter: (path) => !path.endsWith(".cts"),
  });
  const source = readFileSync(join(repo, "src/blocks/work/entry.cts"), "utf8");
  writeFileSync(
    join(block, "entry.cjs"),
    new Bun.Transpiler({ loader: "ts" }).transformSync(source),
  );
  mkdirSync(join(work, ".forge"));
  writeFileSync(
    join(work, ".forge", "config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: {
        work: { source: { path: "./blocks/work" }, bind: { state: "core" } },
      },
    }),
  );
  assembly = await createAssembly({
    root: work,
    deviceRoot: join(work, "device"),
  });
  const digest = (await forge(["block", "check", "./blocks/work"])).result
    ?.digest as string;
  const approve = (op: string, input: Record<string, unknown>) =>
    relay(
      (op, input) => dispatch(assembly.catalog, op, input, localCall(assembly)),
      op,
      input,
    );
  expect((await approve("block.admit", { digest })).ok).toBe(true);
  const granted = await approve("config.grant", {
    digest,
    effects: [
      "issue:write",
      "external:process",
      "external:network",
      "environment:read",
    ],
  });
  expect(granted.ok).toBe(true);
}, 30_000);

afterEach(async () => {
  await assembly.close();
  rmSync(work, { recursive: true, force: true });
}, 30_000);

async function created(): Promise<string> {
  const issue = await forge([
    "issue",
    "create",
    "--input",
    JSON.stringify({ title: "Plain commands" }),
  ]);
  expect(issue.ok).toBe(true);
  return issue.result?.id as string;
}

test("claim, link and close are three plain commands in one session", async () => {
  const id = await created();
  const claimed = await forge(["issue", "claim", "--input", `{"id":"${id}"}`]);
  expect(claimed).toMatchObject({ ok: true, result: { id, generation: 1 } });
  const linked = await forge([
    "issue",
    "link",
    "--input",
    JSON.stringify({ id, relation: "pr", url: "https://example.com/pr/1" }),
  ]);
  expect(linked.ok).toBe(true);
  const withoutReceipt = "Lease fixture completed without delivery checks";
  const closed = await forge([
    "issue",
    "close",
    "--input",
    JSON.stringify({ id, withoutReceipt }),
  ]);
  expect(closed).toMatchObject({ ok: true, result: { id, status: "closed" } });
  const shown = await forge(["issue", "show", id]);
  expect(shown.result).toMatchObject({ id, status: "closed", withoutReceipt });
}, 30_000);

test("another session cannot link or close a claim it does not hold", async () => {
  const id = await created();
  expect((await forge(["issue", "claim", id])).ok).toBe(true);
  const link = JSON.stringify({ id, relation: "pr", url: "https://x.dev/1" });
  const withoutReceipt = "Lease fixture completed without delivery checks";
  const close = JSON.stringify({ id, withoutReceipt });
  for (const argv of [
    ["issue", "link", "--input", link],
    ["issue", "close", "--input", close],
  ]) {
    const refused = await forge(argv, "agent-two");
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "LEASE_NOT_HELD" },
    });
  }
  const shown = await forge(["issue", "show", id]);
  expect(shown.result?.status).toBe("open");
  expect((await forge(["issue", "close", "--input", close])).ok).toBe(true);
  const closed = await forge(["issue", "show", id]);
  expect(closed.result).toMatchObject({ id, status: "closed", withoutReceipt });
}, 30_000);

test("a held command on an unclaimed item still names the missing lease", async () => {
  const id = await created();
  const refused = await forge(["issue", "close", id]);
  expect(refused).toMatchObject({
    ok: false,
    error: { code: "CONTEXT_MISSING" },
  });
}, 30_000);

test("restricted MCP held writes find hidden lease reads without widening exposure or session authority", async () => {
  const id = await created();
  const mcp = (session: string) =>
    createMcpHandlers(
      assembly.catalog,
      { expose: ["issue.claim", "issue.link"] },
      {
        context: localContext(assembly, { kind: "agent", id: "mcp" }, session),
        resolveContext: localIdentityResolver(
          assembly.deviceRoot,
          { FORGE_SESSION: session },
          false,
        ),
      },
    );
  const holder = mcp("agent-one");
  expect(holder.listTools().map((tool) => tool.name)).not.toContain(
    "issue_show",
  );
  expect(await holder.callTool("issue_claim", { id })).toMatchObject({
    ok: true,
    result: { id, generation: 1 },
  });
  expect(
    await holder.callTool("catalog_call", { op: "issue.show", input: { id } }),
  ).toMatchObject({ ok: false, error: { code: "UNKNOWN_COMMAND" } });
  const input = { id, relation: "relates", url: "https://example.com/1" };
  expect(await holder.callTool("issue_link", input)).toMatchObject({
    ok: true,
  });
  const linked = { ...input, url: "https://example.com/2" };
  expect(
    await holder.callTool("catalog_call", { op: "issue.link", input: linked }),
  ).toMatchObject({ ok: true, result: { value: { url: linked.url } } });
  expect(
    await mcp("agent-two").callTool("catalog_call", {
      op: "issue.link",
      input: { ...input, url: "https://example.com/refused" },
    }),
  ).toMatchObject({ ok: false, error: { code: "LEASE_NOT_HELD" } });
  const links = await forge(["issue", "links", id]);
  expect(links).toMatchObject({
    ok: true,
    result: {
      records: [
        { value: { ...input, id: "work-1" } },
        { value: { ...linked, id: "work-1" } },
      ],
    },
  });
}, 30_000);

for (const [label, rejection] of [
  [
    "ForgeFailure",
    () =>
      new ForgeFailure({
        code: "INTERNAL",
        message: "hidden-show-diagnostic",
        retry: "never",
      }),
  ],
  ["Error", () => new Error("hidden-show-diagnostic")],
] as const)
  for (const thrown of [false, true])
    test(`a ${thrown ? "thrown" : "rejected"} hidden lease read (${label}) keeps the write's own result private`, async () => {
      const id = await created();
      const ops: string[] = [];
      const catalog: SurfaceCatalog = {
        list: () => assembly.catalog.list(),
        invoke: (request) => {
          ops.push(request.op);
          if (request.op !== "issue.show")
            return assembly.catalog.invoke(request);
          if (thrown) throw rejection();
          return Promise.reject(rejection());
        },
      };
      const handlers = createMcpHandlers(
        catalog,
        { expose: ["issue.claim", "issue.link"] },
        {
          context: localContext(assembly, { kind: "agent", id: "mcp" }, "one"),
          resolveContext: localIdentityResolver(
            assembly.deviceRoot,
            { FORGE_SESSION: "one" },
            false,
          ),
        },
      );
      expect(await handlers.callTool("issue_claim", { id })).toMatchObject({
        ok: true,
      });
      const result = await handlers.callTool("catalog_call", {
        op: "issue.link",
        input: { id, relation: "relates", url: "https://example.com/r" },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "CONTEXT_MISSING" },
      });
      expect(JSON.stringify(result)).not.toContain("hidden-show-diagnostic");
      // The write itself ran and produced that result.
      expect(ops.at(-1)).toBe("issue.link");
    }, 30_000);

test("a terminal claim refuses every unsourced non-TTY leased write and supports explicit script recovery", async () => {
  const id = await created();
  async function call(
    verb: string,
    input: object,
    tty: boolean,
    explicit = false,
  ) {
    const options = localCall(assembly);
    const response = await runCli(
      assembly.catalog,
      ["issue", verb, "--input", JSON.stringify(input)],
      {
        ...options,
        context: { ...options.context, session: { id: "local-cli" } },
        resolveContext: localIdentityResolver(
          assembly.deviceRoot,
          explicit ? { FORGE_SESSION: "local-cli" } : {},
          tty,
        ),
      },
    );
    return JSON.parse(response.stdout) as Envelope & {
      error?: { message: string };
    };
  }
  expect((await call("claim", { id }, true)).ok).toBe(true);
  const before = await forge(["issue", "show", id]);
  for (const [verb, input] of [
    ["claim", { id }],
    ["renew", { id }],
    ["close", { id, withoutReceipt: "Terminal recovery fixture" }],
    ["release", { id }],
    ["update", { id, title: "Should not change" }],
    ["link", { id, relation: "pr", url: "https://example.com/pr/2" }],
    ["dep", { id, target: "another-item", action: "add", expectRevision: 1 }],
  ] as const) {
    const refused = await call(verb, input, false);
    expect(refused, verb).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_MISSING" },
    });
    expect(refused.error?.message, verb).toContain("FORGE_SESSION");
  }
  expect(await forge(["issue", "show", id])).toEqual(before);
  expect((await call("renew", { id }, false, true)).ok).toBe(true);
  expect((await call("release", { id }, false, true)).ok).toBe(true);
  expect((await call("claim", { id }, false, true)).ok).toBe(true);
  expect(
    (
      await call(
        "close",
        { id, withoutReceipt: "Terminal recovery fixture" },
        false,
        true,
      )
    ).ok,
  ).toBe(true);
}, 30_000);

/** What a held `lane close` is called with when the block's `show` reports this about the lane. */
async function laneCloseContext(shown: Record<string, unknown>) {
  let seen: Record<string, unknown> | undefined;
  const ops: string[] = [];
  const reply = (op: string, result: unknown) =>
    Promise.resolve({
      ok: true,
      op,
      status: "OK",
      result,
      warnings: [],
    } as never);
  const catalog: SurfaceCatalog = {
    list: () =>
      assembly.catalog
        .list()
        .map((entry) =>
          entry.op === "lane.close" ? { ...entry, admitted: true } : entry,
        ),
    invoke: (request) => {
      ops.push(request.op);
      if (request.op === "lane.show") return reply(request.op, shown);
      seen = request.context as Record<string, unknown>;
      return reply(request.op, { issue: "work-1", removed: true });
    },
  };
  const previous = process.env.FORGE_SESSION;
  process.env.FORGE_SESSION = "agent-one";
  const options = localCall(assembly);
  if (previous === undefined) delete process.env.FORGE_SESSION;
  else process.env.FORGE_SESSION = previous;
  await dispatch(
    catalog,
    "lane.close",
    { id: "work-1", pr: 1, receipt: "proof" },
    options,
  );
  return { context: seen, ops };
}

for (const [name, shown, expected] of [
  [
    "a lane the block says needs no lease",
    { issue: "work-1", leaseWaiver: { reason: "closed without a receipt" } },
    0,
  ],
  ["a lane with no lease and no waiver", { issue: "work-1" }, undefined],
  ["a lane with a lease", { issue: "work-1", lease: { generation: 7 } }, 7],
  [
    "a lane with a lease and a waiver",
    {
      issue: "work-1",
      lease: { generation: 7 },
      leaseWaiver: { reason: "closed without a receipt" },
    },
    7,
  ],
] as const)
  test(`lane close gets lease generation ${String(expected)} for ${name}`, async () => {
    const { context, ops } = await laneCloseContext(shown);
    expect(context?.leaseGeneration).toBe(expected);
    // Deciding costs the one lookup a held call already made; nothing else is read.
    expect(ops).toEqual(["lane.show", "lane.close"]);
  }, 30_000);
