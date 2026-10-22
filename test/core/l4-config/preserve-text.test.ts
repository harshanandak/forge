import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { makeProject, type Fixture } from "./lib/project.ts";
import { encodeDocument } from "../../../src/core/config/document.ts";
import { yamlConfigCodec } from "../../../src/adapters/config-yaml/index.ts";

setDefaultTimeout(30_000);
const projects: Fixture[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) p.cleanup();
});

const handwritten = `# Our team's choices
blocks:
  git:
    base: 'main' # keep this quote and comment

  check: # checks go last
    timeoutSeconds: 30
    commands:
      lint: "make lint"
      test: 'make test'  # two spaces

# end of team config
`;

test("a CST gap warns and still writes the planned values", () => {
  const warnings: string[] = [];
  const bytes = encodeDocument(
    { schemaVersion: "forge.config/1", values: {}, blocks: {} },
    yamlConfigCodec,
    "values:\n  retries: 1\n  # Keep this explanation\nblocks: {}\n",
    {},
    (message) => warnings.push(message),
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("formatting could not be preserved");
  expect(new TextDecoder().decode(bytes ?? undefined)).toContain("values: {}");
});

test("editing a short package source retains its version on reload", () => {
  const p = makeProject();
  projects.push(p);
  p.env.files.write(
    ".forge/config.yaml",
    new TextEncoder().encode('blocks:\n  demo:\n    use: "@team/demo"\n'),
  );
  const source = { package: "@team/demo", version: "1.2.3" };
  const result = p.config.set({
    path: "/blocks/demo/source",
    value: source,
    expectRevision: p.config.show().revision,
  });
  expect(result.changes).not.toEqual([]);
  expect(
    p.config.show().instances.find((item) => item.name === "demo")?.source,
  ).toEqual(source);
  expect(p.read()).toContain("version: 1.2.3");
});

test("a template path without a dot stays unedited and removable in short form", () => {
  const p = makeProject();
  projects.push(p);
  p.env.files.write(
    ".forge/config.yaml",
    new TextEncoder().encode("blocks: {}\n"),
  );
  p.installed.set("team/demo", {
    schemaVersion: "forge.template/1",
    id: "team/demo",
    version: "1.0.0",
    summary: "Local demo",
    config: {
      schemaVersion: "forge.config/1",
      blocks: { demo: { source: { path: "blocks/demo" } } },
    },
  });
  const imported = p.templates.importTemplate({
    template: "team/demo",
    expectRevision: p.config.show().revision,
  });
  expect(p.templates.show({ template: "team/demo" }).owned).toEqual(
    imported.added.map((pointer) => ({ pointer, edited: false })),
  );
  const removed = p.templates.remove({
    template: "team/demo",
    expectRevision: imported.revision,
  });
  expect(removed.kept).toEqual([]);
  expect(removed.removed).toEqual(imported.added);
  expect(p.config.show().instances).toEqual([]);
});

for (const check of [
  "  check: # keep instance\n    config: {} # deliberately empty\n",
  "  check: {} # keep empty instance\n",
  "  check: # keep null instance\n",
]) {
  test("editing git leaves an untouched empty check instance byte-identical", () => {
    const p = makeProject();
    projects.push(p);
    const text = `blocks:\n  git:\n    base: 'main'\n${check}`;
    p.env.files.write(".forge/config.yaml", new TextEncoder().encode(text));
    p.config.set({
      path: "git.base",
      value: "develop",
      expectRevision: p.config.show().revision,
    });
    expect(p.read()).toBe(text.replace("'main'", "'develop'"));
  });
}

test("source-only template blocks remain removable after import into short form", () => {
  const p = makeProject();
  projects.push(p);
  const text = "blocks:\n  git:\n    base: 'main' # user choice\n";
  p.env.files.write(".forge/config.yaml", new TextEncoder().encode(text));
  const imported = p.templates.importTemplate({
    template: "forge/starter",
    expectRevision: p.config.show().revision,
  });
  expect(
    p.templates
      .show({ template: "forge/starter" })
      .owned.toSorted((a, b) => a.pointer.localeCompare(b.pointer)),
  ).toEqual(imported.added.map((pointer) => ({ pointer, edited: false })));
  const removed = p.templates.remove({
    template: "forge/starter",
    expectRevision: imported.revision,
  });
  expect(removed.removed).toEqual(imported.added);
  expect(removed.kept).toEqual([]);
  expect(p.config.show().instances.map((instance) => instance.name)).toEqual([
    "git",
  ]);
  expect(p.config.show().templates).toEqual([]);
});

for (const text of [
  "\uFEFF# header\nblocks:\n  git:\n    base: 'main'\n",
  "# header\nschemaVersion: forge.config/1\nblocks:\n  git:\n    source: { builtin: forge/git }\n    config:\n      base: 'main'\n",
  "# header\nblocks:\n  git:\n    base: 'main'\n    config:\n      sign: true\n",
]) {
  test("an edit preserves the BOM and each existing instance spelling", () => {
    const p = makeProject();
    projects.push(p);
    p.env.files.write(".forge/config.yaml", new TextEncoder().encode(text));
    p.config.set({
      path: "git.base",
      value: "develop",
      expectRevision: p.config.show().revision,
    });
    expect(p.read()).toBe(text.replace("'main'", "'develop'"));
  });
}

for (const text of ["# only a comment\n", "# hand-written\nblocks: {}\n"]) {
  test("saving an already empty hand-written file is a byte-exact no-op", () => {
    const p = makeProject();
    projects.push(p);
    p.env.files.write(".forge/config.yaml", new TextEncoder().encode(text));
    p.config.save({ expectRevision: p.config.show().revision });
    expect(p.read()).toBe(text);
  });
}

for (const newline of ["\n", "\r\n"]) {
  for (const writer of [
    "set",
    "apply",
    "remove",
    "save",
    "template",
  ] as const) {
    test(`${writer} preserves hand-written short YAML (${JSON.stringify(newline)})`, () => {
      const p = makeProject({
        detections: () => [
          {
            key: "/blocks/git/config/sign",
            value: true,
            origin: { detector: "project.detect" },
          },
        ],
      });
      projects.push(p);
      const original = handwritten.replaceAll("\n", newline);
      p.env.files.write(
        ".forge/config.yaml",
        new TextEncoder().encode(original),
      );
      const expectRevision = p.config.show().revision;
      if (writer === "set")
        p.config.set({ path: "git.base", value: "develop", expectRevision });
      if (writer === "apply")
        p.config.apply({
          patch: [{ op: "set", path: "git.base", value: "develop" }],
          expectRevision,
        });
      if (writer === "remove")
        p.config.apply({
          patch: [{ op: "remove", path: "check.commands.lint" }],
          expectRevision,
        });
      if (writer === "save")
        p.config.save({ paths: ["git.sign"], expectRevision });
      if (writer === "template") {
        p.installed.set("team/extra", {
          schemaVersion: "forge.template/1",
          id: "team/extra",
          version: "1.0.0",
          summary: "Extra choice",
          config: {
            schemaVersion: "forge.config/1",
            blocks: {
              git: { source: { builtin: "forge/git" }, config: { sign: true } },
            },
          },
        });
        p.templates.importTemplate({ template: "team/extra", expectRevision });
      }
      const expected =
        writer === "set" || writer === "apply"
          ? original.replace("'main'", "'develop'")
          : writer === "remove"
            ? original.replace(`      lint: "make lint"${newline}`, "")
            : original.replace(
                `${newline}${newline}  check:`,
                `${newline}    sign: true${newline}${newline}  check:`,
              );
      if (writer === "template") {
        // Provenance is added at the root; all pre-existing bytes still survive.
        const text = p.read() ?? "";
        const start = text.indexOf(`owners:${newline}`);
        const end = text.indexOf(`${newline}# end of team config`);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        expect(text.slice(0, start) + text.slice(end)).toBe(expected);
        expect(p.config.show().templates).toEqual([
          expect.objectContaining({ template: "team/extra@1.0.0" }),
        ]);
      } else expect(p.read()).toBe(expected);
      expect(p.config.show().valid).toBe(true);
      expect(p.read()).not.toContain("schemaVersion:");
    });
  }
}
