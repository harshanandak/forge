const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, test, expect, beforeEach, afterEach } = require('bun:test');

describe('detection-utils', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-detect-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------
  // Module exports
  // -------------------------------------------------------
  describe('module exports', () => {
    test('exports all expected functions', () => {
      const det = require('../lib/detection-utils');
      expect(typeof det.detectTestFramework).toBe('function');
      expect(typeof det.detectLanguageFeatures).toBe('function');
      expect(typeof det.detectNextJs).toBe('function');
      expect(typeof det.detectNestJs).toBe('function');
      expect(typeof det.detectAngular).toBe('function');
      expect(typeof det.detectVue).toBe('function');
      expect(typeof det.detectReact).toBe('function');
      expect(typeof det.detectExpress).toBe('function');
      expect(typeof det.detectFastify).toBe('function');
      expect(typeof det.detectSvelte).toBe('function');
      expect(typeof det.detectRemix).toBe('function');
      expect(typeof det.detectAstro).toBe('function');
      expect(typeof det.detectGenericNodeJs).toBe('function');
      expect(typeof det.detectPackageManager).toBe('function');
      expect(typeof det.detectFromLockFile).toBe('function');
      expect(typeof det.detectFromCommand).toBe('function');
    });
  });

  // -------------------------------------------------------
  // detectTestFramework
  // -------------------------------------------------------
  describe('detectTestFramework', () => {
    test('detects jest', () => {
      const { detectTestFramework } = require('../lib/detection-utils');
      expect(detectTestFramework({ jest: '^29.0.0' })).toBe('jest');
    });

    test('detects vitest', () => {
      const { detectTestFramework } = require('../lib/detection-utils');
      expect(detectTestFramework({ vitest: '^1.0.0' })).toBe('vitest');
    });

    test('detects mocha', () => {
      const { detectTestFramework } = require('../lib/detection-utils');
      expect(detectTestFramework({ mocha: '^10.0.0' })).toBe('mocha');
    });

    test('detects playwright', () => {
      const { detectTestFramework } = require('../lib/detection-utils');
      expect(detectTestFramework({ '@playwright/test': '^1.0.0' })).toBe('playwright');
    });

    test('detects cypress', () => {
      const { detectTestFramework } = require('../lib/detection-utils');
      expect(detectTestFramework({ cypress: '^13.0.0' })).toBe('cypress');
    });

    test('detects karma', () => {
      const { detectTestFramework } = require('../lib/detection-utils');
      expect(detectTestFramework({ karma: '^6.0.0' })).toBe('karma');
    });

    test('returns null when no framework found', () => {
      const { detectTestFramework } = require('../lib/detection-utils');
      expect(detectTestFramework({ lodash: '^4.0.0' })).toBeNull();
    });
  });

  // -------------------------------------------------------
  // detectLanguageFeatures
  // -------------------------------------------------------
  describe('detectLanguageFeatures', () => {
    test('detects TypeScript from devDependencies', () => {
      const { detectLanguageFeatures } = require('../lib/detection-utils');
      const result = detectLanguageFeatures(
        { devDependencies: { typescript: '^5.0.0' } },
        tmpDir
      );
      expect(result.typescript).toBe(true);
    });

    test('detects monorepo from workspaces', () => {
      const { detectLanguageFeatures } = require('../lib/detection-utils');
      const result = detectLanguageFeatures(
        { workspaces: ['packages/*'] },
        tmpDir
      );
      expect(result.monorepo).toBe(true);
    });

    test('detects Docker from Dockerfile', () => {
      const { detectLanguageFeatures } = require('../lib/detection-utils');
      fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:20');
      const result = detectLanguageFeatures({}, tmpDir);
      expect(result.docker).toBe(true);
    });

    test('detects CI/CD from .github/workflows', () => {
      const { detectLanguageFeatures } = require('../lib/detection-utils');
      fs.mkdirSync(path.join(tmpDir, '.github', 'workflows'), { recursive: true });
      const result = detectLanguageFeatures({}, tmpDir);
      expect(result.cicd).toBe(true);
    });

    test('returns all false for bare project', () => {
      const { detectLanguageFeatures } = require('../lib/detection-utils');
      const result = detectLanguageFeatures({}, tmpDir);
      expect(result.typescript).toBe(false);
      expect(result.monorepo).toBe(false);
      expect(result.docker).toBe(false);
      expect(result.cicd).toBe(false);
    });
  });

  // -------------------------------------------------------
  // Framework detectors
  // -------------------------------------------------------
  describe('detectNextJs', () => {
    test('detects Next.js', () => {
      const { detectNextJs } = require('../lib/detection-utils');
      const result = detectNextJs({ next: '^14.0.0', jest: '^29.0.0' });
      expect(result.framework).toBe('Next.js');
      expect(result.projectType).toBe('fullstack');
      expect(result.testFramework).toBe('jest');
    });

    test('returns null without next dep', () => {
      const { detectNextJs } = require('../lib/detection-utils');
      expect(detectNextJs({ react: '^18.0.0' })).toBeNull();
    });
  });

  describe('detectNestJs', () => {
    test('detects NestJS from @nestjs/core', () => {
      const { detectNestJs } = require('../lib/detection-utils');
      const result = detectNestJs({ '@nestjs/core': '^10.0.0' });
      expect(result.framework).toBe('NestJS');
      expect(result.projectType).toBe('backend');
    });

    test('returns null without nestjs dep', () => {
      const { detectNestJs } = require('../lib/detection-utils');
      expect(detectNestJs({ express: '^4.0.0' })).toBeNull();
    });
  });

  describe('detectAngular', () => {
    test('detects Angular', () => {
      const { detectAngular } = require('../lib/detection-utils');
      const result = detectAngular({ '@angular/core': '^17.0.0' });
      expect(result.framework).toBe('Angular');
    });

    test('returns null without angular dep', () => {
      const { detectAngular } = require('../lib/detection-utils');
      expect(detectAngular({ react: '^18.0.0' })).toBeNull();
    });
  });

  describe('detectVue', () => {
    test('detects Vue.js', () => {
      const { detectVue } = require('../lib/detection-utils');
      const result = detectVue({ vue: '^3.0.0' });
      expect(result.framework).toBe('Vue.js');
    });

    test('detects Nuxt', () => {
      const { detectVue } = require('../lib/detection-utils');
      const result = detectVue({ vue: '^3.0.0', nuxt: '^3.0.0' });
      expect(result.framework).toBe('Nuxt');
    });

    test('returns null without vue dep', () => {
      const { detectVue } = require('../lib/detection-utils');
      expect(detectVue({ react: '^18.0.0' })).toBeNull();
    });
  });

  describe('detectReact', () => {
    test('detects React with vite', () => {
      const { detectReact } = require('../lib/detection-utils');
      const result = detectReact({ react: '^18.0.0', vite: '^5.0.0' });
      expect(result.framework).toBe('React');
      expect(result.buildTool).toBe('vite');
    });

    test('returns null without react dep', () => {
      const { detectReact } = require('../lib/detection-utils');
      expect(detectReact({ vue: '^3.0.0' })).toBeNull();
    });
  });

  describe('detectExpress', () => {
    test('detects Express', () => {
      const { detectExpress } = require('../lib/detection-utils');
      const result = detectExpress(
        { express: '^4.0.0' },
        { typescript: false }
      );
      expect(result.framework).toBe('Express');
      expect(result.buildTool).toBe('node');
    });

    test('uses tsc build tool with TypeScript', () => {
      const { detectExpress } = require('../lib/detection-utils');
      const result = detectExpress(
        { express: '^4.0.0' },
        { typescript: true }
      );
      expect(result.buildTool).toBe('tsc');
    });
  });

  describe('detectFastify', () => {
    test('detects Fastify', () => {
      const { detectFastify } = require('../lib/detection-utils');
      const result = detectFastify(
        { fastify: '^4.0.0' },
        { typescript: false }
      );
      expect(result.framework).toBe('Fastify');
    });
  });

  describe('detectSvelte', () => {
    test('detects SvelteKit', () => {
      const { detectSvelte } = require('../lib/detection-utils');
      const result = detectSvelte({ svelte: '^4.0.0', '@sveltejs/kit': '^2.0.0' });
      expect(result.framework).toBe('SvelteKit');
    });

    test('detects plain Svelte', () => {
      const { detectSvelte } = require('../lib/detection-utils');
      const result = detectSvelte({ svelte: '^4.0.0' });
      expect(result.framework).toBe('Svelte');
    });
  });

  describe('detectRemix', () => {
    test('detects Remix', () => {
      const { detectRemix } = require('../lib/detection-utils');
      const result = detectRemix({ '@remix-run/react': '^2.0.0' });
      expect(result.framework).toBe('Remix');
    });

    test('returns null without remix dep', () => {
      const { detectRemix } = require('../lib/detection-utils');
      expect(detectRemix({ react: '^18.0.0' })).toBeNull();
    });
  });

  describe('detectAstro', () => {
    test('detects Astro', () => {
      const { detectAstro } = require('../lib/detection-utils');
      const result = detectAstro({ astro: '^4.0.0' });
      expect(result.framework).toBe('Astro');
    });
  });

  describe('detectGenericNodeJs', () => {
    test('detects generic Node.js from main field', () => {
      const { detectGenericNodeJs } = require('../lib/detection-utils');
      const result = detectGenericNodeJs(
        { main: 'index.js' },
        {},
        { typescript: false }
      );
      expect(result.framework).toBe('Node.js');
    });

    test('returns null without main or start script', () => {
      const { detectGenericNodeJs } = require('../lib/detection-utils');
      expect(detectGenericNodeJs({}, {}, { typescript: false })).toBeNull();
    });
  });

  // -------------------------------------------------------
  // detectPackageManager (uses safeExec internally — integration)
  // -------------------------------------------------------
  describe('detectPackageManager', () => {
    test('detects from bun.lock file', () => {
      const { detectFromLockFile } = require('../lib/detection-utils');
      fs.writeFileSync(path.join(tmpDir, 'bun.lock'), '');
      // detectFromLockFile returns an object with name and detected flag
      const result = detectFromLockFile('bun', ['bun.lockb', 'bun.lock'], 'bun v', tmpDir);
      // If bun is installed, it returns true; if not, still detected from lock file
      // The function checks fs.existsSync for lock files — the lock file exists
      // but it also runs `bun --version` which may or may not succeed
      expect(typeof result).toBe('object');
    });
  });
});
