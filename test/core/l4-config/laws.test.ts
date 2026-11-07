// Laws slice 1: a `laws` section in the config and a read-only `laws.check` report. Each law says in
// plain words what must hold at a point, and names the resolved config values that must hold it.
// The report marks each law enforced, broken or unenforced, with the reason and where the value
// came from. Nothing here writes: a config without laws is left exactly as it was.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createConfigOperations,
  type Enforcer,
  type PatchStep,
  schemaDeclares,
} from "../../../src/core/config/index.ts";
import {
  validateBlockManifest,
  validateConfigDocument,
} from "../../../src/generated/validators.ts";
import { type Fixture, makeProject } from "./lib/project.ts";

setDefaultTimeout(30_000);

const GATE = "/blocks/check/config/gate";
const CODEX = "chatgpt-codex-connector[bot]";

const open: Fixture[] = [];
afterEach(() => {
  for (const made of open.splice(0)) made.cleanup();
});

interface Reason {
  pointer: string;
  condition: Record<string, unknown>;
  actual: unknown;
  set: boolean;
  holds: boolean;
  source: string | null;
}
interface Law {
  id: string;
  says: string;
  at: string;
  status: "enforced" | "broken" | "unenforced";
  detail: string;
  reasons: Reason[];
}
interface Report {
  verdict: "PASS" | "FAIL" | "INCOMPLETE";
  laws: Law[];
  summary: { enforced: number; broken: number; unenforced: number };
  problems: string[];
}

const law = (at: string, requires: Record<string, unknown>) => ({
  says: `a law at ${at}`,
  at,
  requires,
});

/** A project whose config holds the given gate settings, other values and laws. */
function project(
  options: {
    gate?: Record<string, unknown>;
    values?: Record<string, unknown>;
    laws?: Record<string, unknown>;
  } = {},
): Fixture {
  const p = makeProject();
  open.push(p);
  const patch: PatchStep[] = [
    ...Object.entries(options.gate ?? {}).map(([key, value]) => ({
      op: "set" as const,
      path: `${GATE}/${key}`,
      value,
    })),
    ...Object.entries(options.values ?? {}).map(([key, value]) => ({
      op: "set" as const,
      path: `/values/${key}`,
      value,
    })),
    ...(options.laws === undefined
      ? []
      : [{ op: "set" as const, path: "/laws", value: options.laws }]),
  ];
  if (patch.length > 0)
    p.config.apply({ patch, expectRevision: p.config.show().revision });
  return p;
}

/** The check block's real config schema: the settings it reads. */
const CHECK_SCHEMA: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../src/blocks/check/schemas/config.json", import.meta.url),
    ),
    "utf8",
  ),
);

/** An enforcer for merge over part of the check block's config, as the host builds it. */
const enforcing = (...subtree: string[]): Enforcer => ({
  point: "merge",
  instance: "check",
  root: ["blocks", "check", "config", ...subtree],
  reads: (segments) => schemaDeclares(CHECK_SCHEMA, segments.slice(3)),
});

/** What the check block declares in its manifest: merge, through its `gate` config. */
const CHECK_ENFORCES = enforcing("gate");
/** The whole check config, for conditions on settings outside the gate. */
const CHECK_CONFIG = enforcing();
const CFG = "/blocks/check/config";

/** The host passes what its enabled, loadable blocks declare; core names no point itself. */
function check(
  p: Fixture,
  enforcers: readonly Enforcer[] = [CHECK_ENFORCES],
): Report {
  const handler = createConfigOperations({
    ...p.env,
    enforcers: () => enforcers,
  })["laws.check"];
  if (handler === undefined) throw new Error("laws.check is not registered");
  return JSON.parse(JSON.stringify(handler({}))) as Report;
}

const byId = (report: Report, id: string): Law => {
  const found = report.laws.find((l) => l.id === id);
  if (found === undefined) throw new Error(`no law ${id} in the report`);
  return found;
};

test("a merge law whose condition holds is enforced, with the value and where it came from", () => {
  const p = project({
    gate: { headReviewers: [CODEX] },
    laws: {
      "codex-reviews-every-pr": law("merge", {
        [`${GATE}/headReviewers`]: { contains: CODEX },
      }),
    },
  });
  const report = check(p);
  const found = byId(report, "codex-reviews-every-pr");
  expect(found.status).toBe("enforced");
  expect(found.reasons).toEqual([
    {
      pointer: `${GATE}/headReviewers`,
      condition: { contains: CODEX },
      actual: [CODEX],
      set: true,
      holds: true,
      source: "project",
    },
  ]);
  expect(report.verdict).toBe("PASS");
  expect(report.summary).toEqual({ enforced: 1, broken: 0, unenforced: 0 });
  expect(report.problems).toEqual([]);
});

test("a merge law whose condition fails is broken, naming the pointer, the condition and the actual value", () => {
  const p = project({
    gate: { receiptChecks: [] },
    laws: {
      "merge-needs-receipt": law("merge", {
        [`${GATE}/receiptChecks`]: { nonEmpty: true },
      }),
    },
  });
  const report = check(p);
  const found = byId(report, "merge-needs-receipt");
  expect(found.status).toBe("broken");
  expect(found.reasons).toEqual([
    {
      pointer: `${GATE}/receiptChecks`,
      condition: { nonEmpty: true },
      actual: [],
      set: true,
      holds: false,
      source: "project",
    },
  ]);
  expect(report.verdict).toBe("FAIL");
  expect(report.summary).toEqual({ enforced: 0, broken: 1, unenforced: 0 });
});

test("a law at a point Forge does not enforce is unenforced, even when its condition holds", () => {
  const p = project({
    values: { "tests-before-push": true },
    laws: {
      "tests-before-push": law("push", {
        "/values/tests-before-push": { equals: true },
      }),
    },
  });
  const report = check(p);
  const found = byId(report, "tests-before-push");
  expect(found.status).toBe("unenforced");
  expect(found.detail).toContain("no enabled block enforces push");
  expect(report.verdict).toBe("INCOMPLETE");
  expect(report.summary).toEqual({ enforced: 0, broken: 0, unenforced: 1 });
});

test("a law that reads a value the enforcer does not read is unenforced", () => {
  const p = project({
    values: { review: true },
    laws: { elsewhere: law("merge", { "/values/review": { equals: true } }) },
  });
  const found = byId(check(p), "elsewhere");
  expect(found.status).toBe("unenforced");
  expect(found.detail).toContain("is outside what check enforces");
});

test("a law whose config value is missing is broken, in the pointer form and the instance form", () => {
  const p = project({
    laws: {
      "merge-needs-doors": law("merge", {
        "check.gate.doorPaths": { nonEmpty: true },
      }),
    },
  });
  const found = byId(check(p), "merge-needs-doors");
  expect(found.status).toBe("broken");
  expect(found.reasons).toEqual([
    {
      pointer: `${GATE}/doorPaths`,
      condition: { nonEmpty: true },
      actual: null,
      set: false,
      holds: false,
      source: null,
    },
  ]);
});

test("equals, contains, nonEmpty, atLeast and atMost each judge a real check setting", () => {
  const p = project({
    gate: {
      requiredChecks: ["unit"],
      headReviewers: [CODEX],
      doorPaths: [],
    },
    laws: {
      "equals-holds": law("merge", {
        [`${GATE}/requiredChecks`]: { equals: ["unit"] },
      }),
      "equals-fails": law("merge", {
        [`${GATE}/requiredChecks`]: { equals: ["lint"] },
      }),
      "contains-element": law("merge", {
        [`${GATE}/headReviewers`]: { contains: CODEX },
      }),
      "contains-fails": law("merge", {
        [`${GATE}/headReviewers`]: { contains: "someone-else[bot]" },
      }),
      "contains-text": law("merge", {
        [`${CFG}/report`]: { contains: "exit" },
      }),
      "contains-text-fails": law("merge", {
        [`${CFG}/report`]: { contains: "json" },
      }),
      "empty-holds": law("merge", {
        [`${GATE}/doorPaths`]: { nonEmpty: false },
      }),
      "empty-fails": law("merge", {
        [`${GATE}/headReviewers`]: { nonEmpty: false },
      }),
      "least-holds": law("merge", {
        [`${CFG}/review/rounds`]: { atLeast: 3 },
      }),
      "least-fails": law("merge", {
        [`${CFG}/review/rounds`]: { atLeast: 4 },
      }),
      "most-holds": law("merge", { [`${CFG}/review/rounds`]: { atMost: 3 } }),
      "most-fails": law("merge", { [`${CFG}/review/rounds`]: { atMost: 2 } }),
      "least-on-text": law("merge", { [`${CFG}/report`]: { atLeast: 1 } }),
    },
  });
  change(p, [
    { op: "set", path: `${CFG}/report`, value: "exit-code" },
    { op: "set", path: `${CFG}/review/rounds`, value: 3 },
  ]);
  const report = check(p, [CHECK_CONFIG]);
  const status = Object.fromEntries(report.laws.map((l) => [l.id, l.status]));
  expect(status).toEqual({
    "contains-element": "enforced",
    "contains-fails": "broken",
    "contains-text": "enforced",
    "contains-text-fails": "broken",
    "empty-fails": "broken",
    "empty-holds": "enforced",
    "equals-fails": "broken",
    "equals-holds": "enforced",
    "least-fails": "broken",
    "least-holds": "enforced",
    "least-on-text": "broken",
    "most-fails": "broken",
    "most-holds": "enforced",
  });
});

test("a value the check block does not read is unenforced, not enforced, though the config holds it", () => {
  const p = project({
    gate: { quorum: 2 },
    laws: {
      "quorum-holds": law("merge", { [`${GATE}/quorum`]: { equals: 2 } }),
      "quorum-fails": law("merge", { [`${GATE}/quorum`]: { equals: 3 } }),
    },
  });
  const report = check(p);
  const held = byId(report, "quorum-holds");
  expect(held.status).toBe("unenforced");
  expect(held.detail).toContain(`${GATE}/quorum is not a setting check reads`);
  // a failing condition is still broken, and broken wins the verdict
  expect(byId(report, "quorum-fails").status).toBe("broken");
  expect(report.verdict).toBe("FAIL");
});

test("schemaDeclares walks properties, array items, alternatives and open maps", () => {
  const schema = {
    type: "object",
    properties: {
      list: {
        type: "array",
        items: { type: "object", properties: { id: {} } },
      },
      pick: {
        oneOf: [{ const: "a" }, { type: "array", items: { type: "string" } }],
      },
      map: { type: "object", additionalProperties: { type: "string" } },
      free: { type: "object" },
    },
    additionalProperties: false,
  };
  for (const yes of [
    [],
    ["list"],
    ["list", "0", "id"],
    ["pick", "1"],
    ["map", "anything"],
    ["free", "any", "depth"],
  ])
    expect(schemaDeclares(schema, yes), yes.join("/")).toBe(true);
  for (const no of [
    ["nope"],
    ["list", "x"],
    ["list", "0", "nope"],
    ["map", "k", "deeper"],
  ])
    expect(schemaDeclares(schema, no), no.join("/")).toBe(false);
});

test("every condition of a law must hold, and the report lists each one", () => {
  const p = project({
    gate: { headReviewers: [CODEX], receiptChecks: [] },
    laws: {
      both: law("merge", {
        [`${GATE}/headReviewers`]: { contains: CODEX },
        [`${GATE}/receiptChecks`]: { nonEmpty: true },
      }),
    },
  });
  const found = byId(check(p), "both");
  expect(found.status).toBe("broken");
  expect(found.reasons.map((r) => [r.pointer, r.holds])).toEqual([
    [`${GATE}/headReviewers`, true],
    [`${GATE}/receiptChecks`, false],
  ]);
});

test("a mix of laws is reported in id order with a count of each state", () => {
  const p = project({
    gate: { headReviewers: [CODEX], receiptChecks: [] },
    values: { x: true },
    laws: {
      "c-push": law("push", { "/values/x": { equals: true } }),
      "b-broken": law("merge", {
        [`${GATE}/receiptChecks`]: { nonEmpty: true },
      }),
      "a-enforced": law("merge", {
        [`${GATE}/headReviewers`]: { contains: CODEX },
      }),
    },
  });
  const report = check(p);
  expect(report.laws.map((l) => [l.id, l.status])).toEqual([
    ["a-enforced", "enforced"],
    ["b-broken", "broken"],
    ["c-push", "unenforced"],
  ]);
  expect(report.summary).toEqual({ enforced: 1, broken: 1, unenforced: 1 });
  expect(report.verdict).toBe("FAIL");
});

test("a config without laws gives an empty report and changes nothing", () => {
  const bare = makeProject();
  open.push(bare);
  const before = bare.config.show().revision;
  expect(check(bare)).toEqual({
    verdict: "PASS",
    laws: [],
    summary: { enforced: 0, broken: 0, unenforced: 0 },
    problems: [],
  });
  expect(bare.read()).toBeUndefined();
  expect(bare.config.show().revision).toBe(before);

  const configured = project({ gate: { headReviewers: [CODEX] } });
  const text = configured.read();
  const revision = configured.config.show().revision;
  expect(check(configured).laws).toEqual([]);
  expect(configured.read()).toBe(text);
  expect(configured.config.show().revision).toBe(revision);
});

test("the schema accepts a well-formed law and rejects an unknown key, a bad point or a bad condition", () => {
  const document = (laws: unknown) => ({
    schemaVersion: "forge.config/1",
    blocks: {},
    laws,
  });
  const good = law("merge", { "check.gate.receiptChecks": { nonEmpty: true } });
  expect(validateConfigDocument(document({ "no-silent-merge": good })).ok).toBe(
    true,
  );
  expect(validateConfigDocument(document({})).ok).toBe(true);
  for (const bad of [
    { ...good, extra: true },
    { ...good, at: "deploy" },
    { says: "no point", requires: good.requires },
    { says: "", at: "merge", requires: good.requires },
    { ...good, requires: {} },
    { ...good, requires: { "check.gate.x": {} } },
    { ...good, requires: { "check.gate.x": { sorta: 1 } } },
    { ...good, requires: { "check.gate.x": { equals: 1, atLeast: 1 } } },
    { ...good, requires: { "check.gate.x": { nonEmpty: "yes" } } },
    { ...good, requires: { "check.gate.x": { atLeast: "two" } } },
  ])
    expect(
      validateConfigDocument(document({ "no-silent-merge": bad })).ok,
    ).toBe(false);
  expect(validateConfigDocument(document({ "Not Kebab": good })).ok).toBe(
    false,
  );
});

test("a malformed law cannot be written through config edits", () => {
  const p = makeProject();
  open.push(p);
  const preview = p.config.preview({
    patch: [
      {
        op: "set" as const,
        path: "/laws",
        value: { bad: { says: "x", at: "deploy", requires: {} } },
      },
    ],
  });
  expect(preview.valid).toBe(false);
  expect(p.read()).toBeUndefined();
});

test("a hand-edited malformed laws section is reported as a problem, not read", () => {
  const p = makeProject();
  open.push(p);
  mkdirSync(join(p.root, ".forge"));
  writeFileSync(
    join(p.root, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: {},
      laws: { bad: { says: "x", at: "deploy", requires: {} } },
    }),
  );
  const report = check(p);
  expect(report.laws).toEqual([]);
  expect(report.verdict).toBe("FAIL");
  expect(report.problems.length).toBeGreaterThan(0);
  expect(report.problems.join("\n")).toContain("laws.bad");
});

const codexLaw = {
  "codex-reviews-every-pr": law("merge", {
    [`${GATE}/headReviewers`]: { contains: CODEX },
  }),
};

function change(p: Fixture, steps: PatchStep[]): void {
  p.config.apply({ patch: steps, expectRevision: p.config.show().revision });
}

test("a merge law is unenforced when no enabled block declares merge, though its values hold", () => {
  const p = project({ gate: { headReviewers: [CODEX] }, laws: codexLaw });
  // the host leaves a disabled, missing or unloadable check instance out of the list
  const report = check(p, []);
  const found = byId(report, "codex-reviews-every-pr");
  expect(found.status).toBe("unenforced");
  expect(found.detail).toContain("no enabled block enforces merge");
  expect(found.reasons.every((r) => r.holds)).toBe(true);
  expect(report.verdict).toBe("INCOMPLETE");
});

test("a law is enforced only when its pointers sit inside the subtree the block declares", () => {
  const p = project({
    gate: { headReviewers: [CODEX] },
    values: { review: true },
    laws: {
      inside: law("merge", { [`${GATE}/headReviewers`]: { contains: CODEX } }),
      outside: law("merge", { "/values/review": { equals: true } }),
    },
  });
  const report = check(p);
  expect(byId(report, "inside").status).toBe("enforced");
  const outside = byId(report, "outside");
  expect(outside.status).toBe("unenforced");
  expect(outside.detail).toContain("is outside what check enforces");
});

test("a block manifest may declare the points it enforces, and nothing else about them", () => {
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../src/blocks/check/forge.block.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
  expect(manifest.enforces).toEqual({ merge: "/gate" });
  expect(validateBlockManifest(manifest).ok).toBe(true);
  for (const bad of [{ "Not Kebab": "/gate" }, { merge: "gate" }, { merge: 1 }])
    expect(validateBlockManifest({ ...manifest, enforces: bad }).ok).toBe(
      false,
    );
});

test("a config whose document cannot be used never reports an empty pass", () => {
  const p = makeProject();
  open.push(p);
  mkdirSync(join(p.root, ".forge"));
  // no `blocks`: a problem at the document root, so the whole document is left out
  writeFileSync(
    join(p.root, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      laws: {
        ok: law("merge", { "check.gate.receiptChecks": { nonEmpty: true } }),
      },
    }),
  );
  const report = check(p);
  expect(report.laws).toEqual([]);
  expect(report.verdict).toBe("FAIL");
  expect(report.problems.length).toBeGreaterThan(0);
});
