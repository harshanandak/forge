type Base = { file: string; from: string; to: string; journey: string };
export type Counterfactual = Base &
  (
    | { kind: "assertion"; evidence: string }
    | { kind: "timeout"; timeout: number }
  );

const mutations = [
  {
    file: "core/state/migrations.js",
    from: "if (unknown !== undefined)",
    to: "if (false)",
    journey: "newerstore",
    evidence: "Missing expected exception",
  },
  ...[
    "value",
    "revision",
    "orphan",
    "missing",
    "gap",
    "lease",
    "previous",
    "receipt",
  ].map((mutation) => ({
    file: "core/state/index.js",
    from: "verifyEventDerivedState(candidate, eventHighWaterMark);",
    to: "void 0;",
    journey: `derivedstate:${mutation}`,
    evidence: "Missing expected exception",
  })),
  {
    file: "adapters/store-sqlite/index.js",
    from: 'throw new Error("Store identity changed while opening; reopen required");',
    to: "void 0;",
    journey: "openidentity",
    evidence: "identity swap",
  },
  {
    file: "core/state/index.js",
    from: "validateReceipt(row, events);",
    to: "void 0;",
    journey: "requestreceipts",
    evidence: "Missing expected exception",
  },
  {
    file: "adapters/store-sqlite/index.js",
    from: "path, platform: process.platform",
    to: "path: options.path, platform: process.platform",
    journey: "relativepaths",
    evidence: "relative synced store must be refused",
  },
  {
    file: "adapters/store-sqlite/index.js",
    from: 'if (candidate.all("PRAGMA foreign_key_check").length)',
    to: "if (false)",
    journey: "restorevalidation",
    evidence: "AssertionError",
  },
  {
    file: "core/state/index.js",
    from: "if (!outcome.ok)",
    to: "if (false)",
    journey: "closeerrors",
    evidence: "AssertionError",
  },
  {
    file: "core/state/index.js",
    from: "if (changed.changes !== 1)",
    to: "if (false)",
    journey: "records",
    evidence: "Missing expected exception",
  },
  {
    file: "core/state/migrations.js",
    from: "revision INTEGER NOT NULL CHECK(revision > 0)",
    to: "metadata TEXT, revision INTEGER NOT NULL CHECK(revision > 0)",
    journey: "migration",
    evidence: "strictEqual",
  },
  {
    file: "core/state/migrations.js",
    from: "if (exists())\n                    return;",
    to: "if (false) return;",
    journey: "migration",
    evidence: "original ADD failure",
  },
  {
    file: "core/state/index.js",
    from: "if (options.fence)\n                this.#held(namespace, options.fence, now);",
    to: "if (false) this.#held(namespace, options.fence, now);",
    journey: "concurrency",
    evidence: "Missing expected exception",
  },
  {
    file: "adapters/store-sqlite/index.js",
    from: 'if (active) throw new Error("Nested transactions are refused");',
    to: "void 0;",
    journey: "concurrency",
    evidence: "AssertionError",
  },
  {
    file: "core/state/index.js",
    from: "this.#held(namespace, { subject, holder, generation: replay.generation }, now);",
    to: "void 0;",
    journey: "leases",
    evidence: "Missing expected exception",
  },
  {
    file: "contract/lease.js",
    from: "const generation = current.generation + 1;",
    to: "const generation = current.generation;",
    journey: "leases",
    evidence: "strictEqual",
  },
  {
    file: "contract/lease.js",
    from: "a.session.id === b.session.id",
    to: "true",
    journey: "leases",
    evidence: "Missing expected exception",
  },
  {
    file: "core/state/fs-class.js",
    from: "!warned.has(classification.kind)",
    to: "true",
    journey: "filesystem",
    evidence: "strictEqual",
  },
  {
    file: "adapters/store-sqlite/recovery.js",
    from: "if (!same(proof(approved.source.path, source), approved.source) || !same(proof(approved.backup.path, backup), approved.backup) || !same(proof(recoveryPath, recovery), retained))",
    to: "if (false)",
    journey: "recovery",
    evidence: "Missing expected rejection",
  },
  {
    file: "core/state/index.js",
    from: 'if (handle.ownership === "owned")',
    to: "if (false)",
    journey: "lifecycle",
    evidence: "strictEqual",
  },
  {
    file: "adapters/store-sqlite/index.js",
    from: "return new Uint8Array(readFileSync(destination));",
    to: "return new Uint8Array([1,2,3]);",
    journey: "roundtrip",
    evidence: "database",
  },
];
mutations.push({
  file: "adapters/store-sqlite/index.js",
  from: "if (lstatSync(path).isSymbolicLink())",
  to: "if (false)",
  journey: "relativepaths",
  evidence: "dangling file symlink must be refused",
});
mutations.push({
  file: "core/state/index.js",
  from: "if (!Object.hasOwn(input, index))",
  to: "if (false)",
  journey: "records",
  evidence: "Missing expected exception",
});
for (const journey of ["foreignkeys", "generatedcolumns", "namesandtriggers"])
  mutations.push({
    file: "adapters/store-sqlite/index.js",
    from: "renameDurable(candidatePath, path, hooks.fs);",
    to: "void 0;",
    journey,
    // With history present, the completeness check now catches a missing swap
    // before the journey can inspect the absent domain rows.
    evidence:
      journey === "foreignkeys"
        ? "Inconsistent imported state_events key high-water mark"
        : "AssertionError",
  });

export const counterfactuals: readonly Counterfactual[] = [
  ...mutations.map((mutation) => ({ ...mutation, kind: "assertion" as const })),
  {
    kind: "timeout",
    file: "core/state/fs-class.js",
    from: "return value.slice(0, end);",
    to: "return value.replace(/\\/+$/, '');",
    journey: "filesystem",
    timeout: 2000,
  },
];

export function packedCoverage(nodeLeg: string | undefined): {
  bun: boolean;
  shard: 0 | 1 | undefined;
} {
  if (nodeLeg === undefined) return { bun: true, shard: undefined };
  if (nodeLeg === "24") return { bun: true, shard: 0 };
  if (nodeLeg === "26") return { bun: false, shard: 1 };
  throw new Error("STATE_NODE_LEG must be 24 or 26 when supplied");
}

export function selectShard<T>(
  cases: readonly T[],
  shard: 0 | 1 | undefined,
): readonly T[] {
  return shard === undefined
    ? cases
    : cases.filter((_, index) => index % 2 === shard);
}
