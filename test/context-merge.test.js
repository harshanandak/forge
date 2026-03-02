const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

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

      expect(Array.isArray(sections)).toBeTruthy();
      expect(sections.length > 0).toBeTruthy();

      // Check structure of first section
      expect(sections[0].hasOwnProperty('level')).toBeTruthy();
      expect(sections[0].hasOwnProperty('header')).toBeTruthy();
      expect(sections[0].hasOwnProperty('content')).toBeTruthy();
      expect(sections[0].hasOwnProperty('raw')).toBeTruthy();
    });

    test('should handle markdown without sections', () => {
      const markdown = 'Just plain text without headers.';
      const sections = parseSemanticSections(markdown);

      expect(Array.isArray(sections)).toBeTruthy();
      // Should return at least the root content
      expect(sections.length > 0).toBeTruthy();
    });

    test('should extract nested sections correctly', () => {
      const markdown = `## Parent

Parent content

### Child

Child content`;

      const sections = parseSemanticSections(markdown);

      const parent = sections.find(s => s.header === 'Parent');
      const child = sections.find(s => s.header === 'Child');

      expect(parent).toBeTruthy();
      expect(child).toBeTruthy();
      expect(parent.level).toBe(2);
      expect(child.level).toBe(3);
    });
  });

  describe('detectCategory', () => {
    test('should categorize project description as PRESERVE', () => {
      const result = detectCategory('Project Description');

      expect(result.hasOwnProperty('category')).toBeTruthy();
      expect(result.hasOwnProperty('confidence')).toBeTruthy();
      expect(result.category).toBe('preserve');
      expect(result.confidence > 0.7).toBeTruthy();
    });

    test('should categorize workflow as REPLACE', () => {
      const result = detectCategory('Workflow');

      expect(result.category).toBe('replace');
      expect(result.confidence > 0.7).toBeTruthy();
    });

    test('should categorize toolchain as MERGE', () => {
      const result = detectCategory('Toolchain');

      expect(result.category).toBe('merge');
      expect(result.confidence > 0.7).toBeTruthy();
    });

    test('should handle fuzzy matching for similar headers', () => {
      const variations = [
        'Development Workflow',
        'Our Workflow',
        'Workflow Process'
      ];

      variations.forEach(header => {
        const result = detectCategory(header);
        expect(result.category).toBe('replace');
        // Fuzzy match should have slightly lower confidence
        expect(result.confidence > 0.5).toBeTruthy();
      });
    });

    test('should return low confidence for unknown headers', () => {
      const result = detectCategory('Random Unknown Section');

      expect(result.hasOwnProperty('confidence')).toBeTruthy();
      expect(result.confidence < 0.5).toBeTruthy();
    });

    test('should handle case-insensitive matching', () => {
      const result1 = detectCategory('PROJECT DESCRIPTION');
      const result2 = detectCategory('project description');

      expect(result1.category).toBe(result2.category);
      expect(result1.category).toBe('preserve');
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

      expect(merged.includes('e-commerce platform')).toBeTruthy();
      expect(merged.includes('Stripe integration')).toBeTruthy();
      expect(merged.includes('Multi-tenant architecture')).toBeTruthy();
    });

    test('should preserve user domain knowledge', () => {
      const existing = loadFixture('simple-project-description.md');
      const merged = semanticMerge(existing, forgeTemplate);

      expect(merged.includes('Domain Knowledge')).toBeTruthy();
      expect(merged.includes('Stripe webhooks')).toBeTruthy();
      expect(merged.includes('JWT authentication')).toBeTruthy();
    });

    test('should preserve user coding standards', () => {
      const existing = loadFixture('simple-project-description.md');
      const merged = semanticMerge(existing, forgeTemplate);

      expect(merged.includes('Coding Standards')).toBeTruthy();
      expect(merged.includes('TypeScript strict mode')).toBeTruthy();
      expect(merged.includes('Test coverage minimum 80%')).toBeTruthy();
    });

    test('should replace user workflow with Forge workflow', () => {
      const existing = loadFixture('workflow-replacement.md');
      const merged = semanticMerge(existing, forgeTemplate);

      // Forge workflow should be present
      expect(merged.includes('Forge Workflow')).toBeTruthy();
      expect(merged.includes('9-stage TDD workflow')).toBeTruthy();

      // User's old workflow should be replaced
      expect(!merged.includes('simple 3-step workflow')).toBeTruthy();
    });

    test('should replace user TDD section with Forge principles', () => {
      const existing = loadFixture('workflow-replacement.md');
      const merged = semanticMerge(existing, forgeTemplate);

      expect(merged.includes('Core Principles')).toBeTruthy();
      expect(merged.includes('TDD-First')).toBeTruthy();

      // User's old TDD approach should be replaced
      expect(!merged.includes('not strictly enforced')).toBeTruthy();
    });

    test('should merge toolchain sections (combine both)', () => {
      const existing = loadFixture('merge-toolchain.md');
      const merged = semanticMerge(existing, forgeTemplate);

      // User's toolchain should be preserved
      expect(merged.includes('Sentry')).toBeTruthy();
      expect(merged.includes('Datadog')).toBeTruthy();

      // But we don't add duplicate forge toolchain if it doesn't exist
      // (forge template doesn't have toolchain in this test)
    });

    test('should handle fuzzy header matching', () => {
      const existing = loadFixture('fuzzy-headers.md');
      const merged = semanticMerge(existing, forgeTemplate);

      // "Development Workflow" should match "Workflow" category
      expect(merged.includes('Forge Workflow')).toBeTruthy();

      // "Test-Driven Development" should match "TDD" category
      expect(merged.includes('Core Principles')).toBeTruthy();
      expect(merged.includes('TDD-First')).toBeTruthy();
    });

    test('should preserve project overview/description', () => {
      const existing = loadFixture('fuzzy-headers.md');
      const merged = semanticMerge(existing, forgeTemplate);

      expect(merged.includes('Analytics dashboard')).toBeTruthy();
      expect(merged.includes('SaaS metrics')).toBeTruthy();
    });

    test('should handle conflicting sections with detailed process', () => {
      const existing = loadFixture('conflicting-sections.md');
      const merged = semanticMerge(existing, forgeTemplate);

      // Project background should be preserved
      expect(merged.includes('Legacy monolith')).toBeTruthy();
      expect(merged.includes('millions of requests per day')).toBeTruthy();

      // Migration strategy should be preserved
      expect(merged.includes('Migration Strategy')).toBeTruthy();
      expect(merged.includes('Strangler fig pattern')).toBeTruthy();

      // Process section (workflow-like) should be replaced
      expect(merged.includes('Forge Workflow')).toBeTruthy();
    });

    test('should not add markers by default', () => {
      const existing = loadFixture('simple-project-description.md');
      const merged = semanticMerge(existing, forgeTemplate);

      expect(!merged.includes('<!-- USER:START -->')).toBeTruthy();
      expect(!merged.includes('<!-- FORGE:START -->')).toBeTruthy();
    });

    test('should add markers when option is enabled', () => {
      const existing = loadFixture('simple-project-description.md');
      const merged = semanticMerge(existing, forgeTemplate, { addMarkers: true });

      expect(merged.includes('<!-- USER:START -->')).toBeTruthy();
      expect(merged.includes('<!-- USER:END -->')).toBeTruthy();
      expect(merged.includes('<!-- FORGE:START -->')).toBeTruthy();
      expect(merged.includes('<!-- FORGE:END -->')).toBeTruthy();
    });

    test('should preserve user build commands', () => {
      const existing = loadFixture('simple-project-description.md');
      const merged = semanticMerge(existing, forgeTemplate);

      expect(merged.includes('npm install')).toBeTruthy();
      expect(merged.includes('npm run dev')).toBeTruthy();
      expect(merged.includes('npm test')).toBeTruthy();
    });

    test('should handle empty existing content', () => {
      const existing = '';
      const merged = semanticMerge(existing, forgeTemplate);

      // Should return forge template when existing is empty
      expect(merged.includes('Forge Workflow')).toBeTruthy();
      expect(merged.includes('Core Principles')).toBeTruthy();
    });

    test('should handle empty forge content', () => {
      const existing = loadFixture('simple-project-description.md');
      const forge = '';

      const merged = semanticMerge(existing, forge);

      // Should preserve existing when forge is empty
      expect(merged.includes('e-commerce platform')).toBeTruthy();
    });
  });

  describe('wrapWithMarkers', () => {
    test('should wrap content with USER and FORGE markers', () => {
      const userContent = 'User project description';
      const forgeContent = 'Forge workflow';

      const wrapped = wrapWithMarkers({ user: userContent, forge: forgeContent });

      expect(wrapped.includes('<!-- USER:START -->')).toBeTruthy();
      expect(wrapped.includes('<!-- USER:END -->')).toBeTruthy();
      expect(wrapped.includes('<!-- FORGE:START -->')).toBeTruthy();
      expect(wrapped.includes('<!-- FORGE:END -->')).toBeTruthy();
      expect(wrapped.includes(userContent)).toBeTruthy();
      expect(wrapped.includes(forgeContent)).toBeTruthy();
    });

    test('should handle empty user content', () => {
      const wrapped = wrapWithMarkers({ user: '', forge: 'Forge content' });

      expect(wrapped.includes('<!-- FORGE:START -->')).toBeTruthy();
      expect(wrapped.includes('Forge content')).toBeTruthy();
    });

    test('should handle empty forge content', () => {
      const wrapped = wrapWithMarkers({ user: 'User content', forge: '' });

      expect(wrapped.includes('<!-- USER:START -->')).toBeTruthy();
      expect(wrapped.includes('User content')).toBeTruthy();
    });
  });

  describe('edge cases', () => {
    test('should handle markdown with no headers', () => {
      const existing = 'Just plain text content without any headers.';
      const forge = '## Header\n\nContent';

      const merged = semanticMerge(existing, forge);

      expect(merged).toBeTruthy();
      expect(merged.length > 0).toBeTruthy();
    });

    test('should handle malformed markdown', () => {
      const existing = '## Header without content\n\n## Another header';
      const forge = '## Forge Header\n\nForge content';

      const merged = semanticMerge(existing, forge);

      expect(merged).toBeTruthy();
    });

    test('should handle very long content', () => {
      const longContent = '## Section\n\n' + 'Content line.\n'.repeat(10000);
      const forge = '## Forge\n\nForge content';

      const merged = semanticMerge(longContent, forge);

      expect(merged).toBeTruthy();
      expect(merged.length > 0).toBeTruthy();
    });

    test('should handle special characters in headers', () => {
      const existing = '## Project [Beta] & "Alpha"\n\nContent with special chars.';
      const forge = '## Forge\n\nForge content';

      const merged = semanticMerge(existing, forge);

      expect(merged.includes('Project [Beta]')).toBeTruthy();
    });

    test('should handle unicode characters', () => {
      const existing = '## Проект (Project in Russian)\n\nСодержание 内容';
      const forge = '## Forge\n\nForge content';

      const merged = semanticMerge(existing, forge);

      expect(merged.includes('Проект')).toBeTruthy();
      expect(merged.includes('Содержание')).toBeTruthy();
    });
  });
});
