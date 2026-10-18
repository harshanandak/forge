// The config and template operations are declared once (operations.json) with input and output
// schemas. This drives every handler through a real journey and checks each input and output
// against what is declared, so the generated CLI and MCP surfaces describe what actually happens.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CORE_NOUNS,
  parseOperationName,
  SCHEMA_DOCUMENTS,
  type SchemaObject,
  SchemaRegistry,
  validateOperationDeclaration,
} from "../../../src/contract/index.ts";
import { createConfigOperations } from "../../../src/core/config/index.ts";
import { type Fixture, makeProject, npmDetections } from "./lib/project.ts";

setDefaultTimeout(30_000);

const DIR = new URL("../../../src/core/config/", import.meta.url);
const read = (path: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(path, DIR)), "utf8"));
const fragment = read("operations.json") as {
  operations: Record<
    string,
    { input: string; output: string; effects: string[] }
  >;
};
const own = readdirSync(fileURLToPath(new URL("schemas/", DIR))).map(
  (name) => read(`schemas/${name}`) as SchemaObject,
);
const registry = new SchemaRegistry([...SCHEMA_DOCUMENTS, ...own]);
const BASE =
  "https://raw.githubusercontent.com/harshanandak/forge/main/src/core/config/";

const open: Fixture[] = [];
afterEach(() => {
  for (const made of open.splice(0)) made.cleanup();
});

test("every operation is a valid declaration under a core noun, and read-only ones declare no effects", () => {
  const names = Object.keys(fragment.operations).sort();
  expect(names).toEqual([
    "config.apply",
    "config.detect",
    "config.explain",
    "config.preview",
    "config.revert",
    "config.save",
    "config.set",
    "config.show",
    "template.compare",
    "template.import",
    "template.list",
    "template.remove",
    "template.show",
    "template.update",
  ]);
  for (const [name, declaration] of Object.entries(fragment.operations)) {
    expect(validateOperationDeclaration(declaration).ok).toBe(true);
    expect(CORE_NOUNS).toContain(parseOperationName(name)?.noun ?? "");
    const reads = /\.(show|explain|detect|preview|list|compare)$/.test(name);
    expect(declaration.effects.length === 0).toBe(reads);
    expect(registry.lookup(`${BASE}${declaration.input}`)).toBeDefined();
    expect(registry.lookup(`${BASE}${declaration.output}`)).toBeDefined();
  }
});

test("each handler's real input and output match its declared schemas", () => {
  const p = makeProject({ detections: npmDetections });
  open.push(p);
  const handlers = createConfigOperations(p.env);
  expect(Object.keys(handlers).sort()).toEqual(
    Object.keys(fragment.operations).sort(),
  );

  const call = (
    op: string,
    input: Record<string, unknown>,
  ): Record<string, unknown> => {
    const declaration = fragment.operations[op];
    if (declaration === undefined) throw new Error(op);
    expect({
      op,
      problems: registry.validate(`${BASE}${declaration.input}`, input),
    }).toEqual({ op, problems: [] });
    const handler = handlers[op];
    if (handler === undefined) throw new Error(op);
    const output = JSON.parse(JSON.stringify(handler(input))) as Record<
      string,
      unknown
    >;
    expect({
      op,
      problems: registry.validate(`${BASE}${declaration.output}`, output),
    }).toEqual({ op, problems: [] });
    return output;
  };

  let revision = call("config.show", {}).revision as string;
  call("config.show", {
    invocation: [{ op: "set", path: "check.commands.test", value: "x" }],
  });
  call("config.detect", {});
  call("config.explain", { path: "check.commands.test" });
  call("config.preview", {
    patch: [{ op: "set", path: "check.commands.test", value: "pnpm test" }],
  });
  call("config.preview", { patch: [{ op: "set", path: "/nope", value: 1 }] });
  revision = call("config.set", {
    path: "check.commands.test",
    value: "pnpm test",
    expectRevision: revision,
  }).revision as string;
  revision = call("config.apply", {
    patch: [{ op: "set", path: "check.commands.lint", value: "pnpm lint" }],
    expectRevision: revision,
  }).revision as string;
  revision = call("config.revert", { expectRevision: revision })
    .revision as string;
  revision = call("config.save", { expectRevision: revision })
    .revision as string;
  call("template.list", {});
  call("template.show", { template: "forge/delivery" });
  revision = call("template.import", {
    template: "forge/starter",
    expectRevision: revision,
  }).revision as string;
  call("template.compare", { template: "forge/starter" });
  revision = call("template.update", {
    template: "forge/starter",
    expectRevision: revision,
  }).revision as string;
  call("template.show", { template: "forge/starter" });
  call("template.remove", {
    template: "forge/starter",
    expectRevision: revision,
  });
});
