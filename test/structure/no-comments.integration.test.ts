import { beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  checkComments,
  type CommentCheckResult,
} from "../../tools/checks/no-comments.ts";

const lines = new Set([1, 2, 3, 4, 5]);
const samples: { file: string; text: string; added: ReadonlySet<number> }[] =
  [];
let observed: CommentCheckResult;
function sourceRow(
  name: string,
  file: string,
  text: string,
  added: ReadonlySet<number>,
  expected: readonly { line: number; kind: string }[],
): void {
  const path = `rows/${samples.length}/${file}`;
  samples.push({ file: path, text, added });
  test(
    name,
    () => {
      expect(observed.status, observed.reason).toBe("FAIL");
      expect(observed.violations.filter((item) => item.file === path)).toEqual(
        expected.map((item) => ({ ...item, file: path })),
      );
    },
    30_000,
  );
}
beforeAll(
  () =>
    repository((root, git, put) => {
      for (const item of samples) {
        let baseline = item.text
          .split("\n")
          .filter((_, index) => !item.added.has(index + 1))
          .join("\n");
        if (baseline && !baseline.endsWith("\n") && item.text.includes("\n"))
          baseline += "\n";
        put(item.file, baseline);
      }
      git("add", ".");
      git("commit", "-qm", "row baselines");
      git("branch", "rows-base");
      for (const item of samples) put(item.file, item.text);
      git("add", ".");
      git("commit", "-qm", "comment rows");
      observed = checkComments({ root, base: "rows-base" });
    }),
  120_000,
);
for (const [name, source, kind, line] of [
  ["line", "const x = 1; // why\n", "line comment", 1],
  ["block", "const x = 1; /* why */\n", "block comment", 1],
  ["JSDoc", "/** why\n * constraint\n */\nconst x = 1;\n", "JSDoc", 1],
  ["template expression", "const x = `${1 /* why */}`;", "block comment", 1],
  ["JSX expression", "const x = <p>{1 /* why */}</p>;", "block comment", 1],
  ["test file", "test('works', () => {}); // why", "line comment", 1],
  ["bare CR", "const x = 1;\r// why", "line comment", 1],
  ["BOM", "\uFEFFconst x = 1; // why", "line comment", 1],
  ["UTF-16 offset", 'const x = "😀"; // why', "line comment", 1],
  [
    "nested template expression",
    "const t = `outer // ${`inner /* ${1 /* actual */}`} */`;",
    "block comment",
    1,
  ],
  ["JSX child comment", "const x = <p>{/* actual */}</p>;", "block comment", 1],
  [
    "JSX attribute comment",
    'const x = <p /* actual */ title="/*" />;',
    "block comment",
    1,
  ],
  [
    "Unicode separator",
    `const x = "${String.fromCharCode(0x2028)}"; // why`,
    "line comment",
    1,
  ],
] as const) {
  sourceRow(
    `new ${name} comment is refused with file and line`,
    name === "test file" ? "test/x.test.ts" : "src/x.tsx",
    source,
    lines,
    [{ line, kind }],
  );
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
  [
    "ts-expect-error",
    "// @ts-expect-error: intentional test\nconst x: number = '';",
  ],
  [
    "block ts-expect-error",
    "/* @ts-expect-error intentional test */\nconst x: number = '';",
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
  sourceRow(`${name} passes the comment check`, "src/x.tsx", source, lines, []);
}

for (const source of [
  "// licence copyright\nconst x = 1;",
  "// @ts-ignore\nconst x = 1;",
  "/* eslint-disable */\nconst x = 1;",
  "const x = 1; // eslint-disable-line no-unused-vars",
  "// eslint-disable-next-line no-unused-vars -- reason\nconst x = 1;",
  "/* eslint-enable no-unused-vars */\nconst x = 1;",
  "/* eslint-disable\n no-unused-vars,\n no-console\n */\nconst x = 1;",
  "// biome-ignore lint/suspicious/noExplicitAny: required\nconst x = 1;",
  "/* oxlint-disable */\nconst x = 1;",
  "// bun-disable forge/no-comments\nconst x = 1;",
  "/* explanation\n eslint-disable\n */\nconst x = 1;",
  "/* eslint-disable\n ordinary prose\n */\nconst x = 1;",
  "// eslint-disable-next-line-not-a-directive\nconst x = 1;",
  '/// <reference types="node" /> prose\nconst x = 1;',
  '/*/ <reference types="node" />*/\nconst x = 1;',
]) {
  sourceRow(
    `directive lookalikes and prose are refused: ${JSON.stringify(source)}`,
    "src/x.ts",
    source,
    lines,
    [
      {
        line: 1,
        kind: source.startsWith("/*") ? "block comment" : "line comment",
      },
    ],
  );
}

for (const [name, source] of [
  ["regex after control parenthesis", "if (ok) /[/*]/.test(s);"],
  ["division after call", "f(ok) / a / b;"],
  ["regex after statement block", "{ work(); } /[/*]/.test(s);"],
  ["division after object expression", "const n = ({x: 1}) / a / b;"],
  ["regex after function declaration", "function f() {} /[/*]/.test(s);"],
  ["division after function expression", "const f = function() {} / a / b;"],
  ["division then regex operand", "const n = a / /[/*]/.exec(s)[0].length;"],
  ["division assignment", "let n = 4; n /= 2;"],
  ["division after postfix", "let n = 4; n++ / a / b;"],
  ["regex after return", "function f() { return /[/*]/; }"],
  ["regex after return newline", "function f() { return\n/[/*]/.test(s); }"],
  ["regex after throw", "function f() { throw /[/*]/; }"],
  ["relational expression beside division", "const n = a < b / c;"],
  ["TSX generic arrow beside JSX", "const f = <T,>(x: T) => <p>{x}</p>;"],
] as const) {
  sourceRow(`${name} passes`, "src/x.tsx", source, lines, []);
  const line = source.split("\n").length + 1;
  sourceRow(
    `${name} actual trailing comment is refused`,
    "src/x.tsx",
    source + "\n// actual",
    new Set([...lines, line]),
    [{ line, kind: "line comment" }],
  );
}
test("the comment check adds zero runtime dependencies", () => {
  const current = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { dependencies: Record<string, string> };
  expect(Object.keys(current.dependencies).sort()).toEqual([
    "@modelcontextprotocol/server",
    "koffi",
    "yaml",
  ]);
}, 30_000);
test("the repository enables forge/no-comments in Bun config", () => {
  const config = new URL("../../bunfig.toml", import.meta.url);
  expect(existsSync(config)).toBe(true);
  expect(readFileSync(config, "utf8")).toContain('"forge/no-comments"');
}, 30_000);

sourceRow(
  "an existing comment outside added lines passes",
  "src/x.ts",
  "// existing\nconst x = 2;",
  new Set([2]),
  [],
);
sourceRow(
  "an added interior line of an existing block is refused",
  "src/x.ts",
  "/* existing\n changed\n */",
  new Set([2]),
  [{ line: 2, kind: "block comment" }],
);

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
  sourceRow(
    `${extension} source comments are recognized`,
    `src/x.${extension}`,
    "const x = 1; // why",
    new Set([1]),
    [{ line: 1, kind: "line comment" }],
  );
}
test(
  "an unavailable lint executable is incomplete",
  () =>
    repository((root) => {
      expect(
        checkComments({
          root,
          base: "baseline",
          lintExecutable: join(root, "missing-bun"),
        }).status,
      ).toBe("INCOMPLETE");
    }),
  30_000,
);
test(
  "stable Bun without lint is incomplete",
  () =>
    repository((root) => {
      expect(
        checkComments({
          root,
          base: "baseline",
          lintExecutable: process.execPath,
        }).status,
      ).toBe("INCOMPLETE");
    }),
  30_000,
);
test(
  "inline disables cannot suppress the enforcing run",
  () =>
    repository((root, git, put) => {
      put(
        "src/x.ts",
        "/* eslint-disable forge/no-comments */\nexport const x = 1; // actual\n",
      );
      git("add", ".");
      git("commit", "-qm", "attempt disable");
      expect(checkComments({ root, base: "baseline" }).violations).toEqual([
        { file: "src/x.ts", line: 1, kind: "block comment" },
        { file: "src/x.ts", line: 2, kind: "line comment" },
      ]);
    }),
  30_000,
);
test(
  "uncommitted source cannot be mistaken for the checked head",
  () =>
    repository((root, git, put) => {
      put("src/x.ts", "export const x = 2;\n");
      git("add", ".");
      git("commit", "-qm", "checked head");
      put("src/x.ts", "export const x = 3; // uncommitted\n");
      expect(checkComments({ root, base: "baseline" }).status).toBe(
        "INCOMPLETE",
      );
    }),
  30_000,
);
