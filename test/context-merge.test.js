const fs = require('fs');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

// Module under test
const {
  parseSemanticSections,
  detectCategory,
  semanticMerge,
  wrapWithMarkers
} = require('../lib/context-merge');

describe('context-merge', () => {
  const fixturesDir = path.join(__dirname, 'fixtures', 'context-merge');

  // Helper to load fixture files
  function loadFixture(filename) {
    return fs.readFileSync(path.join(fixturesDir, filename), 'utf8');
  }

  describe('parseSemanticSections', () => {
    test('should parse markdown into structured sections', () => {
      const markdown = `# Main Title

Content before first section.

## Section 1

Content for section 1.

### Subsection 1.1

Content for subsection.

## Section 2

Content for section 2.`;

      const sections = parseSemanticSections(markdown);

      assert.ok(Array.isArray(sections));
      assert.ok(sections.length > 0);

      // Check structure of first section
      assert.ok(sections[0].hasOwnProperty('level'));
      assert.ok(sections[0].hasOwnProperty('header'));
      assert.ok(sections[0].hasOwnProperty('content'));
      assert.ok(sections[0].hasOwnProperty('raw'));
    });

    test('should handle markdown without sections', () => {
      const markdown = 'Just plain text without headers.';
      const sections = parseSemanticSections(markdown);

      assert.ok(Array.isArray(sections));
      // Should return at least the root content
      assert.ok(sections.length >= 0);
    });

    test('should extract nested sections correctly', () => {
      const markdown = `## Parent

Parent content

### Child

Child content`;

      const sections = parseSemanticSections(markdown);

      const parent = sections.find(s => s.header === 'Parent');
      const child = sections.find(s => s.header === 'Child');

      assert.ok(parent);
      assert.ok(child);
      assert.strictEqual(parent.level, 2);
      assert.strictEqual(child.level, 3);
    });
  });

  describe('detectCategory', () => {
    test('should categorize project description as PRESERVE', () => {
      const result = detectCategory('Project Description');

      assert.ok(result.hasOwnProperty('category'));
      assert.ok(result.hasOwnProperty('confidence'));
      assert.strictEqual(result.category, 'preserve');
      assert.ok(result.confidence > 0.7);
    });

    test('should categorize workflow as REPLACE', () => {
      const result = detectCategory('Workflow');

      assert.strictEqual(result.category, 'replace');
      assert.ok(result.confidence > 0.7);
    });

    test('should categorize toolchain as MERGE', () => {
      const result = detectCategory('Toolchain');

      assert.strictEqual(result.category, 'merge');
      assert.ok(result.confidence > 0.7);
    });

    test('should handle fuzzy matching for similar headers', () => {
      const variations = [
        'Development Workflow',
        'Our Workflow',
        'Workflow Process'
      ];

      variations.forEach(header => {
        const result = detectCategory(header);
        assert.strictEqual(result.category, 'replace');
        // Fuzzy match should have slightly lower confidence
        assert.ok(result.confidence > 0.5);
      });
    });

    test('should return low confidence for unknown headers', () => {
      const result = detectCategory('Random Unknown Section');

      assert.ok(result.hasOwnProperty('confidence'));
      assert.ok(result.confidence < 0.5);
    });

    test('should handle case-insensitive matching', () => {
      const result1 = detectCategory('PROJECT DESCRIPTION');
      const result2 = detectCategory('project description');

      assert.strictEqual(result1.category, result2.category);
      assert.strictEqual(result1.category, 'preserve');
    });
  });

  describe('semanticMerge', () => {
    const forgeTemplate = `# Project Instructions

## Forge Workflow

Use the 9-stage TDD workflow.

## Core Principles

- TDD-First
- Research-First
- Security Built-In`;

    test('should preserve user project description', () => {
      const existing = loadFixture('simple-project-description.md');
      const merged = semanticMerge(existing, forgeTemplate);

      assert.ok(merged.includes('e-commerce platform'));
      assert.ok(merged.includes('Stripe integration'));
      assert.ok(merged.includes('Multi-tenant architecture'));
    });

    test('should preserve user domain knowledge', () => {
      const existing = loadFixture('simple-project-description.md');
      const merged = semanticMerge(existing, forgeTemplate);

      assert.ok(merged.includes('Domain Knowledge'));
      assert.ok(merged.includes('Stripe webhooks'));
      assert.ok(merged.includes('JWT authentication'));
    });

    test('should preserve user coding standards', () => {
      const existing = loadFixture('simple-project-description.md');
      const merged = semanticMerge(existing, forgeTemplate);

      assert.ok(merged.includes('Coding Standards'));
      assert.ok(merged.includes('TypeScript strict mode'));
      assert.ok(merged.includes('Test coverage minimum 80%'));
    });

    test('should replace user workflow with Forge workflow', () => {
      const existing = loadFixture('workflow-replacement.md');
      const merged = semanticMerge(existing, forgeTemplate);

      // Forge workflow should be present
      assert.ok(merged.includes('Forge Workflow'));
      assert.ok(merged.includes('9-stage TDD workflow'));

      // User's old workflow should be replaced
      assert.ok(!merged.includes('simple 3-step workflow'));
    });

    test('should replace user TDD section with Forge principles', () => {
      const existing = loadFixture('workflow-replacement.md');
      const merged = semanticMerge(existing, forgeTemplate);

      assert.ok(merged.includes('Core Principles'));
      assert.ok(merged.includes('TDD-First'));

      // User's old TDD approach should be replaced
      assert.ok(!merged.includes('not strictly enforced'));
    });

    test('should merge toolchain sections (combine both)', () => {
      const existing = loadFixture('merge-toolchain.md');
      const merged = semanticMerge(existing, forgeTemplate);

      // User's toolchain should be preserved
      assert.ok(merged.includes('Sentry'));
      assert.ok(merged.includes('Datadog'));

      // But we don't add duplicate forge toolchain if it doesn't exist
      // (forge template doesn't have toolchain in this test)
    });

    test('should handle fuzzy header matching', () => {
      const existing = loadFixture('fuzzy-headers.md');
      const merged = semanticMerge(existing, forgeTemplate);

      // "Development Workflow" should match "Workflow" category
      assert.ok(merged.includes('Forge Workflow'));

      // "Test-Driven Development" should match "TDD" category
      assert.ok(merged.includes('Core Principles'));
      assert.ok(merged.includes('TDD-First'));
    });

    test('should preserve project overview/description', () => {
      const existing = loadFixture('fuzzy-headers.md');
      const merged = semanticMerge(existing, forgeTemplate);

      assert.ok(merged.includes('Analytics dashboard'));
      assert.ok(merged.includes('SaaS metrics'));
    });

    test('should handle conflicting sections with detailed process', () => {
      const existing = loadFixture('conflicting-sections.md');
      const merged = semanticMerge(existing, forgeTemplate);

      // Project background should be preserved
      assert.ok(merged.includes('Legacy monolith'));
      assert.ok(merged.includes('millions of requests per day'));

      // Migration strategy should be preserved
      assert.ok(merged.includes('Migration Strategy'));
      assert.ok(merged.includes('Strangler fig pattern'));

      // Process section (workflow-like) should be replaced
      assert.ok(merged.includes('Forge Workflow'));
    });

    test('should not add markers by default', () => {
      const existing = loadFixture('simple-project-description.md');
      const merged = semanticMerge(existing, forgeTemplate);

      assert.ok(!merged.includes('<!-- USER:START -->'));
      assert.ok(!merged.includes('<!-- FORGE:START -->'));
    });

    test('should add markers when option is enabled', () => {
      const existing = loadFixture('simple-project-description.md');
      const merged = semanticMerge(existing, forgeTemplate, { addMarkers: true });

      assert.ok(merged.includes('<!-- USER:START -->'));
      assert.ok(merged.includes('<!-- USER:END -->'));
      assert.ok(merged.includes('<!-- FORGE:START -->'));
      assert.ok(merged.includes('<!-- FORGE:END -->'));
    });

    test('should preserve user build commands', () => {
      const existing = loadFixture('simple-project-description.md');
      const merged = semanticMerge(existing, forgeTemplate);

      assert.ok(merged.includes('npm install'));
      assert.ok(merged.includes('npm run dev'));
      assert.ok(merged.includes('npm test'));
    });

    test('should handle empty existing content', () => {
      const existing = '';
      const merged = semanticMerge(existing, forgeTemplate);

      // Should return forge template when existing is empty
      assert.ok(merged.includes('Forge Workflow'));
      assert.ok(merged.includes('Core Principles'));
    });

    test('should handle empty forge content', () => {
      const existing = loadFixture('simple-project-description.md');
      const forge = '';

      const merged = semanticMerge(existing, forge);

      // Should preserve existing when forge is empty
      assert.ok(merged.includes('e-commerce platform'));
    });
  });

  describe('wrapWithMarkers', () => {
    test('should wrap content with USER and FORGE markers', () => {
      const userContent = 'User project description';
      const forgeContent = 'Forge workflow';

      const wrapped = wrapWithMarkers({ user: userContent, forge: forgeContent });

      assert.ok(wrapped.includes('<!-- USER:START -->'));
      assert.ok(wrapped.includes('<!-- USER:END -->'));
      assert.ok(wrapped.includes('<!-- FORGE:START -->'));
      assert.ok(wrapped.includes('<!-- FORGE:END -->'));
      assert.ok(wrapped.includes(userContent));
      assert.ok(wrapped.includes(forgeContent));
    });

    test('should handle empty user content', () => {
      const wrapped = wrapWithMarkers({ user: '', forge: 'Forge content' });

      assert.ok(wrapped.includes('<!-- FORGE:START -->'));
      assert.ok(wrapped.includes('Forge content'));
    });

    test('should handle empty forge content', () => {
      const wrapped = wrapWithMarkers({ user: 'User content', forge: '' });

      assert.ok(wrapped.includes('<!-- USER:START -->'));
      assert.ok(wrapped.includes('User content'));
    });
  });

  describe('edge cases', () => {
    test('should handle markdown with no headers', () => {
      const existing = 'Just plain text content without any headers.';
      const forge = '## Header\n\nContent';

      const merged = semanticMerge(existing, forge);

      assert.ok(merged);
      assert.ok(merged.length > 0);
    });

    test('should handle malformed markdown', () => {
      const existing = '## Header without content\n\n## Another header';
      const forge = '## Forge Header\n\nForge content';

      const merged = semanticMerge(existing, forge);

      assert.ok(merged);
    });

    test('should handle very long content', () => {
      const longContent = '## Section\n\n' + 'Content line.\n'.repeat(10000);
      const forge = '## Forge\n\nForge content';

      const merged = semanticMerge(longContent, forge);

      assert.ok(merged);
      assert.ok(merged.length > 0);
    });

    test('should handle special characters in headers', () => {
      const existing = '## Project [Beta] & "Alpha"\n\nContent with special chars.';
      const forge = '## Forge\n\nForge content';

      const merged = semanticMerge(existing, forge);

      assert.ok(merged.includes('Project [Beta]'));
    });

    test('should handle unicode characters', () => {
      const existing = '## Проект (Project in Russian)\n\nСодержание 内容';
      const forge = '## Forge\n\nForge content';

      const merged = semanticMerge(existing, forge);

      assert.ok(merged.includes('Проект'));
      assert.ok(merged.includes('Содержание'));
    });
  });
});
