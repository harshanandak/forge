export interface Counterfactual {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly journey: string;
  readonly evidence: string;
}
export const counterfactuals: readonly Counterfactual[] = [
  {
    file: "blocks/check/forge.block.json",
    from: "forge.state@1",
    to: "forge.state@^1.0.0",
    journey: "mcp",
    evidence: "Unknown operation: check.run",
  },
  {
    file: "adapters/runner-output/index.js",
    from: "|errors?|warnings?|reruns?)$/",
    to: "|errors?|reruns?)$/",
    journey: "pytest",
    evidence: "pytest warnings preserve the real test count",
  },
  {
    file: "blocks/check/entry.cjs",
    from: "const result = await services.process.run(",
    to: "const result = services.process.run(",
    journey: "mcp",
    evidence: "MCP awaits the declared command",
  },
  {
    file: "blocks/check/entry.cjs",
    from: "function status(value) {",
    to: "function status(value) { if (Array.isArray(value)) return true;",
    journey: "receipt",
    evidence: "coercible receipt status is invalid",
  },
  {
    file: "assembly/first-party.js",
    from: '"forge/check": new URL("../blocks/check/", import.meta.url),',
    to: "",
    journey: "surfaces",
    evidence: "Unknown operation: check.run",
  },
  {
    file: "blocks/check/entry.cjs",
    from: "const result = await services.process.run(",
    to: "const result = services.process.run(",
    journey: "handler",
    evidence: "async handler awaits the actual process service",
  },
  {
    file: "adapters/process/run.js",
    from: 'options.signal?.addEventListener("abort", cancel, { once: true });',
    to: "void 0;",
    journey: "cancellation",
    evidence: "cancellation stops the tree before command timeout",
  },
  {
    file: "blocks/check/operations.js",
    from: "signal: args.signal",
    to: "signal: new AbortController().signal",
    journey: "handler",
    evidence: "cancelled handler starts no process",
  },
  {
    file: "blocks/check/entry.cjs",
    from: "parsed.testCount === 0",
    to: "false",
    journey: "zero",
    evidence: "Check receipt integrity failed",
  },
  {
    file: "blocks/check/entry.cjs",
    from: 'parsed.kind === "malformed"',
    to: "false",
    journey: "malformed",
    evidence: "malformed reports incomplete",
  },
  {
    file: "blocks/check/entry.cjs",
    from: "if (runs.length === 0 || runs.some",
    to: "if (false || runs.some",
    journey: "nothing",
    evidence: "Check receipt integrity failed",
  },
  {
    file: "blocks/check/entry.cjs",
    from: "stdout: result.stdout,",
    to: 'stdout: "",',
    journey: "timeout",
    evidence: "timeout keeps output",
  },
  {
    file: "blocks/check/entry.cjs",
    from: "env: { ...env }",
    to: "env: { ...process.env, ...env }",
    journey: "environment",
    evidence: "child gets only selected environment",
  },
  {
    file: "blocks/check/entry.cjs",
    from: "stored === digest(body, crypto)",
    to: "true",
    journey: "receipt",
    evidence: "changed evidence fails integrity",
  },
  {
    file: "blocks/check/entry.cjs",
    from: "environmentDigest: hash(env)",
    to: 'environmentDigest: "removed"',
    journey: "receipt",
    evidence: "environment binds receipt",
  },
];
