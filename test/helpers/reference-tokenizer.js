// Test-only reference: the resource-syntax tokenizer exactly as it was on
// origin/master before the issue 6c09647c speedup (scripts/test-full-suite.js
// at 956c2b45). test/scripts/test-full-suite.test.js asserts the optimized
// tokenizer emits identical tokens to this one for every discovered test file,
// so the speedup cannot silently change resource-lane classification.
// Do not "fix" or optimize this file; it is the behavioral oracle.

function tokenizeResourceSyntax(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (current === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index === -1) break;
      continue;
    }
    if (current === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (current === '"' || current === "'") {
      const quote = current;
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\' && index + 1 < source.length) index += 1;
        value += source[index];
        index += 1;
      }
      index += 1;
      tokens.push({ type: 'string', value });
      continue;
    }
    if (current === '`') {
      let dynamic = false;
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '`') {
        if (source[index] === '\\' && index + 1 < source.length) {
          index += 1;
        } else if (source[index] === '$' && source[index + 1] === '{') {
          dynamic = true;
        }
        value += source[index];
        index += 1;
      }
      index += 1;
      tokens.push({ type: dynamic ? 'dynamic-string' : 'string', value });
      continue;
    }
    if (/[A-Za-z_$]/.test(current)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      tokens.push({ type: 'identifier', value: source.slice(start, index) });
      continue;
    }
    tokens.push({ type: 'punctuator', value: current });
    index += 1;
  }
  return tokens;
}

module.exports = { tokenizeResourceSyntax };
