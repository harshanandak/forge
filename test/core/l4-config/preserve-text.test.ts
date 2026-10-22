import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { makeProject, type Fixture } from "./lib/project.ts";
import { createConfig } from "../../../src/core/config/index.ts";

setDefaultTimeout(30_000);
const projects: Fixture[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) p.cleanup();
});
const open = (text: string) => {
  const p = makeProject();
  projects.push(p);
  p.env.files.write(".forge/config.yaml", new TextEncoder().encode(text));
  return p;
};
test("replacing the first of equal list values keeps the second item's comment", () => {
  const text =
    "blocks:\n  check:\n    config:\n      reviewers:\n        - old\n        - kept # retained\n";
  const p = open(text);
  p.config.set({
    path: "check.reviewers",
    value: ["kept", "kept"],
    expectRevision: p.config.show().revision,
  });
  expect(p.read()).toBe(text.replace("- old", "- kept"));
});

for (const nl of ["\n", "\r\n"]) {
  test(`comments and quotes survive a value edit (${JSON.stringify(nl)})`, () => {
    const text = [
      "# header",
      "blocks:",
      "  git:",
      "    source: { builtin: forge/git }",
      "    config:",
      "      # standalone",
      "      base: 'main' # inline",
      "      sign: false",
      "      # trailing map",
      "",
      "# end",
      "",
    ].join(nl);
    const p = open(text);
    const warnings: string[] = [];
    const config = createConfig({ ...p.env, warn: (m) => warnings.push(m) });
    config.set({
      path: "git.base",
      value: "develop",
      expectRevision: config.show().revision,
    });
    expect(p.read()).toBe(
      text
        .replace("'main'", "'develop'")
        .replace(`${nl}# end`, `${nl}      # end`),
    );
    expect(warnings).toEqual([
      ".forge/config.yaml: formatting could not be preserved",
    ]);
  });
  test(`removing an inline-commented pair keeps other lines (${JSON.stringify(nl)})`, () => {
    const text = [
      "# header",
      "blocks:",
      "  git:",
      "    base: 'main'",
      "  check: # checks go last",
      "",
    ].join(nl);
    const p = open(text);
    const warnings: string[] = [];
    const config = createConfig({ ...p.env, warn: (m) => warnings.push(m) });
    config.apply({
      patch: [{ op: "remove", path: "/blocks/check" }],
      expectRevision: config.show().revision,
    });
    expect(p.read()).toBe(text.replace(`  check: # checks go last${nl}`, ""));
    expect(warnings).toEqual([]);
  });
}
test("a package source edit keeps the version and becomes explicit", () => {
  const p = open('# header\nblocks:\n  demo:\n    use: "@team/demo"\n');
  const source = { package: "@team/demo", version: "1.2.3" };
  p.config.set({
    path: "/blocks/demo/source",
    value: source,
    expectRevision: p.config.show().revision,
  });
  expect(p.config.show().instances[0]?.source).toEqual(source);
  expect(p.read()).toContain("version: 1.2.3");
  expect(p.read()).not.toContain("use:");
  expect(p.read()).toStartWith("# header\n");
});
for (const [text, name, source] of [
  ["blocks: {}\n", "demo", { path: "blocks/demo" }],
  ["blocks:\n  check: # bare\n", "check", { builtin: "forge/check" }],
] as const) {
  test(`template source on ${name} is explicit, unedited and removable`, () => {
    const p = open(text);
    p.installed.set("team/demo", {
      schemaVersion: "forge.template/1",
      id: "team/demo",
      version: "1.0.0",
      summary: "Demo",
      config: {
        schemaVersion: "forge.config/1",
        blocks: { [name]: { source } },
      },
    });
    const imported = p.templates.importTemplate({
      template: "team/demo",
      expectRevision: p.config.show().revision,
    });
    expect(p.read()).toContain("source:");
    expect(p.read()).not.toContain("schemaVersion:");
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
}
for (const text of ["# only a comment\n", "# hand-written\nblocks: {}\n"]) {
  test("saving an empty handwritten file is a byte-exact no-op", () => {
    const p = open(text);
    p.config.save({ expectRevision: p.config.show().revision });
    expect(p.read()).toBe(text);
  });
}
for (const writer of ["set", "apply", "remove", "save", "template"] as const) {
  test(`${writer} keeps untouched short nodes and writes changed paths explicitly`, () => {
    const p = open(
      "# header\nblocks:\n  git:\n    base: 'main' # choice\n  check:\n    commands:\n      lint: 'make lint' # lint\n      test: 'make test' # test\n",
    );
    const expectRevision = p.config.show().revision;
    if (writer === "set")
      p.config.set({ path: "git.base", value: "develop", expectRevision });
    if (writer === "apply")
      p.config.apply({
        patch: [{ op: "set", path: "check.commands.lint", value: "new lint" }],
        expectRevision,
      });
    if (writer === "remove")
      p.config.apply({
        patch: [{ op: "remove", path: "check.commands.lint" }],
        expectRevision,
      });
    if (writer === "save") p.config.save({ expectRevision });
    if (writer === "template")
      p.templates.importTemplate({ template: "forge/starter", expectRevision });
    expect(p.config.show().valid).toBe(true);
    expect(p.read()).toContain("# header\n");
    expect(p.read()).toContain("test: 'make test' # test");
    expect(p.read()).toContain(
      "base: '" + (writer === "set" ? "develop" : "main") + "' # choice",
    );
  });
}
