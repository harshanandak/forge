"use strict";

const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const PACKAGES = ["memory-contracts", "memory", "flow"];
const ALLOWED_FORGE_IMPORTS = {
  "memory-contracts": new Set(),
  memory: new Set(["@forge/memory-contracts"]),
  flow: new Set(["@forge/memory-contracts"]),
};

function javascriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : javascriptFiles(absolute);
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
  const pattern = /(?:import|export)\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

function dynamicImportsIn(source) {
  return moduleCallsIn(source).flatMap((call) => call.expression ? [call.expression] : []);
}

describe("product package boundaries", () => {
  test.each([
    ["require variable", "require(privateModule)"],
    ["concatenated require", "require('@forge/memory-contracts/' + privatePath)"],
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

  for (const packageName of PACKAGES) {
    test(`${packageName} imports only its public allowed dependencies`, () => {
      const packageRoot = path.join(ROOT, "packages", packageName);
      const violations = [];
      for (const file of javascriptFiles(packageRoot)) {
        const source = fs.readFileSync(file, "utf8");
        for (const expression of dynamicImportsIn(source)) {
          violations.push(`${path.relative(ROOT, file)} -> dynamic module specifier: ${expression}`);
        }
        for (const specifier of importsIn(source)) {
          if (specifier.startsWith(".")) {
            const resolved = path.resolve(path.dirname(file), specifier);
            if (resolved !== packageRoot && !resolved.startsWith(`${packageRoot}${path.sep}`)) {
              violations.push(`${path.relative(ROOT, file)} -> ${specifier}`);
            }
          }
          if (specifier.startsWith("@forge/") && !ALLOWED_FORGE_IMPORTS[packageName].has(specifier)) {
            violations.push(`${path.relative(ROOT, file)} -> ${specifier}`);
          }
          if (/^@forge\/[^/]+\//.test(specifier)) {
            violations.push(`${path.relative(ROOT, file)} -> ${specifier}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
