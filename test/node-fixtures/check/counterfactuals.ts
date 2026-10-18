export interface Counterfactual {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly journey: string;
  readonly evidence: string;
}
export const counterfactuals: readonly Counterfactual[] = [
  {
    file: "blocks/check/index.js",
    from: "parsed.testCount === 0",
    to: "false",
    journey: "zero",
    evidence: "recognized zero tests fail",
  },
  {
    file: "blocks/check/index.js",
    from: 'parsed.kind === "malformed"',
    to: "false",
    journey: "malformed",
    evidence: "malformed reports incomplete",
  },
  {
    file: "blocks/check/index.js",
    from: "runs.length === 0 ||",
    to: "false ||",
    journey: "nothing",
    evidence: "nothing declared is not executed",
  },
  {
    file: "blocks/check/index.js",
    from: "...result,",
    to: '...result, stdout: "",',
    journey: "timeout",
    evidence: "timeout keeps output",
  },
  {
    file: "blocks/check/index.js",
    from: "env: { ...env }",
    to: "env: { ...process.env, ...env }",
    journey: "environment",
    evidence: "child gets only selected environment",
  },
  {
    file: "blocks/check/receipt.js",
    from: "digest === hash(body)",
    to: "true",
    journey: "receipt",
    evidence: "changed evidence fails integrity",
  },
  {
    file: "blocks/check/index.js",
    from: "environmentDigest: hash(env)",
    to: 'environmentDigest: "removed"',
    journey: "receipt",
    evidence: "environment binds receipt",
  },
];
