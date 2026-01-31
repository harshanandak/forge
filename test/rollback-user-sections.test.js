// Test: USER Section Extraction and Preservation
// Tests for extractUserSections() and preserveUserSections()

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const testDir = path.join(__dirname, 'temp-user-section-test');
const projectRoot = testDir;

// Test implementation of extractUserSections
function extractUserSections(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const content = fs.readFileSync(filePath, 'utf-8');
  const sections = {};

  // Extract USER sections
  const userRegex = /<!-- USER:START -->([\s\S]*?)<!-- USER:END -->/g;
  let match;
  let index = 0;
  while ((match = userRegex.exec(content)) !== null) {
    sections[`user_${index}`] = match[1];
    index++;
  }

  // Extract named USER sections
  const namedRegex = /<!-- USER:START:(\w+) -->([\s\S]*?)<!-- USER:END:\1 -->/g;
  while ((match = namedRegex.exec(content)) !== null) {
    sections[`user_${match[1]}`] = match[2];
  }

  return sections;
}

// Test implementation of preserveUserSections
function preserveUserSections(filePath, sections) {
  if (!fs.existsSync(filePath) || Object.keys(sections).length === 0) {
    return;
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  // Restore numbered USER sections
  let index = 0;
  content = content.replace(/<!-- USER:START -->([\s\S]*?)<!-- USER:END -->/g, () => {
    const key = `user_${index}`;
    const replacement = sections[key] || '';
    index++;
    return `<!-- USER:START -->${replacement}<!-- USER:END -->`;
  });

  // Restore named USER sections
  content = content.replace(/<!-- USER:START:(\w+) -->([\s\S]*?)<!-- USER:END:\1 -->/g, (match, name) => {
    const key = `user_${name}`;
    const replacement = sections[key] || '';
    return `<!-- USER:START:${name} -->${replacement}<!-- USER:END:${name} -->`;
  });

  fs.writeFileSync(filePath, content, 'utf-8');
}

console.log('=== USER Section Extraction & Preservation Tests ===\n');

let passedTests = 0;
let failedTests = 0;

function runTest(name, testFn) {
  try {
    testFn();
    console.log(`✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.log(`✗ ${name}: ${err.message}`);
    failedTests++;
  }
}

// Setup test directory
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

console.log('--- Basic USER Section Extraction ---\n');

runTest('Extracts single USER section', () => {
  const testFile = path.join(testDir, 'test1.md');
  const content = `# File
<!-- USER:START -->
Custom content here
<!-- USER:END -->
More content`;
  fs.writeFileSync(testFile, content);

  const sections = extractUserSections(testFile);
  assert.strictEqual(Object.keys(sections).length, 1);
  assert.strictEqual(sections.user_0.trim(), 'Custom content here');

  fs.unlinkSync(testFile);
});

runTest('Extracts multiple USER sections', () => {
  const testFile = path.join(testDir, 'test2.md');
  const content = `# File
<!-- USER:START -->
First section
<!-- USER:END -->
Middle content
<!-- USER:START -->
Second section
<!-- USER:END -->`;
  fs.writeFileSync(testFile, content);

  const sections = extractUserSections(testFile);
  assert.strictEqual(Object.keys(sections).length, 2);
  assert.strictEqual(sections.user_0.trim(), 'First section');
  assert.strictEqual(sections.user_1.trim(), 'Second section');

  fs.unlinkSync(testFile);
});

runTest('Returns empty object for non-existent file', () => {
  const sections = extractUserSections(path.join(testDir, 'nonexistent.md'));
  assert.strictEqual(Object.keys(sections).length, 0);
});

console.log('\n--- USER Section Preservation ---\n');

runTest('Preserves single USER section', () => {
  const testFile = path.join(testDir, 'test6.md');
  const original = `# File
<!-- USER:START -->
Original content
<!-- USER:END -->`;
  fs.writeFileSync(testFile, original);

  const sections = extractUserSections(testFile);

  const afterRollback = `# File
<!-- USER:START -->
<!-- USER:END -->`;
  fs.writeFileSync(testFile, afterRollback);

  preserveUserSections(testFile, sections);

  const restored = fs.readFileSync(testFile, 'utf-8');
  assert.ok(restored.includes('Original content'));

  fs.unlinkSync(testFile);
});

try {
  fs.rmdirSync(testDir, { recursive: true });
} catch (err) {
  // Ignore
}

console.log('\n' + '='.repeat(60));
console.log(`Total: ${passedTests + failedTests} | Passed: ${passedTests} ✓ | Failed: ${failedTests} ✗`);
console.log('='.repeat(60));

if (failedTests === 0) {
  console.log('\n✅ All USER section tests PASSED!');
  process.exit(0);
} else {
  console.log('\n❌ Some tests FAILED!');
  process.exit(1);
}
