// L1 acceptance: each journey runs real requests through the generated validators and the contract
// functions, and asserts the outcome the plan states.
import { expect, test } from "bun:test";
import {
  bindContext,
  type BlockManifest,
  type ConfigDocument,
  decideLease,
  type ExecutionObservation,
  type InterfaceDocument,
  INTERFACE_DOCUMENTS,
  type LeaseRecord,
  resolveComposition,
  type ResultEnvelope,
  retryDecision,
  type TemplateDocument,
  validateBlockManifest,
  validateBoundContext,
  validateWithSchema,
  validateConfigDocument,
  validateExecutionObservation,
  validateForgeError,
  validateInvocationRequest,
  validateResultEnvelope,
  validateTemplateDocument,
  checkProvidedInterface,
} from "../../src/contract/index.ts";
import { findBoundaryViolations } from "../structure/lib/boundary.ts";
import {
  alice,
  device,
  firstPartyManifests,
  fixture,
  project,
  request,
  session,
} from "./lib/fixtures.ts";

const semver = fixture("blocks/semver/forge.block.json") as BlockManifest;
const starter = fixture("templates/forge-starter.json") as TemplateDocument;
const delivery = fixture("templates/forge-delivery.json") as TemplateDocument;

function ok<T>(result: {
  ok: boolean;
  problems?: unknown;
}): asserts result is { ok: true; value: T } {
  expect(result.problems ?? []).toEqual([]);
  expect(result.ok).toBe(true);
}

/** Resolve the op in a composition, bind its declared context, and return the bound context or the refusal. */
function invoke(
  composition: ConfigDocument,
  manifests: Map<string, BlockManifest>,
  raw: unknown,
) {
  const parsed = validateInvocationRequest(raw);
  ok(parsed);
  const resolved = resolveComposition(composition, manifests);
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.errors));
  const entry = resolved.composition.operations.get(parsed.value.op);
  if (entry === undefined) throw new Error(`unknown op ${parsed.value.op}`);
  return bindContext(entry.declaration, parsed.value.context);
}

const semverConfig: ConfigDocument = {
  schemaVersion: "forge.config/1",
  blocks: {
    semver: {
      source: { path: "blocks/semver" },
      config: { defaultPart: "patch" },
    },
  },
};
const semverManifests = new Map([["semver", semver]]);

test("both templates and the §4 example block validate against the one schema", () => {
  for (const template of [starter, delivery]) {
    ok(validateTemplateDocument(template));
    ok(validateConfigDocument(template.config));
  }
  ok(validateBlockManifest(semver));
  ok(validateConfigDocument(semverConfig));
  // per-block config is validated by the block's own configSchema
  const configSchema = fixture("blocks/semver/schemas/config.json") as Record<
    string,
    unknown
  >;
  expect(
    validateWithSchema(configSchema, semverConfig.blocks.semver?.config),
  ).toEqual([]);
  expect(validateWithSchema(configSchema, { defaultPart: "mid" })).not.toEqual(
    [],
  );
}, 30_000);

test("a stateless call succeeds with nothing beyond the caller kind", () => {
  const bound = invoke(
    semverConfig,
    semverManifests,
    request("semver.bump", { current: "1.4.2", part: "minor" }, {}),
  );
  expect(bound).toEqual({ ok: true, context: { variant: "stateless" } });
  if (bound.ok) ok(validateBoundContext(bound.context));
  const envelope: ResultEnvelope = {
    ok: true,
    op: "semver.bump",
    status: "OK",
    result: { next: "1.5.0" },
    warnings: [],
  };
  ok(validateResultEnvelope(envelope));
}, 30_000);

test("a device write with no project succeeds", () => {
  const manifests = firstPartyManifests();
  const bound = invoke(
    starter.config,
    manifests,
    request("memory.add", { text: "note" }, { actor: alice, device }),
  );
  expect(bound).toEqual({
    ok: true,
    context: { variant: "device", actor: alice, device },
  });
  if (bound.ok) ok(validateBoundContext(bound.context));
}, 30_000);

test("a project write without a lease succeeds, and extra context is dropped, not passed on", () => {
  const bound = invoke(
    semverConfig,
    semverManifests,
    request(
      "semver.mark",
      { version: "1.5.0", expectRevision: 0 },
      { actor: alice, project, session, leaseGeneration: 3 },
    ),
  );
  expect(bound).toEqual({
    ok: true,
    context: { variant: "project", actor: alice, project },
  });
}, 30_000);

test("a connected non-delivery run succeeds: starter composes, binds state to core, and claims then updates under a lease", () => {
  const manifests = firstPartyManifests();
  const resolved = resolveComposition(starter.config, manifests);
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.errors));
  const { composition } = resolved;
  // no delivery block is installed
  for (const blockId of [
    "forge/pr",
    "forge/workflow",
    "forge/policy",
    "forge/git",
  ]) {
    expect(
      [...composition.operations.values()].some((o) => o.blockId === blockId),
    ).toBe(false);
  }
  expect(composition.bindings).toContainEqual({
    instance: "work",
    slot: "state",
    interface: "forge.state@1",
    provider: "core",
  });
  expect(composition.bindings).toContainEqual({
    instance: "context",
    slot: "tracker",
    interface: "forge.tracker@1",
    provider: "work",
  });
  const tracker = INTERFACE_DOCUMENTS.find(
    (d) => d.id === "forge.tracker",
  ) as unknown as InterfaceDocument;
  expect(
    checkProvidedInterface(
      manifests.get("work") as BlockManifest,
      "forge.tracker@1.0.0",
      "issue",
      tracker,
    ),
  ).toEqual([]);

  const claim = invoke(
    starter.config,
    manifests,
    request("issue.claim", { id: "w-1" }, { actor: alice, session, project }),
  );
  expect(claim.ok).toBe(true);
  const holder = {
    actor: { kind: "agent" as const, id: "agent-alice" },
    session,
  };
  const acquired = decideLease(undefined, {
    mode: "acquire",
    subject: "w-1",
    holder,
    nowMs: 0,
  });
  expect(acquired).toEqual({ ok: true, kind: "acquired", generation: 1 });

  const update = invoke(
    starter.config,
    manifests,
    request(
      "issue.update",
      { id: "w-1", expectRevision: 1, title: "x" },
      { actor: alice, session, project, leaseGeneration: 1 },
    ),
  );
  expect(update.ok).toBe(true);
  const lease: LeaseRecord = {
    subject: "w-1",
    holder,
    generation: 1,
    expiresAt: "1970-01-01T01:00:00Z",
  };
  expect(
    decideLease(lease, {
      mode: "held",
      subject: "w-1",
      holder,
      generation: 1,
      nowMs: 1000,
    }),
  ).toEqual({
    ok: true,
    kind: "held",
    generation: 1,
  });
}, 30_000);

test("a leased acquire call with no generation is accepted", () => {
  const bound = invoke(
    starter.config,
    firstPartyManifests(),
    request("issue.claim", { id: "w-2" }, { actor: alice, session, project }),
  );
  expect(bound).toEqual({
    ok: true,
    context: {
      variant: "leased",
      leaseMode: "acquire",
      actor: alice,
      session,
      project,
    },
  });
  if (bound.ok) ok(validateBoundContext(bound.context));
}, 30_000);

test("a leased held call with no generation is refused CONTEXT_MISSING", () => {
  const bound = invoke(
    starter.config,
    firstPartyManifests(),
    request("issue.renew", { id: "w-2" }, { actor: alice, session, project }),
  );
  expect(bound.ok).toBe(false);
  if (bound.ok) return;
  expect(bound.error.code).toBe("CONTEXT_MISSING");
  expect(bound.error.missing).toEqual(["leaseGeneration"]);
  ok(validateForgeError(bound.error));
  ok(
    validateResultEnvelope({
      ok: false,
      op: "issue.renew",
      status: "FAIL",
      error: bound.error,
      warnings: [],
    }),
  );
}, 30_000);

test("a superseded held call is refused LEASE_STALE after the lease was reacquired", () => {
  const first = {
    actor: { kind: "agent" as const, id: "agent-a" },
    session: { id: "s-a" },
  };
  const second = {
    actor: { kind: "agent" as const, id: "agent-b" },
    session: { id: "s-b" },
  };
  const expired: LeaseRecord = {
    subject: "w-3",
    holder: first,
    generation: 1,
    expiresAt: "1970-01-01T00:00:01Z",
  };
  const takeover = decideLease(expired, {
    mode: "acquire",
    subject: "w-3",
    holder: second,
    nowMs: 5_000,
  });
  expect(takeover).toEqual({
    ok: true,
    kind: "acquired",
    generation: 2,
    reacquired: { previousHolder: first, previousGeneration: 1 },
  });
  const current: LeaseRecord = {
    subject: "w-3",
    holder: second,
    generation: 2,
    expiresAt: "1970-01-01T01:00:00Z",
  };
  // the old session revives and writes at its old generation
  const bound = invoke(
    starter.config,
    firstPartyManifests(),
    request(
      "issue.close",
      { id: "w-3" },
      {
        actor: { kind: "agent", id: "agent-a" },
        session: first.session,
        project,
        leaseGeneration: 1,
      },
    ),
  );
  expect(bound.ok).toBe(true);
  const stale = decideLease(current, {
    mode: "held",
    subject: "w-3",
    holder: first,
    generation: 1,
    nowMs: 6_000,
  });
  expect(stale.ok).toBe(false);
  if (stale.ok) return;
  expect(stale.error.code).toBe("LEASE_STALE");
  expect(stale.error.retry).toBe("reconcile_first");
  expect(stale.error.lease).toEqual({
    subject: "w-3",
    holder: second,
    generation: 2,
    expiresAt: current.expiresAt,
  });
  ok(validateForgeError(stale.error));
}, 30_000);

test("an external effect reported uncertain is not retried", () => {
  const observation: ExecutionObservation = {
    schemaVersion: "forge.observation/1",
    requestId: "req-merge-1",
    op: "change.publish",
    startedAt: "2026-10-18T10:00:00Z",
    finishedAt: "2026-10-18T10:00:30Z",
    status: "failed",
    effects: [
      {
        effect: "external:code-host",
        outcome: "uncertain",
        reconcileWith: "change.status",
      },
    ],
  };
  ok(validateExecutionObservation(observation));
  const decision = retryDecision(["external:code-host"], observation);
  expect(decision.retry).toBe(false);
  expect(decision.reason).toBe("uncertain");
  if (decision.retry) return;
  expect(decision.error?.code).toBe("EFFECT_UNCERTAIN");
  expect(decision.error?.retry).toBe("reconcile_first");
  expect(decision.error?.reconcileWith).toBe("change.status");
  // an uncertain outcome must name the read operation that reconciles it
  const { reconcileWith: _dropped, ...unnamed } = observation.effects[0] ?? {
    effect: "x:read",
    outcome: "uncertain",
  };
  expect(
    validateExecutionObservation({ ...observation, effects: [unnamed] }).ok,
  ).toBe(false);
}, 30_000);

test("a core file that names a workflow concept is rejected", () => {
  const planted = [
    {
      path: "schemas/planted.json",
      text: '{ "description": "advance the item to its next stage" }\n',
    },
    {
      path: "src/contract/planted.ts",
      text: "export const openPullRequest = 1; // a pull request\n",
    },
    { path: "src/ports/planted.ts", text: "export interface IssuePort {}\n" },
    {
      path: "src/generated/planted.ts",
      text: "export type TddPhase = 'red';\n",
    },
  ];
  expect(new Set(findBoundaryViolations(planted).map((v) => v.file))).toEqual(
    new Set(planted.map((p) => p.path)),
  );
}, 30_000);
