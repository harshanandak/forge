import { expect, test } from "bun:test";

const head = "a".repeat(40);
const old = "b".repeat(40);
const pushedAt = "2026-11-22T09:00:00Z";
const now = "2026-11-22T09:01:00.000Z";
const before = "2026-11-22T08:59:59.999Z";
const quotaAt = "2026-11-22T09:00:00.030Z";
const findingAt = "2026-11-22T09:00:00.040Z";
const deadline = "2026-11-22T09:10:00Z";
const sol = {
  head,
  at: "2026-11-22T09:00:01Z",
  kind: "sol",
  verdict: "PASS",
  p1: 0,
  scope: "findings",
};
const full = { ...sol, scope: "full" };
const p1 = { ...sol, head: old, at: pushedAt, kind: "sonnet-temp", p1: 1 };
const absent = { status: "none", reviewedHead: null, reviewedAt: null };
const codex = {
  reviewer: "codex",
  status: "completed",
  reviewedHead: head as string | null,
  reviewedAt: pushedAt as string | null,
  quotaAt: null as string | null,
  findingAts: [] as string[],
};
const rabbit = { ...codex, reviewer: "coderabbit" };
const guard = {
  mainRed: false,
  securityPathNeedsSol: false,
  securitySolPass: false,
};
const security = {
  ...guard,
  securityPathNeedsSol: true,
  securitySolPass: true,
};
const clean = {
  version: "review-gate-input/1",
  prHead: head,
  pushedAt,
  now,
  reviews: [codex, rabbit],
  codexFindings: "clean",
  history: [] as (typeof sol)[],
  guard,
  unresolvedThreads: 0,
  threadsComplete: true,
};
const missingCodex = { ...codex, ...absent };
const missingRabbit = { ...rabbit, ...absent };
const withFinding = {
  codexFindings: "findings_resolved",
  reviews: [{ ...codex, findingAts: [findingAt] }, rabbit],
};

type Decision = {
  state: "success" | "failure";
  head: string | null;
  reason: string;
  description: string;
};
type Gate = {
  decide(input: unknown): Decision;
  validateReviewGateInput?(input: unknown): string | null;
};
const modulePath = "../../tools/ci/review-gate.ts";
const gate = (await import(modulePath)) as Gate;
const pass = (description = "codex; coderabbit"): Decision => ({
  state: "success",
  head,
  reason: "pass",
  description,
});
const fail = (
  reason: string,
  description: string,
  reviewedHead: string | null = head,
): Decision => ({ state: "failure", head: reviewedHead, reason, description });

type Rule = [string, Partial<typeof clean>, Decision];
const rules: Rule[] = [
  ["clean exact-head reviews pass without Sol", {}, pass()],
  [
    "stale Codex completion does not cover the head",
    { reviews: [{ ...codex, reviewedHead: old, reviewedAt: before }, rabbit] },
    fail("waiting", "waiting for codex"),
  ],
  [
    "stale CodeRabbit completion does not cover the head",
    { reviews: [codex, { ...rabbit, reviewedHead: old, reviewedAt: before }] },
    fail("waiting", "waiting for coderabbit"),
  ],
  [
    "an in-progress review does not cover the head",
    { reviews: [{ ...codex, status: "in_progress" }, rabbit] },
    fail("waiting", "waiting for codex"),
  ],
  [
    "fresh Codex quota still requires a full Sol review",
    { reviews: [{ ...missingCodex, quotaAt }, rabbit], history: [sol] },
    fail("sol_needed", "Sol needed: codex quota"),
  ],
  [
    "full exact-head Sol can stand in on Codex quota",
    { reviews: [{ ...missingCodex, quotaAt }, rabbit], history: [full] },
    pass("sol stand-in: codex quota; coderabbit"),
  ],
  [
    "old quota does not start a stand-in early",
    {
      reviews: [{ ...missingCodex, quotaAt: before }, rabbit],
      history: [full],
    },
    fail("waiting", "waiting for codex"),
  ],
  [
    "CodeRabbit quota uses the same stand-in rule",
    { reviews: [codex, { ...missingRabbit, quotaAt }], history: [full] },
    pass("codex; sol stand-in: coderabbit quota"),
  ],
  [
    "a millisecond before the deadline still waits",
    {
      reviews: [missingCodex, rabbit],
      now: "2026-11-22T09:09:59.999Z",
      history: [full],
    },
    fail("waiting", "waiting for codex"),
  ],
  [
    "the deadline alone cannot pass",
    { reviews: [missingCodex, rabbit], now: deadline },
    fail("sol_needed", "Sol needed: codex timeout"),
  ],
  [
    "a full Sol review of another head cannot stand in",
    {
      reviews: [missingCodex, rabbit],
      now: deadline,
      history: [{ ...full, head: old }],
    },
    fail("sol_needed", "Sol needed: codex timeout"),
  ],
  [
    "one full exact-head Sol review can cover both timed-out bots",
    { reviews: [missingCodex, missingRabbit], now: deadline, history: [full] },
    pass("sol stand-in: codex timeout; sol stand-in: coderabbit timeout"),
  ],
  [
    "a finding created after the previous Sol pass blocks",
    { ...withFinding, history: [{ ...sol, at: quotaAt }] },
    fail("findings", "unchecked codex findings"),
  ],
  [
    "the Sol pass must be strictly later than the finding",
    { ...withFinding, history: [{ ...sol, at: findingAt }] },
    fail("findings", "unchecked codex findings"),
  ],
  [
    "a cumulative Codex finding can be covered by a Sol pass on an older head",
    { ...withFinding, history: [{ ...sol, head: old }] },
    pass(),
  ],
  [
    "a completed Codex review with missing finding evidence blocks",
    { codexFindings: "findings_resolved", history: [full] },
    fail("findings", "incomplete codex findings"),
  ],
  [
    "an unresolved Codex finding blocks even after a Sol pass",
    { ...withFinding, codexFindings: "unresolved", history: [full] },
    fail("findings", "incomplete codex findings"),
  ],
  [
    "resolved CodeRabbit findings still need a later Sol pass",
    { reviews: [codex, { ...rabbit, findingAts: [findingAt] }] },
    fail("findings", "unchecked coderabbit findings"),
  ],
  [
    "a checked historical CodeRabbit finding permits current coverage",
    { reviews: [codex, { ...rabbit, findingAts: [before] }], history: [sol] },
    pass(),
  ],
  ...(
    [
      ["lead-check", { ...sol, kind: "lead-check" }],
      ["sonnet-temp", { ...sol, kind: "sonnet-temp" }],
      ["a stale Sol pass", { ...sol, head: old }],
      ["a tied Sol pass", { ...sol, at: p1.at }],
    ] satisfies [string, typeof sol][]
  ).map(([name, row]): Rule => [
    `P1 stays blocked with ${name}`,
    { history: [p1, row] },
    fail("sol_blocked", "Sol blocked"),
  ]),
  [
    "P1 clears with a later Sol pass on this head",
    { history: [sol, p1] },
    pass(),
  ],
  [
    "P1 clearance still needs both bots or full stand-ins",
    { reviews: [missingCodex, rabbit], history: [p1, sol] },
    fail("waiting", "waiting for codex"),
  ],
  [
    "a new Sol block on this head overrides an earlier pass",
    { history: [sol, { ...sol, at: now, verdict: "BLOCK" }] },
    fail("sol_blocked", "Sol blocked"),
  ],
  [
    "a finding check cannot stand in for a missing bot review",
    { reviews: [missingCodex, rabbit], now: deadline, history: [sol] },
    fail("sol_needed", "Sol needed: codex timeout"),
  ],
  [
    "security paths need a Sol pass on this head",
    { history: [{ ...sol, head: old }], guard: security },
    fail("security", "security path needs Sol"),
  ],
  [
    "security paths also need the supplied guard pass",
    { history: [sol], guard: { ...security, securitySolPass: false } },
    fail("security", "security path needs Sol"),
  ],
  [
    "security paths pass with both sources of Sol evidence",
    { history: [sol], guard: security },
    pass(),
  ],
  [
    "red main withholds success",
    { guard: { ...guard, mainRed: true } },
    fail("main_red", "main CI is red"),
  ],
  [
    "any unresolved thread withholds success",
    { unresolvedThreads: 1 },
    fail("open_threads", "open threads"),
  ],
];

test.each(rules)(
  "%s",
  (_name, overrides, expected) => {
    const input = { ...clean, ...overrides };
    expect(gate.decide(input)).toEqual(expected);
    expect(gate.validateReviewGateInput?.(input)).toBeNull();
  },
  1000,
);

const invalidInputs: [string, unknown, string][] = [
  ["null", null, "input"],
  ["non-object", 42, "input"],
  ["array input", [clean], "input"],
  ["inherited fields", Object.create(clean), "input"],
  [
    "throwing proxy",
    new Proxy(clean, {
      ownKeys() {
        throw Error("ownKeys");
      },
    }),
    "input",
  ],
  [
    "throwing getter",
    {
      ...clean,
      get prHead() {
        throw Error("prHead");
      },
    },
    "prHead",
  ],
  ["earlier clock", { ...clean, now: before }, "pushedAt"],
  ["no reviewers", { ...clean, reviews: [] }, "reviews"],
  ["missing CodeRabbit", { ...clean, reviews: [codex] }, "reviews"],
  [
    "duplicate reviewer",
    { ...clean, reviews: [codex, codex] },
    "reviews[1].reviewer",
  ],
  ["sparse reviewer list", { ...clean, reviews: Array(2) }, "reviews[0]"],
];

const badRootFields = [
  ["version", "review-gate-input/2"],
  ["prHead", head.toUpperCase()],
  ["prHead", head.slice(1)],
  ["prHead", 1],
  ["extra", true],
  ["__proto__", {}],
  ["now", "2026-11-22 09:01:00Z"],
  ["now", "2026-02-30T09:01:00Z"],
  ["now", NaN],
  ["pushedAt", "2026-11-22T09:00:00"],
  ["pushedAt", "2026-11-22T09:00:00+00:00"],
  ["codexFindings", "resolved"],
  ["history", {}],
  ["guard", []],
  ["threadsComplete", false],
  ...[-1, 0.5, NaN, Infinity, 2 ** 53, "0"].map((count): [string, unknown] => [
    "unresolvedThreads",
    count,
  ]),
] as const;
for (const [key, value] of badRootFields) {
  invalidInputs.push([
    `invalid ${key} = ${JSON.stringify(value)} (${typeof value})`,
    { ...clean, [key]: value },
    key,
  ]);
}
invalidInputs.push([
  "symbol key",
  { ...clean, [Symbol("unknown")]: true },
  "input",
]);

for (const key of Object.keys(clean)) {
  const incomplete = { ...clean };
  Reflect.deleteProperty(incomplete, key);
  invalidInputs.push([`missing ${key}`, incomplete, key]);
}

const nested = [
  [
    "reviews[0]",
    codex,
    (record: unknown) => ({ ...clean, reviews: [record, rabbit] }),
  ],
  ["history[0]", sol, (record: unknown) => ({ ...clean, history: [record] })],
  ["guard", guard, (record: unknown) => ({ ...clean, guard: record })],
] as const;
for (const [path, record, input] of nested) {
  for (const key of Object.keys(record)) {
    const incomplete = { ...record };
    Reflect.deleteProperty(incomplete, key);
    invalidInputs.push([
      `missing ${path}.${key}`,
      input(incomplete),
      `${path}.${key}`,
    ]);
  }
  invalidInputs.push([
    `extra field in ${path}`,
    input({ ...record, extra: 1 }),
    `${path}.extra`,
  ]);
}

const badReviewFields = [
  ["reviewer", "Codex"],
  ["reviewer", "sol"],
  ["status", "Completed"],
  ["status", "completed "],
  ["reviewedHead", "A".repeat(40)],
  ["reviewedHead", null],
  ["reviewedAt", null],
  ["reviewedAt", before],
  ["reviewedAt", deadline],
  ["quotaAt", deadline],
  ["quotaAt", "2026-11-22T09:00:60Z"],
  ["findingAts", findingAt],
  ["findingAts[0]", [deadline]],
  ["findingAts[0]", [null]],
] as const;
for (const [path, value] of badReviewFields) {
  const key = path === "findingAts[0]" ? "findingAts" : path;
  const record = { ...codex, [key]: value };
  invalidInputs.push([
    `invalid ${path} = ${JSON.stringify(value)}`,
    { ...clean, reviews: [record, rabbit] },
    `reviews[0].${path}`,
  ]);
}

const badHistoryFields = [
  ["head", "not-a-sha"],
  ["at", deadline],
  ["kind", "Sol"],
  ["kind", "sol-v2"],
  ["verdict", "UNKNOWN"],
  ["verdict", "pass"],
  ["p1", -1],
  ["p1", 0.5],
  ["p1", 2 ** 53],
  ["scope", "FULL"],
  ["scope", "scope=full"],
] as const;
for (const [key, value] of badHistoryFields) {
  invalidInputs.push([
    `invalid ledger ${key} = ${value}`,
    { ...clean, history: [{ ...sol, [key]: value }] },
    `history[0].${key}`,
  ]);
}

for (const key of Object.keys(guard)) {
  invalidInputs.push([
    `wrong type for guard.${key}`,
    { ...clean, guard: { ...guard, [key]: "false" } },
    `guard.${key}`,
  ]);
}

test.each(invalidInputs)(
  "rejects %s and names the field without throwing",
  (_name, input, field) => {
    expect(gate.validateReviewGateInput?.(input)).toBe(field);
    expect(gate.decide(input)).toEqual(
      fail("invalid", `invalid ${field}`, null),
    );
  },
  1000,
);
