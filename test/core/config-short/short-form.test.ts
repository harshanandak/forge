// The short config form: a built-in block turned on with only the keys a team changes. Every other
// key comes from the block's configSchema defaults, and explain says so.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateWithSchema } from "../../../src/contract/schema.ts";
import type { TemplateDocument } from "../../../src/contract/index.ts";
import {
  type Fixture,
  makeProject,
  readJsonAt,
} from "../l4-config/lib/project.ts";

const checkSchema = readJsonAt("src/blocks/check/schemas/config.json") as {
  properties: Record<string, { default?: unknown }>;
};
const open: Fixture[] = [];
function project(file?: string): Fixture {
  const p = makeProject({
    configSchema: (_name, source) =>
      "builtin" in source && source.builtin === "forge/check"
        ? checkSchema
        : undefined,
  });
  open.push(p);
  if (file !== undefined) {
    mkdirSync(join(p.root, ".forge"), { recursive: true });
    writeFileSync(join(p.root, ".forge/config.yaml"), file);
  }
  return p;
}
afterEach(() => {
  for (const p of open.splice(0)) p.cleanup();
});

const SHORT = 'blocks:\n  check:\n    commands: { test: "bun test" }\n';

describe("short form", () => {
  test("check with only commands loads complete and valid against its schema", () => {
    const shown = project(SHORT).config.show();
    expect(shown.problems).toEqual([]);
    expect(shown.instances).toEqual([
      { name: "check", source: { builtin: "forge/check" }, enabled: true },
    ]);
    const config = (
      shown.effective.blocks as Record<string, { config: object }>
    ).check?.config;
    expect(config).toMatchObject({
      commands: { test: "bun test" },
      timeoutMs: 60000,
      maxOutputBytes: 65536,
      report: "auto",
      stopOnFailure: true,
      environment: [],
    });
    // the runtime validates exactly this effective config before check runs
    expect(validateWithSchema(checkSchema, config)).toEqual([]);
  }, 10_000);

  test("explain names default, user and template as the source of each value", () => {
    const p = project(`${SHORT}    timeoutMs: 5000\n`);
    const timeout = p.config.explain({ path: "check.timeoutMs" });
    expect(timeout).toMatchObject({ value: 5000, source: "user" });
    expect(timeout.entries.find((e) => e.layer === "default")).toMatchObject({
      value: 60000,
      active: false,
    });
    expect(p.config.explain({ path: "check.report" })).toMatchObject({
      value: "auto",
      layer: "default",
      source: "default",
    });
    expect(p.config.explain({ path: "check.commands.test" }).source).toBe(
      "user",
    );

    const t = project();
    const template: TemplateDocument = {
      schemaVersion: "forge.template/1",
      id: "acme/fast",
      version: "1.0.0",
      summary: "Short check budget.",
      config: {
        schemaVersion: "forge.config/1",
        blocks: {
          check: {
            source: { builtin: "forge/check" },
            config: { commands: { test: "bun test" }, timeoutMs: 9000 },
          },
        },
      },
    };
    t.installed.set("acme/fast", template);
    t.templates.importTemplate({
      template: "acme/fast",
      expectRevision: t.config.show().revision,
    });
    expect(t.config.explain({ path: "check.timeoutMs" })).toMatchObject({
      value: 9000,
      source: "template",
    });
    expect(t.config.explain({ path: "check.maxOutputBytes" }).source).toBe(
      "default",
    );
  }, 10_000);

  test("edits to a short-form file are checked with defaults applied", () => {
    const p = project(SHORT);
    const written = p.config.set({
      path: "check.stopOnFailure",
      value: false,
      expectRevision: p.config.show().revision,
    });
    expect(written.receipt).not.toBeNull();
    expect(p.config.explain({ path: "check.stopOnFailure" }).value).toBe(false);
    expect(() =>
      p.config.set({
        path: "check.timeoutMs",
        value: 0,
        expectRevision: p.config.show().revision,
      }),
    ).toThrow("/blocks/check/config/timeoutMs");
  }, 10_000);

  test("use names an outside block; inline keys go to config, instance keys stay", () => {
    const shown = project(
      "blocks:\n  hello:\n    use: ./blocks/hello\n    enabled: false\n    greeting: hi\n  pkg:\n    use: acme-hello\n",
    ).config.show();
    expect(shown.problems).toEqual([]);
    expect(shown.instances).toEqual([
      { name: "hello", source: { path: "./blocks/hello" }, enabled: false },
      { name: "pkg", source: { package: "acme-hello" }, enabled: true },
    ]);
    expect(shown.effective.blocks).toMatchObject({
      hello: { enabled: false, config: { greeting: "hi" } },
    });
  }, 10_000);

  test("an absolute use path is refused with a clear message at its own pointer", () => {
    for (const abs of [
      "/opt/blocks/hello",
      "C:/blocks/hello",
      "\\\\host\\blocks",
    ]) {
      const shown = project(
        `blocks:\n  hello:\n    use: ${JSON.stringify(abs)}\n`,
      ).config.show();
      expect(shown.excluded.map((e) => e.pointer)).toEqual(["/blocks/hello"]);
      expect(shown.problems.join(" ")).toContain(
        "/blocks/hello/use must be a path relative to the project",
      );
    }
  }, 10_000);

  test("ambiguous short form is refused at its own pointer, not guessed", () => {
    const shown = project(
      "blocks:\n  check:\n    use: ./x\n    source: { builtin: forge/check }\n    config: { report: json }\n    report: auto\n",
    ).config.show();
    expect(shown.excluded.map((e) => e.pointer)).toEqual(["/blocks/check"]);
    expect(shown.problems.join(" ")).toContain("/blocks/check");
  }, 10_000);

  test("every check key but commands has a default inside its own bounds", () => {
    const keys = Object.entries(checkSchema.properties);
    expect(keys.filter(([, p]) => !("default" in p)).map(([k]) => k)).toEqual([
      "commands",
    ]);
    const defaults = Object.fromEntries(
      keys.flatMap(([k, p]) => ("default" in p ? [[k, p.default]] : [])),
    );
    expect(
      validateWithSchema(checkSchema, { ...defaults, commands: {} }),
    ).toEqual([]);
  }, 10_000);
});
