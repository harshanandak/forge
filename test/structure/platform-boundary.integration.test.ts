import { expect, test } from "bun:test";
import {
  findPlatformViolations,
  isPureFile,
  maskSource,
  NODE_MODULES,
} from "./lib/platform.ts";
import { format, listRepoFiles, readRepoFiles } from "./lib/repo.ts";

test("core, contract and ports import no platform module and read no ambient process state", () => {
  const files = readRepoFiles(listRepoFiles().filter(isPureFile));
  expect(format(findPlatformViolations(files))).toEqual([]);
}, 30_000);

const planted = (text: string, path = "src/core/catalog/capture.ts") => [
  { path, text },
];

const denied: readonly (readonly [string, string])[] = [
  ["static import", 'import { readFileSync } from "fs";\n'],
  ["node: prefix", 'import { join } from "node:path";\n'],
  ["fs/promises", 'import { readFile } from "fs/promises";\n'],
  ["node:fs/promises", 'import * as fs from "node:fs/promises";\n'],
  ["side-effect import", 'import "node:os";\n'],
  ["re-export", 'export { spawn } from "node:child_process";\n'],
  ["type-only import", 'import type { Stats } from "node:fs";\n'],
  [
    "multi-line import",
    'import {\n  hostname,\n  tmpdir,\n} from "node:os";\n',
  ],
  ["dynamic import", 'const fs = await import("node:fs");\n'],
  ["dynamic import with options", 'await import("node:net", { with: {} });\n'],
  ["require", 'const { cwd } = require("process");\n'],
  ["computed dynamic import", "await import(name);\n"],
  ["bun:sqlite", 'import { Database } from "bun:sqlite";\n'],
  ["bun:test in shipped code", 'import { test } from "bun:test";\n'],
  ["the bun module", 'import { file } from "bun";\n'],
  ["url file helper", 'import { fileURLToPath } from "node:url";\n'],
  ["worker_threads", 'import { Worker } from "node:worker_threads";\n'],
  ["http", 'import http from "http";\n'],
  ["https", 'import https from "node:https";\n'],
  ["net", 'import { connect } from "net";\n'],
  ["process as a module", 'import process from "node:process";\n'],
  ["an unlisted built-in", 'import { gzipSync } from "node:zlib";\n'],
  ["process.cwd()", "const here = process.cwd();\n"],
  ["process.env", "const home = process.env.HOME;\n"],
  ["optional process.env", "const home = process?.env?.HOME;\n"],
  ["process.env inside a template", "const s = `${process.env.HOME}/x`;\n"],
  ["getBuiltinModule", 'process.getBuiltinModule("fs");\n'],
  ["Bun global", 'const text = await Bun.file("a").text();\n'],
];

for (const [name, text] of denied) {
  test(`the guard rejects ${name} in core`, () => {
    expect(findPlatformViolations(planted(text))).not.toEqual([]);
  }, 30_000);
}

test("the guard covers core, contract and ports alike", () => {
  const text = 'import { readFileSync } from "node:fs";\n';
  for (const path of [
    "src/core/config/files.ts",
    "src/contract/a.ts",
    "src/ports/b.ts",
  ]) {
    expect(
      findPlatformViolations(planted(text, path)).map((v) => v.file),
    ).toEqual([path]);
  }
}, 30_000);

test("a violation names the rule, file, line and the port to use", () => {
  const [violation] = findPlatformViolations(
    planted('const a = 1;\nimport { join } from "node:path";\n'),
  );
  expect(format(violation ? [violation] : [])[0]).toContain(
    "[platform-boundary] src/core/catalog/capture.ts:2",
  );
  expect(violation?.message).toContain("src/ports");
}, 30_000);

const allowed: readonly (readonly [string, string])[] = [
  ["node:crypto hashing", 'import { createHash } from "node:crypto";\n'],
  ["crypto without a prefix", 'import { createHash } from "crypto";\n'],
  ["node:util", 'import { format, type InspectOptions } from "node:util";\n'],
  ["node:events", 'import { EventEmitter } from "node:events";\n'],
  ["node:buffer", 'import { Buffer } from "node:buffer";\n'],
  ["relative imports", 'import { x } from "./process.ts";\n'],
  [
    "a port type",
    'import type { ProcessResult } from "../ports/process.ts";\n',
  ],
  [
    "a local value named process",
    "function run(process: Runner) { return process.run(); }\n",
  ],
  ["the global URL", 'const u = new URL("file:///a");\n'],
  ["other process members' names", "const processed = env.cwd;\n"],
  [
    "a denied name in a comment",
    '// import fs from "node:fs"; process.cwd()\n',
  ],
  [
    "a denied name in a block comment",
    '/* import fs from "node:fs";\n process.env */\nexport const a = 1;\n',
  ],
  ["a denied name in a string", 'const doc = "process.env and Bun.file";\n'],
  [
    "a denied name in template text",
    "const doc = `use process.cwd() or Bun.file`;\n",
  ],
  [
    "an apostrophe inside a template",
    "const s = `it's ${1 + 1} ok`;\nexport const b = 1;\n",
  ],
];

for (const [name, text] of allowed) {
  test(`the guard allows ${name} in core`, () => {
    expect(format(findPlatformViolations(planted(text)))).toEqual([]);
  }, 30_000);
}

test("the guard reads code after an apostrophe in template text", () => {
  const text = "const s = `it's ${1} done`;\nconst home = process.env.HOME;\n";
  expect(findPlatformViolations(planted(text)).map((v) => v.line)).toEqual([2]);
}, 30_000);

test("the guard leaves adapters, tests, tools and blocks alone", () => {
  const text =
    'import { readFileSync } from "node:fs";\nimport { Database } from "bun:sqlite";\nconst here = process.cwd();\n';
  for (const path of [
    "src/adapters/state-fs/a.ts",
    "src/blocks/project/a.ts",
    "src/assembly/a.ts",
    "bin/forge.ts",
    "test/core/a.test.ts",
    "test/structure/a.ts",
    "tools/a.ts",
    "src/core/catalog/capture.test.ts",
  ]) {
    expect(findPlatformViolations(planted(text, path))).toEqual([]);
  }
}, 30_000);

test("every table entry gives a reason and the denied core modules are listed", () => {
  for (const [name, rule] of NODE_MODULES) {
    expect(rule.reason.length, name).toBeGreaterThan(0);
  }
  for (const name of [
    "fs",
    "path",
    "os",
    "child_process",
    "worker_threads",
    "net",
    "http",
    "https",
    "process",
    "url",
  ]) {
    expect(NODE_MODULES.get(name)?.allowed, name).toBe(false);
  }
}, 30_000);

test("masking keeps line numbers and blanks only comments and string contents", () => {
  const text = 'a /* x\ny */ "p" // c\n`t${b}`';
  expect(maskSource(text, false).split("\n")).toHaveLength(3);
  expect(maskSource(text, false)).toContain('"p"');
  expect(maskSource(text, true)).not.toContain("p");
  expect(maskSource(text, true)).toContain("${b}");
}, 30_000);
