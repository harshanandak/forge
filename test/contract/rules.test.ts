// Naming grammar, version grammar, lease semantics, effect retry and composition rules.
import { expect, test } from "bun:test";
import {
  type BlockManifest,
  type ConfigDocument,
  decideLease,
  type ExecutionObservation,
  flagName,
  interfaceSatisfies,
  isReservedPublisher,
  type LeaseHolder,
  type LeaseRecord,
  mcpToolName,
  nounCollisions,
  nounRefusal,
  operationFromMcpToolName,
  permissionKey,
  propertyFromFlag,
  resolveComposition,
  retryDecision,
  satisfiesRange,
  validatePermissionKey,
} from "../../src/contract/index.ts";
import { firstPartyManifests, fixture } from "./lib/fixtures.ts";

test("MCP and CLI names map both ways without loss", () => {
  for (const op of ["semver.bump", "release-note.add-entry", "issue.claim"]) {
    const name = mcpToolName(op);
    expect(name).toBe(op.replace(".", "_"));
    expect(operationFromMcpToolName(name ?? "")).toBe(op);
    expect(
      operationFromMcpToolName(mcpToolName(op, "acme") ?? "", "acme"),
    ).toBe(op);
  }
  expect(mcpToolName(`${"a".repeat(30)}.${"b".repeat(20)}`)).toBeUndefined();
  expect(operationFromMcpToolName("catalog_list_all")).toBeUndefined();
  expect(flagName("preRelease")).toBe("pre-release");
  expect(propertyFromFlag("pre-release")).toBe("preRelease");
  expect(propertyFromFlag("Pre-release")).toBeUndefined();
  expect(flagName("prREF")).toBeUndefined();
}, 30_000);

test("permission keys follow the grammar and ignore renames", () => {
  const key = permissionKey(
    "io.github.alice/semver",
    "semver",
    "1.0.0",
    "bump",
  );
  expect(key).toBe("io.github.alice/semver.semver@1.0.0#bump");
  expect(validatePermissionKey(key).ok).toBe(true);
}, 30_000);

test("reserved publishers and nouns are refused for outside blocks only", () => {
  expect(isReservedPublisher("forge")).toBe(true);
  expect(isReservedPublisher("forge.labs")).toBe(true);
  expect(isReservedPublisher("dev.forge")).toBe(true);
  expect(isReservedPublisher("io.github.alice")).toBe(false);
  const rules = { firstPartyNouns: ["memory"] };
  expect(nounRefusal("config", "io.github.alice", rules)?.code).toBe(
    "NAME_RESERVED",
  );
  expect(nounRefusal("memory", "io.github.alice", rules)?.code).toBe(
    "NAME_RESERVED",
  );
  expect(nounRefusal("forge-extra", "io.github.alice", rules)?.code).toBe(
    "NAME_RESERVED",
  );
  expect(nounRefusal("mcp", "io.github.alice", rules)?.code).toBe(
    "NAME_RESERVED",
  );
  expect(nounRefusal("semver", "io.github.alice", rules)).toBeUndefined();
  expect(nounRefusal("memory", "forge", rules)).toBeUndefined();
  expect(nounCollisions(["notes", "semver", "notes-extra"])).toEqual([
    ["notes", "notes-extra"],
  ]);
}, 30_000);

test("version ranges and interface compatibility", () => {
  expect(satisfiesRange("0.1.5", ">=0.1.0 <0.2.0")).toBe(true);
  expect(satisfiesRange("0.2.0", ">=0.1.0 <0.2.0")).toBe(false);
  expect(satisfiesRange("0.2.0-rc.1", "<0.2.0")).toBe(true);
  expect(satisfiesRange("1.0.0", "1.0.0")).toBe(true);
  expect(satisfiesRange("1.0.0", "^1.0.0")).toBe(false);
  expect(satisfiesRange("1.0.0-alpha", "<1.0.0-alpha.1")).toBe(true);
  expect(interfaceSatisfies("forge.state@1.4.0", "forge.state@1")).toBe(true);
  expect(interfaceSatisfies("forge.state@2.0.0", "forge.state@1")).toBe(false);
  expect(interfaceSatisfies("forge.store@1.0.0", "forge.state@1")).toBe(false);
}, 30_000);

const a: LeaseHolder = {
  actor: { kind: "agent", id: "a" },
  session: { id: "s-a" },
};
const b: LeaseHolder = {
  actor: { kind: "agent", id: "b" },
  session: { id: "s-b" },
};
const HOUR = 3_600_000;
const at = (ms: number): string => new Date(ms).toISOString();
const leased = (
  holder: LeaseHolder,
  generation: number,
  expiresMs: number,
): LeaseRecord => ({
  subject: "w",
  holder,
  generation,
  expiresAt: at(expiresMs),
});

test("lease: initial acquire is generation 1; a live lease refuses a second claimant with the holder", () => {
  expect(
    decideLease(undefined, {
      mode: "acquire",
      subject: "w",
      holder: a,
      nowMs: 0,
    }),
  ).toEqual({
    ok: true,
    kind: "acquired",
    generation: 1,
  });
  const held = decideLease(leased(a, 1, HOUR), {
    mode: "acquire",
    subject: "w",
    holder: b,
    nowMs: 10,
  });
  expect(held.ok ? undefined : held.error).toMatchObject({
    code: "LEASE_HELD",
    retry: "reconcile_first",
    lease: { holder: a, generation: 1, expiresAt: at(HOUR) },
  });
}, 30_000);

test("lease: renewal needs the current generation from the holder, before expiry", () => {
  const lease = leased(a, 3, HOUR);
  const code = (
    generation: number | undefined,
    holder: LeaseHolder,
    nowMs: number,
  ) => {
    const d = decideLease(lease, {
      mode: "held",
      subject: "w",
      holder,
      nowMs,
      ...(generation === undefined ? {} : { generation }),
    });
    return d.ok ? d.kind : d.error.code;
  };
  expect(code(3, a, 10)).toBe("held");
  expect(code(undefined, a, 10)).toBe("CONTEXT_MISSING");
  expect(code(2, a, 10)).toBe("LEASE_STALE");
  expect(code(4, a, 10)).toBe("LEASE_STALE");
  expect(code(3, b, 10)).toBe("LEASE_NOT_HELD");
  expect(code(3, a, HOUR)).toBe("LEASE_EXPIRED");
  expect(code(1, a, 10)).toBe("LEASE_STALE");
  expect(
    decideLease(undefined, {
      mode: "held",
      subject: "w",
      holder: a,
      generation: 1,
      nowMs: 0,
    }),
  ).toMatchObject({ ok: false, error: { code: "LEASE_NOT_HELD" } });
}, 30_000);

test("lease: anyone, including the previous holder, reacquires only after expiry; release then claim is generation + 1", () => {
  expect(
    decideLease(leased(a, 1, HOUR), {
      mode: "acquire",
      subject: "w",
      holder: a,
      nowMs: HOUR - 1,
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "LEASE_HELD" },
  });
  expect(
    decideLease(leased(a, 1, HOUR), {
      mode: "acquire",
      subject: "w",
      holder: a,
      nowMs: HOUR,
    }),
  ).toEqual({
    ok: true,
    kind: "acquired",
    generation: 2,
    reacquired: { previousHolder: a, previousGeneration: 1 },
  });
  const released = { ...leased(a, 4, HOUR), releasedAt: at(5) };
  expect(
    decideLease(released, {
      mode: "acquire",
      subject: "w",
      holder: b,
      nowMs: 10,
    }),
  ).toEqual({
    ok: true,
    kind: "acquired",
    generation: 5,
  });
  expect(
    decideLease(released, {
      mode: "held",
      subject: "w",
      holder: a,
      generation: 4,
      nowMs: 10,
    }),
  ).toMatchObject({ ok: false, error: { code: "LEASE_NOT_HELD" } });
}, 30_000);

const observation = (
  effects: ExecutionObservation["effects"],
  status: ExecutionObservation["status"],
): ExecutionObservation => ({
  schemaVersion: "forge.observation/1",
  requestId: "r-1",
  op: "change.publish",
  startedAt: "2026-10-18T10:00:00Z",
  finishedAt: "2026-10-18T10:00:01Z",
  status,
  effects,
});

test("retry: only a request whose effects are all known not applied may be repeated", () => {
  const effect = "external:code-host";
  expect(
    retryDecision(
      [effect],
      observation([{ effect, outcome: "not_applied" }], "failed"),
    ),
  ).toEqual({
    retry: true,
    reason: "nothing_applied",
  });
  expect(
    retryDecision(
      [effect],
      observation([{ effect, outcome: "applied" }], "failed"),
    ).retry,
  ).toBe(false);
  expect(
    retryDecision(
      [effect],
      observation([{ effect, outcome: "applied" }], "completed"),
    ).retry,
  ).toBe(false);
  // a declared effect that was never reported counts as uncertain, even though the request ID is known
  const silent = retryDecision([effect], observation([], "failed"));
  expect(silent).toMatchObject({
    retry: false,
    reason: "uncertain",
    error: { code: "EFFECT_UNCERTAIN" },
  });
}, 30_000);

test("composition: collisions, renames and slot bindings are resolved without importing code", () => {
  const manifests = firstPartyManifests();
  const semver = fixture("blocks/semver/forge.block.json") as BlockManifest;
  const config = (blocks: ConfigDocument["blocks"]): ConfigDocument => ({
    schemaVersion: "forge.config/1",
    blocks,
  });
  const codes = (r: ReturnType<typeof resolveComposition>) =>
    r.ok ? [] : r.errors.map((e) => e.code);

  const twice = new Map([
    ["one", semver],
    ["two", semver],
  ]);
  const clash = config({
    one: { source: { path: "a" } },
    two: { source: { path: "b" } },
  });
  expect(codes(resolveComposition(clash, twice))).toContain("NOUN_COLLISION");
  const renamed = resolveComposition(
    config({
      one: { source: { path: "a" } },
      two: { source: { path: "b" }, rename: { semver: "ver" } },
    }),
    twice,
  );
  expect(renamed.ok).toBe(true);
  if (renamed.ok) {
    expect(renamed.composition.operations.get("ver.bump")?.declaredOp).toBe(
      "semver.bump",
    );
  }

  const noCore = resolveComposition(
    config({ semver: { source: { path: "a" } } }),
    new Map([["semver", semver]]),
    [],
  );
  expect(codes(noCore)).toEqual(["PROVIDER_MISSING"]);
  const wrongBind = resolveComposition(
    config({
      semver: { source: { path: "a" }, bind: { state: "memory" } },
      memory: { source: { builtin: "forge/memory" } },
    }),
    new Map([
      ["semver", semver],
      ["memory", manifests.get("memory") as BlockManifest],
    ]),
  );
  expect(codes(wrongBind)).toEqual(["INTERFACE_INCOMPATIBLE"]);
  const twoTrackers = new Map([
    ...manifests,
    [
      "work-b",
      { ...(manifests.get("work") as BlockManifest), id: "io.acme/tracker" },
    ],
  ]);
  const ambiguous = resolveComposition(
    config({
      context: { source: { builtin: "forge/context" } },
      work: { source: { builtin: "forge/work" } },
      "work-b": { source: { path: "t" }, rename: { issue: "ticket" } },
    }),
    twoTrackers,
  );
  expect(codes(ambiguous)).toEqual(["BINDING_AMBIGUOUS"]);
}, 30_000);
