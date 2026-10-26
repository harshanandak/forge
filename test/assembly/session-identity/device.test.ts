import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeDeviceIdentity } from "../../../src/adapters/fs/device-identity.ts";
import { publishExclusive } from "../../../src/adapters/fs/durable-io.ts";
import { localIdentityResolver } from "../../../src/assembly/identity.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import { dispatch, record } from "../../../src/surface/dispatch.ts";
import { decideLease } from "../../../src/contract/lease.ts";
import type { SurfaceCatalog } from "../../../src/surface/catalog.ts";
import type {
  AmbientContext,
  OperationDeclaration,
} from "../../../src/generated/types.ts";

const declaration: OperationDeclaration = {
  input: "in.json",
  output: "out.json",
  context: "leased",
  leaseMode: "acquire",
  effects: [],
  idempotent: false,
  callers: ["human", "agent"],
  stability: "stable",
};
const context: AmbientContext = {
  actor: { kind: "agent", id: "mcp" },
  project: { id: "project", root: "/project" },
  session: { id: "generated-fallback", agent: "agent", harness: "harness" },
};
const held = { ...declaration, leaseMode: "held" } as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-device-identity-"));
  return {
    root,
    device: join(root, "nested", "device"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("device reads are inert; acquisition persists a private nonpath identity and reads every time", () => {
  const f = fixture();
  try {
    const devices = nodeDeviceIdentity(f.device);
    expect(devices.read()).toBeUndefined();
    expect(existsSync(f.device)).toBe(false);
    const id = devices.acquire();
    expect(id).toMatch(/^device-[0-9a-f-]{36}$/);
    expect(readFileSync(join(f.device, "device-id"), "utf8")).toBe(`${id}\n`);
    expect(nodeDeviceIdentity(f.device).acquire()).toBe(id);
    expect(readdirSync(f.device)).toEqual(["device-id"]);
    if (process.platform !== "win32")
      expect(lstatSync(join(f.device, "device-id")).mode & 0o777).toBe(0o600);
    writeFileSync(join(f.device, "device-id"), "replacement-device\n");
    expect(devices.read()).toBe("replacement-device");
    expect(devices.acquire()).toBe("replacement-device");
  } finally {
    f.cleanup();
  }
}, 10000);

test("a competing publisher wins exclusively; failed publication refuses without leaking paths", () => {
  const f = fixture();
  try {
    const devices = nodeDeviceIdentity(f.device, (from, to) => {
      writeFileSync(to, "winner-device\n", { flag: "wx" });
      publishExclusive(from, to);
    });
    expect(devices.acquire()).toBe("winner-device");
    expect(readdirSync(f.device)).toEqual(["device-id"]);
    const broken = join(f.root, "broken");
    const failure = nodeDeviceIdentity(broken, () => {
      throw new Error(`Injected failure at ${f.root}`);
    });
    expect(() => failure.acquire()).toThrow(
      "Cannot create or read the persisted device identity",
    );
    expect(readdirSync(broken)).toEqual([]);
    writeFileSync(join(f.device, "device-id"), "/private/home\n");
    expect(() => devices.acquire()).toThrow(
      "Cannot read the persisted device identity",
    );
    expect(readFileSync(join(f.device, "device-id"), "utf8")).toBe(
      "/private/home\n",
    );
  } finally {
    f.cleanup();
  }
}, 10000);

test("only acquisition creates identity; held reads existing or override; project and stateless ignore failures", () => {
  const f = fixture();
  try {
    const resolve = localIdentityResolver(f.device, true, {}, false);
    expect(resolve(held, context).session?.device).toBeUndefined();
    expect(existsSync(f.device)).toBe(false);
    const acquired = resolve(declaration, context);
    expect(acquired.session?.device).toMatch(/^device-/);
    expect(resolve(held, context).session?.device).toBe(
      acquired.session?.device,
    );
    const invalidRoot = join(f.root, "file");
    writeFileSync(invalidRoot, "not-directory");
    const invalid = localIdentityResolver(invalidRoot, true, {}, false);
    for (const variant of ["project", "stateless", "device"] as const)
      expect(invalid({ ...declaration, context: variant }, context)).toEqual(
        context,
      );
    expect(() => invalid(declaration, context)).toThrow(
      "persisted device identity",
    );
    const override = localIdentityResolver(
      invalidRoot,
      true,
      { FORGE_DEVICE_ID: "  ci-device  " },
      false,
    );
    expect(override(declaration, context).session?.device).toBe("ci-device");
    expect(override(held, context).session?.device).toBe("ci-device");
  } finally {
    f.cleanup();
  }
}, 10000);

test("held calls without an identity file retain legacy authority but cannot hold a qualified lease", () => {
  const f = fixture();
  try {
    const resolved = localIdentityResolver(
      f.device,
      true,
      {},
      false,
    )(held, context);
    const holder = { actor: resolved.actor!, session: resolved.session! };
    const lease = {
      subject: "item",
      holder,
      generation: 1,
      acquiredAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:01:00.000Z",
    };
    const request = {
      mode: "held" as const,
      subject: "item",
      holder,
      generation: 1,
      nowMs: Date.parse("2026-01-01T00:00:01.000Z"),
    };
    expect(decideLease(lease, request)).toMatchObject({ ok: true });
    expect(
      decideLease(
        {
          ...lease,
          holder: {
            ...holder,
            session: { ...holder.session, device: "persisted-device" },
          },
        },
        request,
      ),
    ).toMatchObject({ ok: false, error: { code: "LEASE_NOT_HELD" } });
    expect(existsSync(f.device)).toBe(false);
  } finally {
    f.cleanup();
  }
}, 10000);

test("CLI and MCP share fallback refusal; explicit catalog context is deliberate and TTY fallback works", async () => {
  const f = fixture();
  let calls = 0;
  const catalog: SurfaceCatalog = {
    list: () => [
      {
        op: "item.claim",
        admitted: true,
        declaration,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        docs: { title: "Claim", summary: "Claim", examples: [] },
      },
    ],
    invoke: (request) => {
      calls++;
      return Promise.resolve({
        ok: true,
        op: request.op,
        status: "OK",
        result: request.context,
        warnings: [],
      });
    },
  };
  try {
    const options = {
      context,
      resolveContext: localIdentityResolver(f.device, false, {}, false),
    };
    const cli = await dispatch(
      catalog,
      "item.claim",
      {},
      { ...options, caller: "human" },
    );
    const mcp = await createMcpHandlers(catalog, {}, options).callTool(
      "item_claim",
      {},
    );
    const indirect = await createMcpHandlers(catalog, {}, options).callTool(
      "catalog_call",
      { op: "item.claim", input: {} },
    );
    for (const refusal of [cli, mcp, indirect]) {
      expect(refusal).toMatchObject({
        ok: false,
        error: {
          code: "CONTEXT_MISSING",
        },
      });
      if (refusal?.ok !== false) throw new Error("Expected a claim refusal");
      expect(refusal.error.message).toContain("FORGE_SESSION");
    }
    expect(calls).toBe(0);
    expect(existsSync(f.device)).toBe(false);
    const explicit = await dispatch(
      catalog,
      "catalog.call",
      {
        op: "item.claim",
        input: {},
        context: { ...context, session: { id: " explicit " } },
      },
      { ...options, caller: "agent" },
    );
    expect(explicit).toMatchObject({
      ok: true,
      result: {
        session: { id: "explicit" },
      },
    });
    if (!explicit.ok) throw new Error("Expected explicit session acquisition");
    const device = record(record(explicit.result)?.session)?.device;
    if (typeof device !== "string")
      throw new Error("Expected a persisted device identity");
    expect(device).toMatch(/^device-/);
    expect(
      localIdentityResolver(f.device, false, {}, true)(declaration, context)
        .session?.device,
    ).toMatch(/^device-/);
    expect(calls).toBe(1);
    const supplied = await dispatch(
      catalog,
      "catalog.call",
      {
        op: "item.claim",
        input: {},
        context: {
          ...context,
          session: { id: " supplied ", device: " supplied-device " },
        },
      },
      { ...options, caller: "agent" },
    );
    expect(supplied).toMatchObject({
      ok: true,
      result: { session: { id: "supplied", device: "supplied-device" } },
    });
  } finally {
    f.cleanup();
  }
}, 10000);
