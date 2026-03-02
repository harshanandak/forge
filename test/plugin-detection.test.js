const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, test, afterEach, expect } = require('bun:test');

const {
  detectTechStack,
  // Existing exports — backward compat
  autoDetect,
  detectFramework,
  detectLanguage,
} = require('../lib/project-discovery');

// Helper to create a temp project with a given package.json and optional config files
function createTempProject(deps = {}, devDeps = {}, configFiles = []) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-detect-'));
  const pkg = { name: 'test-project', version: '1.0.0' };
  if (Object.keys(deps).length > 0) pkg.dependencies = deps;
  if (Object.keys(devDeps).length > 0) pkg.devDependencies = devDeps;
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg));
  for (const file of configFiles) {
    const filePath = path.join(tmpDir, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{}');
  }
  return tmpDir;
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('plugin-detection (detectTechStack)', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) {
      cleanupTempDir(tmpDir);
      tmpDir = null;
    }
  });

  describe('return shape', () => {
    test('returns correct shape with all category arrays', () => {
      tmpDir = createTempProject();
      const result = detectTechStack(tmpDir);
      expect(Array.isArray(result.frameworks)).toBeTruthy();
      expect(Array.isArray(result.languages)).toBeTruthy();
      expect(Array.isArray(result.databases)).toBeTruthy();
      expect(Array.isArray(result.auth)).toBeTruthy();
      expect(Array.isArray(result.payments)).toBeTruthy();
      expect(Array.isArray(result.cicd)).toBeTruthy();
      expect(Array.isArray(result.testing)).toBeTruthy();
      expect(Array.isArray(result.linting)).toBeTruthy();
      expect(Array.isArray(result.lsps)).toBeTruthy();
    });
  });

  describe('framework detection', () => {
    test('detects React from react dependency', () => {
      tmpDir = createTempProject({ react: '^18.0.0' });
      const result = detectTechStack(tmpDir);
      expect(result.frameworks.includes('react')).toBeTruthy();
    });

    test('detects Next.js from next dependency', () => {
      tmpDir = createTempProject({ next: '^14.0.0' });
      const result = detectTechStack(tmpDir);
      expect(result.frameworks.includes('nextjs')).toBeTruthy();
    });

    test('detects Angular from @angular/core', () => {
      tmpDir = createTempProject({ '@angular/core': '^17.0.0' });
      const result = detectTechStack(tmpDir);
      expect(result.frameworks.includes('angular')).toBeTruthy();
    });

    test('detects Express from express dependency', () => {
      tmpDir = createTempProject({ express: '^4.18.0' });
      const result = detectTechStack(tmpDir);
      expect(result.frameworks.includes('express')).toBeTruthy();
    });

    test('detects NestJS from @nestjs/core', () => {
      tmpDir = createTempProject({ '@nestjs/core': '^10.0.0' });
      const result = detectTechStack(tmpDir);
      expect(result.frameworks.includes('nestjs')).toBeTruthy();
    });

    test('detects multiple frameworks simultaneously', () => {
      tmpDir = createTempProject({ next: '^14.0.0', react: '^18.0.0', express: '^4.18.0' });
      const result = detectTechStack(tmpDir);
      expect(result.frameworks.includes('nextjs')).toBeTruthy();
      expect(result.frameworks.includes('react')).toBeTruthy();
      expect(result.frameworks.includes('express')).toBeTruthy();
    });
  });

  describe('database detection', () => {
    test('detects Supabase from @supabase/supabase-js', () => {
      tmpDir = createTempProject({ '@supabase/supabase-js': '^2.0.0' });
      const result = detectTechStack(tmpDir);
      expect(result.databases.includes('supabase')).toBeTruthy();
    });

    test('detects Prisma from @prisma/client', () => {
      tmpDir = createTempProject({ '@prisma/client': '^5.0.0' });
      const result = detectTechStack(tmpDir);
      expect(result.databases.includes('prisma')).toBeTruthy();
    });
  });

  describe('payment detection', () => {
    test('detects Stripe from stripe dependency', () => {
      tmpDir = createTempProject({ stripe: '^14.0.0' });
      const result = detectTechStack(tmpDir);
      expect(result.payments.includes('stripe')).toBeTruthy();
    });
  });

  describe('auth detection', () => {
    test('detects Clerk from @clerk/nextjs', () => {
      tmpDir = createTempProject({ '@clerk/nextjs': '^4.0.0' });
      const result = detectTechStack(tmpDir);
      expect(result.auth.includes('clerk')).toBeTruthy();
    });
  });

  describe('LSP detection', () => {
    test('detects TypeScript LSP from tsconfig.json', () => {
      tmpDir = createTempProject({ typescript: '^5.0.0' }, {}, ['tsconfig.json']);
      const result = detectTechStack(tmpDir);
      expect(result.lsps.includes('typescript')).toBeTruthy();
    });
  });

  describe('linting detection', () => {
    test('detects Biome from biome.json', () => {
      tmpDir = createTempProject({}, {}, ['biome.json']);
      const result = detectTechStack(tmpDir);
      expect(result.linting.includes('biome')).toBeTruthy();
    });
  });

  describe('testing detection', () => {
    test('detects Vitest from vitest dependency', () => {
      tmpDir = createTempProject({}, { vitest: '^1.0.0' });
      const result = detectTechStack(tmpDir);
      expect(result.testing.includes('vitest')).toBeTruthy();
    });

    test('detects Playwright from @playwright/test', () => {
      tmpDir = createTempProject({}, { '@playwright/test': '^1.40.0' });
      const result = detectTechStack(tmpDir);
      expect(result.testing.includes('playwright')).toBeTruthy();
    });
  });

  describe('edge cases', () => {
    test('returns empty arrays for unrecognized project', () => {
      tmpDir = createTempProject({ 'some-unknown-lib': '^1.0.0' });
      const result = detectTechStack(tmpDir);
      expect(result.frameworks.length).toBe(0);
      expect(result.databases.length).toBe(0);
      expect(result.auth.length).toBe(0);
      expect(result.payments.length).toBe(0);
    });

    test('handles missing package.json gracefully', () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-detect-'));
      // No package.json created
      const result = detectTechStack(tmpDir);
      expect(Array.isArray(result.frameworks)).toBeTruthy();
      expect(Array.isArray(result.languages)).toBeTruthy();
    });
  });

  describe('backward compatibility', () => {
    test('existing detectFramework() still works unchanged', async () => {
      tmpDir = createTempProject({ next: '^14.0.0' });
      const framework = await detectFramework(tmpDir);
      expect(framework).toBe('Next.js');
    });

    test('existing autoDetect() still works unchanged', async () => {
      tmpDir = createTempProject({ react: '^18.0.0' }, { typescript: '^5.0.0' });
      const result = await autoDetect(tmpDir);
      expect(result.framework).toBeTruthy();
      expect(result.language).toBeTruthy();
      expect(result.stage).toBeTruthy();
    });

    test('existing detectLanguage() still works unchanged', async () => {
      tmpDir = createTempProject({}, { typescript: '^5.0.0' });
      const language = await detectLanguage(tmpDir);
      expect(language).toBe('typescript');
    });
  });
});
