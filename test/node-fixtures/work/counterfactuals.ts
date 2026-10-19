export const counterfactuals: readonly {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly journey: string;
  readonly evidence: string;
}[] = [
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
    from: "{ id: input.id, body: input.body }",
    to: '{ id: input.id, body: "lost comment" }',
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
    from: 'if (stored(get(state, input.id)).status !== "open") {',
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
    from: "appended(state, `comment:${input.id}:`)",
    to: "state.list(`comment:${input.id}:`)",
    journey: "append-order",
    evidence: "comments must retain append order beyond nine",
  },
  {
    file: "blocks/work/entry.cjs",
    from: "appended(state, `link:${input.id}:`)",
    to: "state.list(`link:${input.id}:`)",
    journey: "append-order",
    evidence: "links must retain append order beyond nine",
  },
];
