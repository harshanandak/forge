'use strict';

const { describe, expect, test, afterAll } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const docGate = require('../../lib/commands/doc-gate');
const { detect } = require('../../lib/doc-gate/detect');

const createdDirs = [];

function makeRustRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docgate-cmd-'));
  createdDirs.push(dir);
  const g = args => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  g(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'main.rs'), 'fn main() {}\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);
  return dir;
}

function makeNonGitDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docgate-nogit-'));
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('forge doc-gate command', () => {
  test('exposes the registry contract', () => {
    expect(docGate.name).toBe('doc-gate');
    expect(typeof docGate.description).toBe('string');
    expect(typeof docGate.handler).toBe('function');
  });

  test('detect (default subcommand) prints a human summary and exits 0', async () => {
    const repo = makeRustRepo();
    const res = await docGate.handler([], {}, repo, {});
    expect(res.success).toBe(true);
    expect(res.exitCode).toBeUndefined();
    expect(res.output).toContain('doc-gate detect');
    expect(res.output).toContain('verdict:');
    expect(res.output).toContain('source');
  });

  test('--json emits a structured object equal to the detector result', async () => {
    const repo = makeRustRepo();
    const res = await docGate.handler(['detect', '--json'], {}, repo, {});
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed.source.value).toEqual(['src']);
    expect(parsed.toolchain.value).toBe('cargo');
    expect(parsed).toEqual(detect(repo)); // thin-wrapper: CLI --json equals detect() exactly
  });

  test('--json also honored via parsed flags object', async () => {
    const repo = makeRustRepo();
    const res = await docGate.handler(['detect'], { json: true }, repo, {});
    expect(() => JSON.parse(res.output)).not.toThrow();
  });

  test('unknown subcommand is a real error (exit 1)', async () => {
    const repo = makeRustRepo();
    const res = await docGate.handler(['bogus'], {}, repo, {});
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.error).toContain('Unknown doc-gate subcommand');
  });

  test('non-git directory is a real error (exit 1)', async () => {
    const dir = makeNonGitDir();
    const res = await docGate.handler(['detect'], {}, dir, {});
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.error).toContain('git repository');
  });
});
