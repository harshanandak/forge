const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

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
      assert.ok(Array.isArray(result.frameworks), 'frameworks should be an array');
      assert.ok(Array.isArray(result.languages), 'languages should be an array');
      assert.ok(Array.isArray(result.databases), 'databases should be an array');
      assert.ok(Array.isArray(result.auth), 'auth should be an array');
      assert.ok(Array.isArray(result.payments), 'payments should be an array');
      assert.ok(Array.isArray(result.cicd), 'cicd should be an array');
      assert.ok(Array.isArray(result.testing), 'testing should be an array');
      assert.ok(Array.isArray(result.linting), 'linting should be an array');
      assert.ok(Array.isArray(result.lsps), 'lsps should be an array');
    });
  });

  describe('framework detection', () => {
    test('detects React from react dependency', () => {
      tmpDir = createTempProject({ react: '^18.0.0' });
      const result = detectTechStack(tmpDir);
      assert.ok(result.frameworks.includes('react'));
    });

    test('detects Next.js from next dependency', () => {
      tmpDir = createTempProject({ next: '^14.0.0' });
      const result = detectTechStack(tmpDir);
      assert.ok(result.frameworks.includes('nextjs'));
    });

    test('detects Angular from @angular/core', () => {
      tmpDir = createTempProject({ '@angular/core': '^17.0.0' });
      const result = detectTechStack(tmpDir);
      assert.ok(result.frameworks.includes('angular'));
    });

    test('detects Express from express dependency', () => {
      tmpDir = createTempProject({ express: '^4.18.0' });
      const result = detectTechStack(tmpDir);
      assert.ok(result.frameworks.includes('express'));
    });

    test('detects NestJS from @nestjs/core', () => {
      tmpDir = createTempProject({ '@nestjs/core': '^10.0.0' });
      const result = detectTechStack(tmpDir);
      assert.ok(result.frameworks.includes('nestjs'));
    });

    test('detects multiple frameworks simultaneously', () => {
      tmpDir = createTempProject({ next: '^14.0.0', react: '^18.0.0', express: '^4.18.0' });
      const result = detectTechStack(tmpDir);
      assert.ok(result.frameworks.includes('nextjs'));
      assert.ok(result.frameworks.includes('react'));
      assert.ok(result.frameworks.includes('express'));
    });
  });

  describe('database detection', () => {
    test('detects Supabase from @supabase/supabase-js', () => {
      tmpDir = createTempProject({ '@supabase/supabase-js': '^2.0.0' });
      const result = detectTechStack(tmpDir);
      assert.ok(result.databases.includes('supabase'));
    });

    test('detects Prisma from @prisma/client', () => {
      tmpDir = createTempProject({ '@prisma/client': '^5.0.0' });
      const result = detectTechStack(tmpDir);
      assert.ok(result.databases.includes('prisma'));
    });
  });

  describe('payment detection', () => {
    test('detects Stripe from stripe dependency', () => {
      tmpDir = createTempProject({ stripe: '^14.0.0' });
      const result = detectTechStack(tmpDir);
      assert.ok(result.payments.includes('stripe'));
    });
  });

  describe('auth detection', () => {
    test('detects Clerk from @clerk/nextjs', () => {
      tmpDir = createTempProject({ '@clerk/nextjs': '^4.0.0' });
      const result = detectTechStack(tmpDir);
      assert.ok(result.auth.includes('clerk'));
    });
  });

  describe('LSP detection', () => {
    test('detects TypeScript LSP from tsconfig.json', () => {
      tmpDir = createTempProject({ typescript: '^5.0.0' }, {}, ['tsconfig.json']);
      const result = detectTechStack(tmpDir);
      assert.ok(result.lsps.includes('typescript'));
    });
  });

  describe('linting detection', () => {
    test('detects Biome from biome.json', () => {
      tmpDir = createTempProject({}, {}, ['biome.json']);
      const result = detectTechStack(tmpDir);
      assert.ok(result.linting.includes('biome'));
    });
  });

  describe('testing detection', () => {
    test('detects Vitest from vitest dependency', () => {
      tmpDir = createTempProject({}, { vitest: '^1.0.0' });
      const result = detectTechStack(tmpDir);
      assert.ok(result.testing.includes('vitest'));
    });

    test('detects Playwright from @playwright/test', () => {
      tmpDir = createTempProject({}, { '@playwright/test': '^1.40.0' });
      const result = detectTechStack(tmpDir);
      assert.ok(result.testing.includes('playwright'));
    });
  });

  describe('edge cases', () => {
    test('returns empty arrays for unrecognized project', () => {
      tmpDir = createTempProject({ 'some-unknown-lib': '^1.0.0' });
      const result = detectTechStack(tmpDir);
      assert.strictEqual(result.frameworks.length, 0);
      assert.strictEqual(result.databases.length, 0);
      assert.strictEqual(result.auth.length, 0);
      assert.strictEqual(result.payments.length, 0);
    });

    test('handles missing package.json gracefully', () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-detect-'));
      // No package.json created
      const result = detectTechStack(tmpDir);
      assert.ok(Array.isArray(result.frameworks));
      assert.ok(Array.isArray(result.languages));
    });
  });

  describe('backward compatibility', () => {
    test('existing detectFramework() still works unchanged', async () => {
      tmpDir = createTempProject({ next: '^14.0.0' });
      const framework = await detectFramework(tmpDir);
      assert.strictEqual(framework, 'Next.js');
    });

    test('existing autoDetect() still works unchanged', async () => {
      tmpDir = createTempProject({ react: '^18.0.0' }, { typescript: '^5.0.0' });
      const result = await autoDetect(tmpDir);
      assert.ok(result.framework);
      assert.ok(result.language);
      assert.ok(result.stage);
    });

    test('existing detectLanguage() still works unchanged', async () => {
      tmpDir = createTempProject({}, { typescript: '^5.0.0' });
      const language = await detectLanguage(tmpDir);
      assert.strictEqual(language, 'typescript');
    });
  });
});
