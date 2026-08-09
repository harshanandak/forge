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

function importsIn(source) {
  const imports = [];
  const pattern = /(?:require\s*\(|import\s*\()\s*["']([^"']+)["']|(?:import|export)\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1] || match[2]);
  return imports;
}

function isStringLiteral(expression) {
  const quote = expression[0];
  if (quote !== "\"" && quote !== "'") return false;
  for (let index = 1; index < expression.length; index += 1) {
    if (expression[index] === "\\") {
      index += 1;
      continue;
    }
    if (expression[index] === quote) {
      return expression.slice(index + 1).trim().length === 0;
    }
  }
  return false;
}

function dynamicImportsIn(source) {
  const dynamic = [];
  const pattern = /\b(?:require|import)\s*\(([^)\r\n]*)\)/g;
  for (const match of source.matchAll(pattern)) {
    const expression = match[1].trim();
    if (!isStringLiteral(expression)) dynamic.push(expression || "<empty>");
  }
  return dynamic;
}

describe("product package boundaries", () => {
  test.each([
    ["require variable", "require(privateModule)"],
    ["concatenated require", "require('@forge/memory-contracts/' + privatePath)"],
    ["template dynamic import", "import(`@forge/${product}/private`)"],
  ])("rejects a computed module specifier: %s", (_label, source) => {
    expect(dynamicImportsIn(source)).not.toEqual([]);
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
