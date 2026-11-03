import { expect, setDefaultTimeout, test } from "bun:test";
import { BlockCatalog } from "../../../src/core/runtime/catalog.ts";
import { TrustStore } from "../../../src/core/trust/index.ts";
import { runCli } from "../../../src/surface/cli.ts";
import { captureBlock } from "../../../src/core/catalog/index.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import { fixture } from "../../contract/lib/fixtures.ts";
import type { BlockManifest } from "../../../src/generated/types.ts";

setDefaultTimeout(30_000);

for (const second of [
  { slot: "tracker", interface: "forge.tracker@1" },
  { slot: "tracker", interface: "forge.state@1", optional: true },
]) {
  test(`capture refuses duplicate slot names for ${second.interface}`, () => {
    const manifest = fixture("blocks/semver/forge.block.json") as BlockManifest;
    const bytes = new TextEncoder();
    const files = new Map([
      [
        "block.json",
        JSON.stringify({
          ...manifest,
          requires: [{ slot: "tracker", interface: "forge.tracker@1" }, second],
        }),
      ],
      [manifest.entry, "module.exports = {};"],
      [manifest.docs, "{}"],
      [manifest.configSchema!, "{}"],
      ...Object.values(manifest.operations).flatMap(
        (op): [string, string][] => [
          [op.input, "{}"],
          [op.output, "{}"],
        ],
      ),
    ]);
    let failure: unknown;
    try {
      captureBlock("./sample", {
        open: () => ({
          ownership: "borrowed",
          value: {
            manifestPath: "forge.block.json",
            read: (name) => {
              const text = files.get(name);
              if (text === undefined)
                throw new Error(`missing fixture ${name}`);
              return bytes.encode(text);
            },
          },
        }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ForgeFailure);
    if (!(failure instanceof ForgeFailure)) throw new Error("expected refusal");
    expect(failure.error.code).toBe("INPUT_INVALID");
    expect(failure.error.message).toContain(
      "Invalid input for block manifest ./sample/forge.block.json",
    );
    expect(failure.error.observed).toMatchObject({
      problems: [{ pointer: "/requires/1/slot" }],
    });
    expect(failure.error.message).toContain("tracker");
  });
}

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
