import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { shippedTemplates } from "../../../src/assembly/templates.ts";
import { makeProject, readJsonAt, type Fixture } from "./lib/project.ts";

setDefaultTimeout(30_000);
const projects: Fixture[] = [];
function delivery(): Fixture {
  const p = makeProject();
  projects.push(p);
  p.installed.set("delivery", shippedTemplates().get("delivery")!);
  p.config.set({
    path: "/blocks/check/config/commands",
    value: { test: "node --version" },
    expectRevision: p.config.show().revision,
  });
  return p;
}
afterEach(() => {
  for (const p of projects.splice(0)) p.cleanup();
});

test("delivery summaries are small and verbose preserves the baseline changes", () => {
  const p = delivery();
  const imported = p.templates.importTemplate({
    template: "delivery",
    expectRevision: p.config.show().revision,
  });
  expect(imported).not.toHaveProperty("changes");
  expect(imported.added.length).toBeGreaterThan(0);
  expect(imported.next).toEqual(["forge skills sync", "forge check run"]);
  const size = Buffer.byteLength(JSON.stringify(imported));
  expect(size).toBeLessThan(1000);
  const other = delivery();
  const verbose = other.templates.importTemplate({
    template: "delivery",
    expectRevision: other.config.show().revision,
    verbose: true,
  });
  expect(
    readJsonAt("test/contract/fixtures/templates/delivery-import-changes.json"),
  ).toEqual(verbose.changes);
  const { changes: _changes, ...summary } = verbose;
  expect(summary).toEqual(imported);
  console.log(
    `delivery import result: default ${size}, verbose ${Buffer.byteLength(JSON.stringify(verbose))} bytes`,
  );

  const removed = p.templates.remove({
    template: "harsha/delivery",
    expectRevision: imported.revision,
  });
  expect(removed).not.toHaveProperty("changes");
  expect(removed.removed).toEqual(imported.added);
  expect(removed.kept).toEqual([]);
  expect(removed.next).toEqual(["forge skills sync"]);
  const verboseRemoved = other.templates.remove({
    template: "harsha/delivery",
    expectRevision: verbose.revision,
    verbose: true,
  });
  expect(verboseRemoved.changes!.length).toBeGreaterThan(0);
  const { changes: _removedChanges, ...removedSummary } = verboseRemoved;
  expect(removedSummary).toEqual(removed);
});

test("a template without a check block only recommends syncing skills", () => {
  const p = makeProject();
  projects.push(p);
  p.installed.set("empty", {
    schemaVersion: "forge.template/1",
    id: "test/empty",
    version: "1.0.0",
    summary: "Empty",
    config: { schemaVersion: "forge.config/1", blocks: {} },
  });
  expect(p.templates.importTemplate({ template: "empty" }).next).toEqual([
    "forge skills sync",
  ]);
});
