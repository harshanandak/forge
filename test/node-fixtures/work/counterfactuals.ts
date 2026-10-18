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
    from: "return !blocked(state, value) && !live(state, value.id);",
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
];
