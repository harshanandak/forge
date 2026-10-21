import { expect, setDefaultTimeout, test } from "bun:test";
import { BlockCatalog } from "../../../src/core/runtime/catalog.ts";
import { TrustStore } from "../../../src/core/trust/index.ts";
import { runCli } from "../../../src/surface/cli.ts";

setDefaultTimeout(30_000);

for (const verb of ["check", "add"]) {
  test(`block ${verb} reports every manifest field using input diagnostics`, async () => {
    const catalog = new BlockCatalog(
      {
        open: () => ({
          ownership: "borrowed",
          value: {
            manifestPath: "forge.block.json",
            read: () =>
              new TextEncoder().encode(
                JSON.stringify({
                  schemaVersion: "forge.block/1",
                  id: "example.org/hello",
                  version: "1.0.0",
                  authorAbi: "forge.author/v2",
                  profile: "trusted-action/v2",
                  entyr: "index.cjs",
                  operations: 42,
                  docs: "docs.json",
                }),
              ),
          },
        }),
      },
      new TrustStore(),
    );
    const result = await runCli(catalog, ["block", verb, "./hello"], {
      caller: "human",
      context: { device: { id: "local" } },
    });
    expect(result.exitCode).toBe(6);
    expect(result.envelope.ok).toBe(false);
    if (result.envelope.ok) throw new Error("expected refusal");
    expect(result.envelope.error.message).toBe(
      'Invalid input for block manifest ./hello/forge.block.json:\nentry is required\nUnknown field "entyr"; did you mean "entry"?\noperations must be object; received 42',
    );
    expect(result.envelope.error.observed).toMatchObject({
      problems: [
        { pointer: "/entry", problem: "missing required" },
        { pointer: "/entyr", suggestion: "entry" },
        { pointer: "/operations", problem: "wrong type", received: "42" },
      ],
    });
    expect(catalog.list()).toEqual([]);
  });
}
