import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  addedComments,
  checkComments,
} from "../../tools/checks/no-comments.ts";

const lines = new Set([1, 2, 3, 4, 5]);
for (const [name, source, kind, line] of [
  ["line", "const x = 1; // why\n", "line comment", 1],
  ["block", "const x = 1; /* why */\n", "block comment", 1],
  ["JSDoc", "/** why\n * constraint\n */\nconst x = 1;\n", "JSDoc", 1],
  ["template expression", "const x = `${1 /* why */}`;", "block comment", 1],
  ["JSX expression", "const x = <p>{1 /* why */}</p>;", "block comment", 1],
  ["test file", "test('works', () => {}); // why", "line comment", 1],
  ["bare CR", "const x = 1;\r// why", "line comment", 1],
  [
    "Unicode separator",
    `const x = "${String.fromCharCode(0x2028)}"; // why`,
    "line comment",
    1,
  ],
] as const) {
  test(`new ${name} comment is refused with file and line`, () => {
    const file = name === "test file" ? "test/x.test.ts" : "src/x.tsx";
    expect(addedComments(file, source, lines)).toEqual([{ file, line, kind }]);
  }, 30_000);
}

for (const [name, source] of [
  ["double-quoted string", 'const x = "https://host/*path*/";'],
  ["single-quoted string", "const x = '// /* */';"],
  ["regex character class", "const x = /[/*]+/;"],
  ["escaped regex slash", "const x = /https:\\/\\/host/;"],
  ["template text", "const x = `// /* */ ${1} // /* */`;"],
  ["nested template text", "const x = `${`// ${1} /* */`}`;"],
  ["JSX text", "const x = <p>// /* */</p>;"],
  ["JSX attribute", 'const x = <p title="// /* */" />;'],
  ["eslint-disable", "/* eslint-disable */\nconst x = 1;"],
  ["eslint-disable-line", "const x = 1; // eslint-disable-line no-unused-vars"],
  [
    "eslint-disable-next-line",
    "// eslint-disable-next-line no-unused-vars -- reason\nconst x = 1;",
  ],
  ["eslint-enable", "/* eslint-enable no-unused-vars */\nconst x = 1;"],
  [
    "multiline eslint directive",
    "/* eslint-disable\n no-unused-vars,\n no-console\n */\nconst x = 1;",
  ],
  [
    "ts-expect-error",
    "// @ts-expect-error: intentional test\nconst x: number = '';",
  ],
  [
    "block ts-expect-error",
    "/* @ts-expect-error intentional test */\nconst x: number = '';",
  ],
  [
    "biome-ignore",
    "// biome-ignore lint/suspicious/noExplicitAny: required\nconst x = 1;",
  ],
  ["shebang", "#!/usr/bin/env node\nconst x = 1;"],
  ["reference path", '/// <reference path="./x.ts" />\nconst x = 1;'],
  [
    "reference types",
    '/// <reference types="node" resolution-mode="require" />\nconst x = 1;',
  ],
  ["reference lib", '/// <reference lib="es2024" />\nconst x = 1;'],
  [
    "reference no-default-lib",
    '/// <reference no-default-lib="true" />\nconst x = 1;',
  ],
] as const) {
  test(`${name} passes the comment check`, () => {
    expect(addedComments("src/x.tsx", source, lines)).toEqual([]);
  }, 30_000);
}

for (const source of [
  "// licence copyright\nconst x = 1;",
  "// @ts-ignore\nconst x = 1;",
  "/* explanation\n eslint-disable\n */\nconst x = 1;",
  "/* eslint-disable\n ordinary prose\n */\nconst x = 1;",
  "// eslint-disable-next-line-not-a-directive\nconst x = 1;",
  '/// <reference types="node" /> prose\nconst x = 1;',
]) {
  test(`directive lookalikes and prose are refused: ${JSON.stringify(source)}`, () => {
    expect(addedComments("src/x.ts", source, lines)).toHaveLength(1);
  }, 30_000);
}

test("an existing comment outside added lines passes", () => {
  expect(
    addedComments("src/x.ts", "// existing\nconst x = 2;", new Set([2])),
  ).toEqual([]);
}, 30_000);
test("an added interior line of an existing block is refused", () => {
  expect(
    addedComments("src/x.ts", "/* existing\n changed\n */", new Set([2])),
  ).toEqual([{ file: "src/x.ts", line: 2, kind: "block comment" }]);
}, 30_000);

function repository(
  run: (
    root: string,
    git: (...args: string[]) => string,
    put: (file: string, text: string) => void,
  ) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "forge-comments-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: "pipe",
    }).trim();
  const put = (file: string, text: string): void => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    put("src/x.ts", "// existing\nexport const x = 1;\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("branch", "baseline");
    run(root, git, put);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const [name, file, text, expected] of [
  ["new source", "src/new.ts", "// new\nexport {};\n", "FAIL"],
  ["test file", "test/x.test.ts", "// new\nexport {};\n", "FAIL"],
  [
    "edited comment-bearing line",
    "src/x.ts",
    "// existing edited\nexport const x = 1;\n",
    "FAIL",
  ],
  [
    "moved comment line",
    "src/x.ts",
    "export const x = 1;\n// existing\n",
    "FAIL",
  ],
  [
    "untouched baseline comment",
    "src/x.ts",
    "// existing\nexport const x = 2;\n",
    "PASS",
  ],
  ["deleted comment", "src/x.ts", "export const x = 1;\n", "PASS"],
  ["non-code file", "README.md", "// ordinary prose\n", "PASS"],
  ["unparseable syntax", "src/new.ts", "export const = ;\n", "INCOMPLETE"],
] as const) {
  test(
    `committed diff handles ${name}`,
    () =>
      repository((root, git, put) => {
        put(file, text);
        git("add", ".");
        git("commit", "-qm", "head");
        expect(checkComments({ root, base: "baseline" }).status).toBe(expected);
      }),
    30_000,
  );
}

for (const file of ["src/renamed.ts", "docs/renamed.txt"]) {
  test(
    `pure rename to ${file} adds no comments`,
    () =>
      repository((root, git) => {
        mkdirSync(join(root, "docs"), { recursive: true });
        git("mv", "src/x.ts", file);
        git("commit", "-qm", "rename");
        expect(checkComments({ root, base: "baseline" }).status).toBe("PASS");
      }),
    30_000,
  );
}
test(
  "a rename entering the configured scope refuses its comments",
  () =>
    repository((root, git, put) => {
      put("docs/source.txt", "// inherited\nexport {};\n");
      git("add", ".");
      git("commit", "-qm", "outside scope");
      git("branch", "outside");
      git("mv", "docs/source.txt", "src/new.ts");
      git("commit", "-qm", "enter scope");
      expect(
        checkComments({ root, base: "outside", roots: ["src"] }).status,
      ).toBe("FAIL");
    }),
  30_000,
);
test(
  "a missing base is incomplete",
  () =>
    repository((root) => {
      expect(checkComments({ root, base: "missing-base" }).status).toBe(
        "INCOMPLETE",
      );
    }),
  30_000,
);
test("a failed git read is incomplete", () => {
  expect(checkComments({ root: tmpdir(), base: "HEAD" }).status).toBe(
    "INCOMPLETE",
  );
}, 30_000);

for (const attribute of ["", "*.ts binary\n"]) {
  test(
    `edited code must drop its inline comment with attributes ${JSON.stringify(attribute)}`,
    () =>
      repository((root, git, put) => {
        put("src/x.ts", "export const x = 1; // existing\n");
        put(".gitattributes", attribute);
        git("add", ".");
        git("commit", "-qm", "inline baseline");
        git("branch", "inline");
        put("src/x.ts", "export const x = 2; // existing\n");
        git("add", ".");
        git("commit", "-qm", "edited code");
        expect(checkComments({ root, base: "inline" }).violations).toEqual([
          { file: "src/x.ts", line: 1, kind: "line comment" },
        ]);
      }),
    30_000,
  );
}
for (const extension of [
  "ts",
  "cts",
  "mts",
  "js",
  "cjs",
  "mjs",
  "tsx",
  "jsx",
]) {
  test(`${extension} source comments are recognized`, () => {
    const file = `src/x.${extension}`;
    expect(addedComments(file, "const x = 1; // why", new Set([1]))).toEqual([
      { file, line: 1, kind: "line comment" },
    ]);
  }, 30_000);
}
