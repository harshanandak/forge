export const counterfactuals = [
  {
    file: "blocks/pr/entry.cjs",
    from: "view.evidence.headSha !== call.input.expectHead",
    to: "false",
    journey: "head",
    evidence: "HEAD_MOVED",
  },
  {
    file: "blocks/pr/entry.cjs",
    from: "const intent = s.state.put(",
    to: "const intent = ({revision: Number(call.input.expectRevision) + 1}); void s.state.get(",
    journey: "fence",
    evidence: "stale lease must not trigger provider mutation",
  },
  {
    file: "blocks/pr/entry.cjs",
    from: "const accepted = s.state.put(",
    to: "const accepted = ({revision: intentRevision + 1}); void s.state.get(",
    journey: "accepted",
    evidence: "expected rejection",
  },
  {
    file: "blocks/pr/entry.cjs",
    from: '!["SUCCESS", "NEUTRAL", "SKIPPED"].includes',
    to: '!["SUCCESS"].includes',
    journey: "optional",
    evidence: "expected verdict MERGE_READY",
  },
  {
    file: "blocks/pr/entry.cjs",
    from: 'if (review.state === "COMMENTED" || review.state === "DISMISSED")',
    to: "if (false)",
    journey: "stale-review",
    evidence: "expected verdict MERGE_READY",
  },
] as const;
