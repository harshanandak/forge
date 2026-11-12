export const counterfactuals: readonly {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly journey: string;
  readonly evidence: string;
  /** A second edit, applied after the first, for a change that needs two places. */
  readonly also?: { readonly from: string; readonly to: string };
}[] = [
  {
    file: "blocks/work/entry.cjs",
    from: "!input.withoutReceipt?.trim()",
    to: "false",
    journey: "records",
    evidence: "expected RECEIPT_REQUIRED",
  },
  {
    file: "core/state/index.js",
    from: "const current = this.lease(namespace, subject);",
    to: "const loaded = this.lease(namespace, subject); const current = loaded && Date.parse(loaded.expiresAt) <= now ? undefined : loaded;",
    journey: "leases",
    evidence: "K2: expired lease must retain its generation",
  },
  {
    file: "blocks/work/entry.cjs",
    from: "Date.parse(lease.expiresAt) > state.now()",
    to: "true",
    journey: "leases",
    evidence: "expired lease must not hide ready work",
  },
  {
    file: "blocks/work/entry.cjs",
    from: "kind !== undefined && !kinds.includes(kind)",
    to: "false",
    journey: "records",
    evidence: "expected INPUT_INVALID",
  },
  {
    file: "blocks/work/entry.cjs",
    from: "{ id, body: input.body }",
    to: '{ id, body: "lost comment" }',
    journey: "records",
    evidence: "plain text: stage: dev -> review",
  },
  {
    file: "blocks/work/entry.cjs",
    from: 'status: "closed"',
    to: 'status: "open"',
    journey: "records",
    evidence: "closed",
  },
  {
    file: "blocks/work/entry.cjs",
    from: "return !blocked(graph, value) && !live(state, value.id);",
    to: "return !live(state, value.id);",
    journey: "dependencies",
    evidence: "AssertionError",
  },
  {
    file: "blocks/work/entry.cjs",
    from: "canonical(read) !== canonical(written)",
    to: "false",
    journey: "records",
    evidence: "expected INTERNAL",
  },
  {
    file: "blocks/work/entry.cjs",
    from: 'if (stored(get(state, id, input.id)).status !== "open") {',
    to: "if (false) {",
    journey: "closed-claim",
    evidence: "expected INPUT_CONFLICT",
  },
  {
    file: "core/state/index.js",
    from: "for (const read of readSet) {",
    to: "for (const read of []) {",
    journey: "dependency-race",
    evidence: "expected REVISION_CONFLICT",
  },
  {
    file: "assembly/state-client.js",
    from: "readSet: structuredClone(put.readSet)",
    to: "readSet: []",
    journey: "dependency-race",
    evidence: "expected REVISION_CONFLICT",
  },
  {
    file: "blocks/work/entry.cjs",
    from: "readSet.push({ key: record.key, expectRevision: record.revision });",
    to: "void 0;",
    journey: "dependency-race",
    evidence: "expected REVISION_CONFLICT",
  },
  {
    file: "blocks/work/entry.cjs",
    from: "if (complete.has(next)) {",
    to: "if (false) {",
    journey: "graph",
    evidence: "graph node expanded more than once",
  },
  {
    file: "blocks/work/entry.cjs",
    from: "records: appended(state, `comment:${id}:`)",
    to: "records: state.list(`comment:${id}:`)",
    journey: "append-order",
    evidence: "comments must retain append order beyond nine",
  },
  {
    file: "blocks/work/entry.cjs",
    from: "records: appended(state, `link:${id}:`)",
    to: "records: state.list(`link:${id}:`)",
    journey: "append-order",
    evidence: "links must retain append order beyond nine",
  },
  {
    file: "core/state/index.js",
    from: "return floorNumber(stored.value, prefix);",
    to: "return this.maxNumber(namespace, prefix);",
    journey: "allocation",
    evidence: "a deleted number is not reused",
  },
  {
    file: "core/state/index.js",
    from: `" AND json_extract(body,'$.type') IN (?,?)"`,
    to: '" AND 0 AND ?<>?"',
    journey: "allocation",
    evidence: "backfill keeps a deleted identity",
  },
  {
    // The allocation reads the floor before the lock and uses that stale answer.
    file: "core/state/index.js",
    from: "const floorKey = `allocation:${prefix}`;",
    to: "const floorKey = `allocation:${prefix}`; const early = this.get(namespace, floorKey); const stale = early ? floorNumber(early.value, prefix) : 0;",
    also: { from: "const number = last + 1;", to: "const number = stale + 1;" },
    journey: "lock",
    evidence: "allocation happens inside the write lock",
  },
  {
    // The floor is committed on its own, before the issue write, instead of in the shared transaction.
    file: "core/state/index.js",
    from: "this.#apply(namespace, floorKey, { prefix, number }, actor, now, undefined);",
    to: "/* floor write moved */",
    also: {
      from: "const record = this.#apply(namespace, key, stored, actor, now, undefined, true);",
      to: 'this.#apply(namespace, floorKey, { prefix, number }, actor, now, undefined); this.#db.run("COMMIT"); this.#db.run("BEGIN IMMEDIATE"); const record = this.#apply(namespace, key, stored, actor, now, undefined, true);',
    },
    journey: "atomic",
    evidence: "a failed create leaves the floor unchanged",
  },
];
