import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as providers from "../../../src/assembly/providers.ts";
import { LocalState } from "../../../src/assembly/state.ts";
import { runCli } from "../../../src/surface/cli.ts";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import { withReportAssembly } from "./fixtures.ts";

test("FR-CREATE1, FR-COUNT1 and FR-NET1 file through assembled CLI and MCP into one private device record", async () => {
  await withReportAssembly(
    async (assembly, options) => {
      const message = "Show the next action";
      let now = Date.now();
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      const git = spyOn(providers, "idPrefixObservation");
      const network = spyOn(globalThis, "fetch");
      const state = new LocalState(join(assembly.deviceRoot, "records.sqlite"));
      try {
        const cli = await runCli(
          assembly.catalog,
          ["report", "create", message],
          options,
        );
        expect(cli.envelope).toMatchObject({
          ok: true,
          result: { count: 1, promotion: "unpromoted" },
        });
        const fingerprint = (cli.envelope?.result as { fingerprint: string })
          .fingerprint;
        expect(fingerprint).toMatch(/^fp1:[a-f0-9]{64}$/);
        const firstSeen = new Date(now).toISOString();
        now += 1000;
        const mcp = createMcpHandlers(
          assembly.mcpCatalog,
          assembly.exposure,
          options,
        );
        expect(mcp.listTools().map(({ name }) => name)).toContain(
          "report_create",
        );
        const second = await mcp.callTool("report_create", { message });
        expect(second?.result).toEqual({
          fingerprint,
          count: 2,
          promotion: "unpromoted",
        });
        const invalid = await mcp.callTool("report_create", {
          message,
          PrivateFieldFixture: "PrivateValueFixture",
        });
        expect(invalid).toMatchObject({
          ok: false,
          error: { code: "INPUT_INVALID" },
        });
        expect(JSON.stringify(invalid)).not.toContain("Fixture");
        now += 1000;
        const third = await assembly.catalog.invoke({
          schemaVersion: "forge.invocation/1",
          op: "report.create",
          requestId: "PrivateRequestFixture",
          caller: "agent",
          input: { message },
          context: {
            actor: { kind: "agent", id: "PrivateActorFixture" },
            device: { id: assembly.deviceRoot },
            session: {
              id: "PrivateSessionFixture",
              harness: "PrivateHarnessFixture",
            },
          },
        });
        expect(third.result).toEqual({
          fingerprint,
          count: 3,
          promotion: "unpromoted",
        });
        const lease = await state.acquire(false);
        try {
          const records = lease.value?.list("forge/report");
          expect(records).toHaveLength(1);
          expect(records?.[0]?.value).toMatchObject({
            fingerprint,
            count: 3,
            summary: message,
            firstSeen,
            lastSeen: new Date(now).toISOString(),
          });
          const events = lease.value?.events("forge/report", fingerprint);
          expect(events).toHaveLength(3);
          expect(JSON.stringify([records, events, third])).not.toContain(
            "Fixture",
          );
          expect(lease.value?.list("forge/memory")).toEqual([]);
        } finally {
          await lease.close();
        }
        expect(existsSync(join(assembly.root, ".forge", "state.sqlite"))).toBe(
          false,
        );
        expect(git).not.toHaveBeenCalled();
        expect(network).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
        git.mockRestore();
        network.mockRestore();
        await state.close();
      }
    },
    {
      schemaVersion: "forge.config/1",
      blocks: {},
      mcp: { expose: ["report.create"] },
    },
  );
}, 30_000);

test("FR-CREATE1 files without a project and with broken project YAML", async () => {
  for (const config of [false, "blocks: [broken"] as const) {
    await withReportAssembly(async (assembly, options) => {
      const cli = await runCli(
        assembly.catalog,
        ["report", "create", "Missing validation notice"],
        options,
      );
      expect(cli.envelope).toMatchObject({ ok: true, result: { count: 1 } });
      expect(existsSync(join(assembly.root, ".forge", "state.sqlite"))).toBe(
        false,
      );
    }, config);
  }
}, 30_000);
