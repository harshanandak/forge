#!/usr/bin/env node
/**
 * Migration script: node:test + node:assert/strict → bun:test (CJS style)
 *
 * Strategy:
 * - Use require('bun:test') to stay CJS-compatible (all other requires stay as-is)
 * - Convert assert.* calls to expect() style
 * - Handle multiline assert calls by processing the full file as text with careful regex
 */

const fs = require('node:fs');
const path = require('node:path');

const TEST_DIRS = [
  'test',
  'test/cli',
  'test/commands',
  'test/e2e',
  'test/integration',
  'test/workflows',
];

const ROOT = path.join(__dirname, '..');

function getTestFiles() {
  const files = [];
  for (const dir of TEST_DIRS) {
    const fullDir = path.join(ROOT, dir);
    if (!fs.existsSync(fullDir)) continue;
    const entries = fs.readdirSync(fullDir);
    for (const entry of entries) {
      if (entry.endsWith('.test.js')) {
        files.push(path.join(fullDir, entry));
      }
    }
  }
  return files;
}

/**
 * Find the closing paren index, accounting for nested parens/brackets/braces/strings
 */
function findMatchingParen(str, startIdx) {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let i = startIdx;

  while (i < str.length) {
    const ch = str[i];
    const prev = i > 0 ? str[i - 1] : '';

    if (inString) {
      if (ch === stringChar && prev !== '\\') {
        inString = false;
      } else if (ch === '\\') {
        i++; // skip next char
      }
    } else {
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        stringChar = ch;
      } else if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    i++;
  }
  return -1;
}

/**
 * Find top-level comma in args string (not inside parens/brackets/strings)
 */
function findTopLevelComma(str) {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const prev = i > 0 ? str[i - 1] : '';
    if (inString) {
      if (ch === stringChar && prev !== '\\') inString = false;
      else if (ch === '\\') i++;
    } else {
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        stringChar = ch;
      } else if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Process assert.* calls in content using bracket-aware parsing
 * Returns new content with all assert calls converted
 */
function convertAssertCalls(content) {
  // We'll process the content character by character, replacing assert.X(...) calls
  let result = '';
  let i = 0;

  while (i < content.length) {
    // Look for "assert."
    const assertIdx = content.indexOf('assert.', i);
    if (assertIdx === -1) {
      result += content.slice(i);
      break;
    }

    // Copy everything up to "assert."
    result += content.slice(i, assertIdx);
    i = assertIdx;

    // Determine which assert method
    const rest = content.slice(i + 'assert.'.length);

    let method = '';
    let j = 0;
    while (j < rest.length && /[a-zA-Z]/.test(rest[j])) {
      method += rest[j];
      j++;
    }

    // Check the character after the method name is '('
    if (rest[j] !== '(') {
      // Not a function call, copy and move on
      result += content.slice(i, i + 'assert.'.length + method.length);
      i += 'assert.'.length + method.length;
      continue;
    }

    // Find the matching closing paren for the call
    const openParenAbsolute = assertIdx + 'assert.'.length + method.length;
    const closeParenAbsolute = findMatchingParen(content, openParenAbsolute);

    if (closeParenAbsolute === -1) {
      // Can't find closing paren, copy as-is
      result += content.slice(i, openParenAbsolute + 1);
      i = openParenAbsolute + 1;
      continue;
    }

    // Extract the args string (everything between the outer parens)
    const argsStr = content.slice(openParenAbsolute + 1, closeParenAbsolute);

    // Convert based on method
    let converted = null;

    switch (method) {
      case 'ok': {
        // assert.ok(expr) or assert.ok(expr, 'msg')
        const commaIdx = findTopLevelComma(argsStr);
        const expr = commaIdx !== -1 ? argsStr.slice(0, commaIdx).trim() : argsStr.trim();
        converted = `expect(${expr}).toBeTruthy()`;
        break;
      }
      case 'strictEqual': {
        // assert.strictEqual(a, b) or assert.strictEqual(a, b, 'msg')
        const c1 = findTopLevelComma(argsStr);
        if (c1 === -1) { converted = null; break; }
        const a = argsStr.slice(0, c1).trim();
        const rest2 = argsStr.slice(c1 + 1);
        const c2 = findTopLevelComma(rest2);
        const b = c2 !== -1 ? rest2.slice(0, c2).trim() : rest2.trim();
        converted = `expect(${a}).toBe(${b})`;
        break;
      }
      case 'notStrictEqual': {
        const c1 = findTopLevelComma(argsStr);
        if (c1 === -1) { converted = null; break; }
        const a = argsStr.slice(0, c1).trim();
        const rest2 = argsStr.slice(c1 + 1);
        const c2 = findTopLevelComma(rest2);
        const b = c2 !== -1 ? rest2.slice(0, c2).trim() : rest2.trim();
        converted = `expect(${a}).not.toBe(${b})`;
        break;
      }
      case 'deepStrictEqual': {
        const c1 = findTopLevelComma(argsStr);
        if (c1 === -1) { converted = null; break; }
        const a = argsStr.slice(0, c1).trim();
        const rest2 = argsStr.slice(c1 + 1);
        const c2 = findTopLevelComma(rest2);
        const b = c2 !== -1 ? rest2.slice(0, c2).trim() : rest2.trim();
        converted = `expect(${a}).toEqual(${b})`;
        break;
      }
      case 'equal': {
        const c1 = findTopLevelComma(argsStr);
        if (c1 === -1) { converted = null; break; }
        const a = argsStr.slice(0, c1).trim();
        const rest2 = argsStr.slice(c1 + 1);
        const c2 = findTopLevelComma(rest2);
        const b = c2 !== -1 ? rest2.slice(0, c2).trim() : rest2.trim();
        converted = `expect(${a}).toBe(${b})`;
        break;
      }
      case 'notEqual': {
        const c1 = findTopLevelComma(argsStr);
        if (c1 === -1) { converted = null; break; }
        const a = argsStr.slice(0, c1).trim();
        const rest2 = argsStr.slice(c1 + 1);
        const c2 = findTopLevelComma(rest2);
        const b = c2 !== -1 ? rest2.slice(0, c2).trim() : rest2.trim();
        converted = `expect(${a}).not.toBe(${b})`;
        break;
      }
      case 'fail': {
        // assert.fail(msg) → throw new Error(msg)
        converted = `throw new Error(${argsStr.trim()})`;
        break;
      }
      case 'throws': {
        // assert.throws(fn) or assert.throws(fn, options)
        const c1 = findTopLevelComma(argsStr);
        const fn = c1 !== -1 ? argsStr.slice(0, c1).trim() : argsStr.trim();
        converted = `expect(${fn}).toThrow()`;
        break;
      }
      case 'doesNotThrow': {
        // assert.doesNotThrow(fn) or assert.doesNotThrow(fn, 'msg')
        const c1 = findTopLevelComma(argsStr);
        const fn = c1 !== -1 ? argsStr.slice(0, c1).trim() : argsStr.trim();
        converted = `expect(${fn}).not.toThrow()`;
        break;
      }
      case 'doesNotReject': {
        // await assert.doesNotReject(asyncFn) → await expect(asyncFn()).resolves.not.toThrow()
        // We handle this by making expect(asyncFn).resolves.not.toThrow()
        // Check if there's an 'await' before this call
        const c1 = findTopLevelComma(argsStr);
        const fn = c1 !== -1 ? argsStr.slice(0, c1).trim() : argsStr.trim();
        // The fn is an async function expression, call it: fn()
        // But we'll wrap it: expect(fn).resolves.not.toThrow()
        converted = `expect(${fn}).resolves.not.toThrow()`;
        break;
      }
      case 'match': {
        // assert.match(str, regex) → expect(str).toMatch(regex)
        const c1 = findTopLevelComma(argsStr);
        if (c1 === -1) { converted = null; break; }
        const str = argsStr.slice(0, c1).trim();
        const rest2 = argsStr.slice(c1 + 1).trim();
        // rest2 may have trailing message, but regex is the main arg
        const c2 = findTopLevelComma(rest2);
        const regex = c2 !== -1 ? rest2.slice(0, c2).trim() : rest2.trim();
        converted = `expect(${str}).toMatch(${regex})`;
        break;
      }
      default:
        converted = null;
    }

    if (converted !== null) {
      result += converted;
    } else {
      // Couldn't convert, copy as-is
      result += content.slice(i, closeParenAbsolute + 1);
    }

    i = closeParenAbsolute + 1;
  }

  return result;
}

function migrateFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');

  // Skip if already using bun:test
  if (content.includes("'bun:test'") || content.includes('"bun:test"')) {
    return { skipped: true, reason: 'already using bun:test' };
  }

  // Skip if not using node:test
  if (!content.includes("'node:test'") && !content.includes('"node:test"')) {
    return { skipped: true, reason: 'does not use node:test' };
  }

  const original = content;

  // ---- Step 1: Extract which symbols are imported from node:test ----
  const nodeTestImportMatch = content.match(
    /const\s*\{([^}]+)\}\s*=\s*require\(['"]node:test['"]\)/
  );

  let importedSymbols = [];
  if (nodeTestImportMatch) {
    importedSymbols = nodeTestImportMatch[1]
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  // ---- Step 2: Map node:test symbols to bun:test equivalents ----
  const symbolMap = {
    'describe': 'describe',
    'test': 'test',
    'it': 'it',
    'before': 'beforeAll',
    'after': 'afterAll',
    'beforeEach': 'beforeEach',
    'afterEach': 'afterEach',
  };

  // Build the bun:test symbols list
  // Handle aliased imports like "after: _after"
  const bunSymbols = [];
  for (const sym of importedSymbols) {
    if (sym.includes(':')) {
      // e.g. "after: _after"
      const [origName, alias] = sym.split(':').map(s => s.trim());
      const bunEquiv = symbolMap[origName] || origName;
      bunSymbols.push(`${bunEquiv}: ${alias}`);
    } else {
      const bunEquiv = symbolMap[sym] || sym;
      if (bunEquiv !== sym) {
        // e.g. before → beforeAll: we need the body to still call `before()`,
        // so we alias: beforeAll: before  -- wait, no.
        // The body uses "before()" which came from the import.
        // So if we imported "before" as "before" but now want "beforeAll",
        // we need to rename the usage in the body too, OR import as:
        // const { beforeAll: before } = require('bun:test')
        // That way the body code is unchanged.
        bunSymbols.push(`${bunEquiv}: ${sym}`);
      } else {
        bunSymbols.push(sym);
      }
    }
  }

  // Add expect if assert is used
  const hasAssert = content.includes('assert.');
  if (hasAssert && !bunSymbols.includes('expect')) {
    bunSymbols.push('expect');
  }

  // ---- Step 3: Replace the node:test require line ----
  const bunRequire = `const { ${bunSymbols.join(', ')} } = require('bun:test');`;
  content = content.replace(
    /const\s*\{[^}]+\}\s*=\s*require\(['"]node:test['"]\)\s*;?/,
    bunRequire
  );

  // ---- Step 4: Remove node:assert/strict require line ----
  content = content.replace(
    /\nconst\s+assert\s*=\s*require\(['"]node:assert\/strict['"]\)\s*;?/g,
    ''
  );
  content = content.replace(
    /\nconst\s+assert\s*=\s*require\(['"]node:assert['"]\)\s*;?/g,
    ''
  );

  // ---- Step 5: Convert assert.* calls ----
  if (hasAssert) {
    content = convertAssertCalls(content);
  }

  // ---- Step 6: Clean up extra blank lines ----
  content = content.replace(/\n{3,}/g, '\n\n');

  if (content === original) {
    return { skipped: true, reason: 'no changes made' };
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return { migrated: true };
}

// ---- Main ----
const files = getTestFiles();
console.log(`Found ${files.length} test files to check\n`);

let migrated = 0;
let skipped = 0;
const errors = [];

for (const file of files) {
  const rel = path.relative(ROOT, file);
  try {
    const result = migrateFile(file);
    if (result.migrated) {
      console.log(`✓ Migrated: ${rel}`);
      migrated++;
    } else {
      console.log(`  Skipped:  ${rel} (${result.reason})`);
      skipped++;
    }
  } catch (err) {
    console.error(`✗ Error:   ${rel}: ${err.message}`);
    errors.push({ file: rel, error: err.message });
  }
}

console.log(`\n--- Summary ---`);
console.log(`Migrated: ${migrated}`);
console.log(`Skipped:  ${skipped}`);
console.log(`Errors:   ${errors.length}`);
if (errors.length > 0) {
  for (const e of errors) {
    console.error(`  ✗ ${e.file}: ${e.error}`);
  }
  process.exit(1);
}
