const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('Code Coverage Configuration', () => {
  const packagePath = path.join(__dirname, '..', 'package.json');
  const readmePath = path.join(__dirname, '..', 'README.md');
  const gitignorePath = path.join(__dirname, '..', '.gitignore');

  describe('Package dependencies', () => {
    test('should have c8 as devDependency', () => {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

      const hasC8 = pkg.devDependencies?.c8 || pkg.dependencies?.c8;
      assert.ok(hasC8, 'Should have c8 package for coverage');
    });
  });

  describe('Coverage scripts', () => {
    test('should have test:coverage script', () => {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

      assert.ok(pkg.scripts['test:coverage'], 'Should have test:coverage script');
      assert.ok(
        pkg.scripts['test:coverage'].includes('--coverage') ||
        pkg.scripts['test:coverage'].includes('c8'),
        'test:coverage should run coverage reporting'
      );
    });

    test('should have coverage script with thresholds', () => {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

      // Either c8 config in package.json or separate script
      const hasC8Config = pkg.c8 !== undefined;
      const hasCoverageScript = pkg.scripts['test:coverage'] !== undefined;

      assert.ok(
        hasC8Config || hasCoverageScript,
        'Should have c8 configuration or coverage script'
      );
    });
  });

  describe('Coverage thresholds', () => {
    test('should require 80% line coverage', () => {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

      if (pkg.c8) {
        assert.ok(pkg.c8.lines >= 80, 'Should require 80% line coverage');
      } else {
        // If no c8 config yet, test will fail (RED phase)
        assert.fail('c8 configuration not found in package.json');
      }
    });

    test('should require 80% branch coverage', () => {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

      if (pkg.c8) {
        assert.ok(pkg.c8.branches >= 80, 'Should require 80% branch coverage');
      } else {
        assert.fail('c8 configuration not found in package.json');
      }
    });

    test('should require 80% function coverage', () => {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

      if (pkg.c8) {
        assert.ok(pkg.c8.functions >= 80, 'Should require 80% function coverage');
      } else {
        assert.fail('c8 configuration not found in package.json');
      }
    });

    test('should exclude test files from coverage', () => {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

      if (pkg.c8 && pkg.c8.exclude) {
        const excludesTests = pkg.c8.exclude.some(pattern =>
          pattern.includes('test') || pattern.includes('*.test.js')
        );
        assert.ok(excludesTests, 'Should exclude test files from coverage');
      } else {
        assert.fail('c8 exclude configuration not found');
      }
    });
  });

  describe('Coverage badge', () => {
    test('should have coverage badge in README', () => {
      const readme = fs.readFileSync(readmePath, 'utf-8');

      // Should have coverage badge (shields.io or similar)
      // Extract all badge URLs from markdown
      const badgeRegex = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
      const urls = [...readme.matchAll(badgeRegex)].map(match => match[1]);

      // Validate URL comes from trusted badge provider with coverage keyword
      const hasCoverageBadge = urls.some(url => {
        try {
          const urlObj = new URL(url);
          const isTrustedDomain = urlObj.hostname === 'img.shields.io' ||
                                 urlObj.hostname === 'shields.io' ||
                                 urlObj.hostname === 'codecov.io' ||
                                 urlObj.hostname === 'coveralls.io';
          return url.includes('coverage') && isTrustedDomain;
        } catch {
          return false; // Invalid URL
        }
      });

      assert.ok(hasCoverageBadge, 'README should have coverage badge');
    });
  });

  describe('.gitignore', () => {
    test('should ignore coverage reports', () => {
      const gitignore = fs.readFileSync(gitignorePath, 'utf-8');

      const ignoresCoverage = gitignore.includes('coverage') ||
                              gitignore.includes('.nyc_output');

      assert.ok(ignoresCoverage, '.gitignore should ignore coverage directories');
    });
  });
});
