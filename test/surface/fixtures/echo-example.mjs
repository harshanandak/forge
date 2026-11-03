import { runCli } from "../../../dist/src/surface/cli.js";

const entry = {
  op: "sample.echo",
  admitted: true,
  declaration: {
    input: "input.json",
    output: "output.json",
    context: "stateless",
    effects: [],
    idempotent: true,
    callers: ["human", "agent"],
    stability: "stable",
  },
  docs: { title: "Echo", summary: "Echo a scalar without opening a store." },
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};
const result = await runCli(
  {
    list: () => [entry, { ...entry, op: "sample.run", inputSchema: {} }],
    invoke: async (request) => ({
      ok: true,
      op: request.op,
      status: "OK",
      result: request.input,
      warnings: [],
    }),
  },
  process.argv.slice(2),
);
process.stdout.write(result.stdout);
process.exitCode = result.exitCode;
