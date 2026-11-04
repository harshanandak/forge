import { expect, test } from "bun:test";
import { scopeOf } from "../../tools/ci/change-scope.ts";

test.each([
  "docs/architecture.md",
  "docs/reference/example.json",
  "AGENTS.md",
  "CODING_STANDARDS.md",
  "migrations/README.md",
  "src/blocks/example/README.md",
])(
  "documentation allowlist: %s",
  (path) => {
    expect(scopeOf([path])).toBe("docs");
  },
  1000,
);

test.each([
  "templates/delivery/skills/forge-build/SKILL.md",
  "tools/lane-brief.md",
  "test/project/fixtures/README.md",
  "README.md",
  "docs/writing-a-block.md",
  ".github/pull_request_template.md",
])(
  "H1: consumed Markdown requires full CI: %s",
  (path) => {
    expect(scopeOf([path])).toBe("full");
  },
  1000,
);

test("H3: an empty diff requires full CI", () => {
  expect(scopeOf([])).toBe("full");
  expect(scopeOf([""])).toBe("full");
}, 1000);

test.each([
  "LICENSE",
  "CREDITS",
  "unknown.md",
  "unknown/path",
  "src/index.ts",
  "src/blocks/README.md.ts",
  "tools/ci/change-scope.ts",
  "tools/ci/legs.ts",
  "tools/ci/test-shards.ts",
  "tools/ci/source-selection.ts",
  "tools/ci/node-sensitive.ts",
  "tools/ci/ci-record.ts",
  ".github/workflows/ci.yml",
  "test/timings.json",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  ".gitattributes",
  ".editorconfig",
  ".gitignore",
  ".forge/config.yaml",
  "bin/forge.ts",
  "schemas/example.json",
  "examples/hello-block/README.md",
  "migrations/example.md",
])(
  "unknown or shared paths require full CI: %s",
  (path) => {
    expect(scopeOf([path])).toBe("full");
    expect(scopeOf(["docs/architecture.md", path])).toBe("full");
  },
  1000,
);

test("a mixed change takes the widest scope regardless of order", () => {
  expect(scopeOf(["AGENTS.md", "src/index.ts"])).toBe("full");
  expect(scopeOf(["src/index.ts", "AGENTS.md"])).toBe("full");
}, 1000);
