import { expect, test } from "bun:test";
import type { McpCandidate } from "../../src/contract/mcp.ts";
import type { SurfaceCatalog } from "../../src/surface/catalog.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";
test("MCP construction reads the catalog once", () => {
  const entries = [candidate("sample.one"), candidate("sample.two")];
  let reads = 0;
  const catalog: SurfaceCatalog = {
    ...fakeCatalog(entries),
    list: () => {
      reads++;
      return entries;
    },
  };

  createMcpHandlers(catalog);
  expect(reads).toBe(1);
}, 30_000);
test("separate MCP constructions see fresh candidates", () => {
  let entries: readonly McpCandidate[] = [candidate("sample.old")];
  const catalog: SurfaceCatalog = { ...fakeCatalog(), list: () => entries };
  const names = () =>
    createMcpHandlers(catalog)
      .listTools()
      .map((tool) => tool.name);
  expect(names()).toContain("sample_old");
  entries = [candidate("sample.fresh")];
  expect(names()).toContain("sample_fresh");
}, 30_000);

test("read-only hidden writes are unknown tools", async () => {
  let entries: readonly McpCandidate[] = [];
  const catalog: SurfaceCatalog = { ...fakeCatalog(), list: () => entries };
  const handlers = createMcpHandlers(catalog, { readOnly: true });
  entries = [candidate("fresh.write", { effects: ["external:network"] })];
  expect(await handlers.callTool("fresh_write", {})).toBeUndefined();
  expect(await handlers.callTool("never_existed", {})).toBeUndefined();
}, 30_000);
