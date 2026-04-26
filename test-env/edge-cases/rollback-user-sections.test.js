// Test: USER Section Extraction and Preservation
// Tests for extractUserSections() and preserveUserSections()

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
const fs = require('fs');
const path = require('path');

const testDir = path.join(__dirname, 'temp-user-section-test');
const _projectRoot = testDir;

function ensureTestDir() {
  fs.mkdirSync(testDir, { recursive: true });
}

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

describe('USER Section Extraction & Preservation Tests', () => {
  beforeAll(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    try {
      fs.rmdirSync(testDir, { recursive: true });
    } catch (_err) {
      // Ignore
    }
  });

  describe('Basic USER Section Extraction', () => {
    test('Extracts single USER section', () => {
      ensureTestDir();
      const testFile = path.join(testDir, 'test1.md');
      const content = `# File
<!-- USER:START -->
Custom content here
<!-- USER:END -->
More content`;
      fs.writeFileSync(testFile, content);

      const sections = extractUserSections(testFile);
      expect(Object.keys(sections).length).toBe(1);
      expect(sections.user_0.trim()).toBe('Custom content here');

      fs.unlinkSync(testFile);
    });

    test('Extracts multiple USER sections', () => {
      ensureTestDir();
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
      expect(Object.keys(sections).length).toBe(2);
      expect(sections.user_0.trim()).toBe('First section');
      expect(sections.user_1.trim()).toBe('Second section');

      fs.unlinkSync(testFile);
    });

    test('Returns empty object for non-existent file', () => {
      ensureTestDir();
      const sections = extractUserSections(path.join(testDir, 'nonexistent.md'));
      expect(Object.keys(sections).length).toBe(0);
    });
  });

  describe('USER Section Preservation', () => {
    test('Preserves single USER section', () => {
      ensureTestDir();
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
      expect(restored.includes('Original content')).toBeTruthy();

      fs.unlinkSync(testFile);
    });
  });
});
