"use strict";

const { describe, expect, test } = require("bun:test");
const { parse } = require("@babel/parser");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
// Forge's building blocks are internal modules of the one forge package. Each
// block owns its directory; another block (or any other Forge code) reaches it
// only through its public entry (the block directory or its index.js), never
// its internals.
const BLOCKS = {
  contracts: path.join(ROOT, "lib", "contracts"),
  memory: path.join(ROOT, "lib", "memory-core"),
  flow: path.join(ROOT, "lib", "flow"),
};
const ALLOWED_BLOCK_IMPORTS = {
  contracts: new Set(),
  memory: new Set(["contracts"]),
  flow: new Set(["contracts"]),
};
const CONSUMER_ROOTS = ["lib", "bin", "scripts"].map((directory) => path.join(ROOT, directory));

function isInside(file, directory) {
  return file === directory || file.startsWith(`${directory}${path.sep}`);
}

function blockOf(file) {
  return Object.keys(BLOCKS).find((name) => isInside(file, BLOCKS[name])) || null;
}

function isBlockEntry(resolved, name) {
  return [BLOCKS[name], path.join(BLOCKS[name], "index"), path.join(BLOCKS[name], "index.js")].includes(resolved);
}

function javascriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return ["test", "node_modules"].includes(entry.name) ? [] : javascriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js") ? [absolute] : [];
  });
}

function skipTrivia(source, start) {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
    } else if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
    } else if (source.startsWith("//", cursor)) {
      const end = source.indexOf("\n", cursor + 2);
      cursor = end === -1 ? source.length : end + 1;
    } else {
      break;
    }
  }
  return cursor;
}

function readPlainString(source, start) {
  const quote = source[start];
  if (quote !== "\"" && quote !== "'") return null;
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") return null;
    if (source[cursor] === quote) {
      return { value: source.slice(start + 1, cursor), end: cursor + 1 };
    }
  }
  return null;
}

function moduleCallsIn(source) {
  const calls = [];
  for (const match of source.matchAll(/\b(?:require|import)\b/g)) {
    let cursor = skipTrivia(source, match.index + match[0].length);
    if (source[cursor] !== "(") continue;
    cursor = skipTrivia(source, cursor + 1);
    const literal = readPlainString(source, cursor);
    if (literal && source[skipTrivia(source, literal.end)] === ")") {
      calls.push({ specifier: literal.value });
      continue;
    }
    const end = source.indexOf(")", cursor);
    const expression = source.slice(cursor, end === -1 ? source.length : end).trim();
    calls.push({ expression: expression || "<empty>" });
  }
  return calls;
}

function importsIn(source) {
  const imports = moduleCallsIn(source).flatMap((call) => call.specifier ? [call.specifier] : []);
  const ast = parse(source, { sourceType: "unambiguous" });
  for (const statement of ast.program.body) {
    if (["ImportDeclaration", "ExportAllDeclaration", "ExportNamedDeclaration"].includes(statement.type)
      && typeof statement.source?.value === "string") {
      imports.push(statement.source.value);
    }
  }
  return imports;
}

function dynamicImportsIn(source) {
  return moduleCallsIn(source).flatMap((call) => call.expression ? [call.expression] : []);
}

describe("product package boundaries", () => {
  test.each([
    ["require variable", "require(privateModule)"],
    ["concatenated require", "require('@forge/contracts/' + privatePath)"],
    ["template dynamic import", "import(`@forge/${product}/private`)"],
    ["multiline require variable", "require(\n  privateModule\n)"],
    ["multiline template import", "import(\n  `@forge/${product}/private`\n)"],
  ])("rejects a computed module specifier: %s", (_label, source) => {
    expect(dynamicImportsIn(source)).not.toEqual([]);
  });

  test("inspects a literal require separated from its call by a comment", () => {
    expect(importsIn("require /* package boundary */ ('@forge/memory/private')"))
      .toContain("@forge/memory/private");
  });

  test("inspects a static import separated from its value by a comment", () => {
    expect(importsIn("import/* package boundary */value from '@forge/memory/private';"))
      .toContain("@forge/memory/private");
  });

  for (const blockName of Object.keys(BLOCKS)) {
    test(`${blockName} imports only its own files and the public entry of allowed blocks`, () => {
      const blockRoot = BLOCKS[blockName];
      const files = javascriptFiles(blockRoot);
      expect(files.length).toBeGreaterThan(0);
      const violations = [];
      for (const file of files) {
        const source = fs.readFileSync(file, "utf8");
        for (const expression of dynamicImportsIn(source)) {
          violations.push(`${path.relative(ROOT, file)} -> dynamic module specifier: ${expression}`);
        }
        for (const specifier of importsIn(source)) {
          if (specifier.startsWith("@forge/")) {
            violations.push(`${path.relative(ROOT, file)} -> ${specifier}`);
            continue;
          }
          if (!specifier.startsWith(".")) continue;
          const resolved = path.resolve(path.dirname(file), specifier);
          if (isInside(resolved, blockRoot)) continue;
          const allowed = [...ALLOWED_BLOCK_IMPORTS[blockName]].some((name) => isBlockEntry(resolved, name));
          if (!allowed) violations.push(`${path.relative(ROOT, file)} -> ${specifier}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }

  test("Forge code outside the blocks reaches them only through their public entries", () => {
    const violations = [];
    for (const file of CONSUMER_ROOTS.flatMap(javascriptFiles)) {
      if (blockOf(file)) continue;
      for (const specifier of importsIn(fs.readFileSync(file, "utf8"))) {
        if (/^@forge\/(contracts|flow|memory)(\/|$)/.test(specifier)) {
          violations.push(`${path.relative(ROOT, file)} -> ${specifier}`);
          continue;
        }
        if (!specifier.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        const target = blockOf(resolved);
        if (target && !isBlockEntry(resolved, target)) violations.push(`${path.relative(ROOT, file)} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("the block rule rejects a sibling block's internals and allows its entry", () => {
    const memoryFile = path.join(BLOCKS.memory, "src", "probe.js");
    const internal = path.resolve(path.dirname(memoryFile), "../../flow/src/executor.js");
    expect(blockOf(internal)).toBe("flow");
    expect(isBlockEntry(internal, "flow")).toBe(false);
    expect(isBlockEntry(path.resolve(path.dirname(memoryFile), "../../contracts"), "contracts")).toBe(true);
    expect(ALLOWED_BLOCK_IMPORTS.memory.has("flow")).toBe(false);
    expect(ALLOWED_BLOCK_IMPORTS.flow.has("memory")).toBe(false);
  });
});
