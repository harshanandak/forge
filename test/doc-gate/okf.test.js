'use strict';

const { describe, expect, test, afterAll, setDefaultTimeout } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { generateBundle, linkAgentsMd } = require('../../lib/doc-gate/okf');

// Real git fixtures + parallel disk I/O can exceed the 5s default on Windows CI.
setDefaultTimeout(30000);

const createdDirs = [];
function git(dir, args) {
  execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
}

function makeDocsRepo(extra = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-okf-'));
  createdDirs.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(dir, 'docs', 'guides'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'intro.md'), '# Introduction\n\nWelcome to the project.\n');
  fs.writeFileSync(path.join(dir, 'docs', 'guides', 'setup.md'), '# Setup Guide\n\nInstall steps here.\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n\nRoot readme.\n');
  extra(dir);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const hasFrontMatter = text => /^---\r?\n/.test(text);
function frontMatterInner(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}
function walkFiles(root, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

describe('okf generateBundle', () => {
  test('every concept carries a type front-matter key and preserves the body', () => {
    const dir = makeDocsRepo();
    const res = generateBundle({ root: dir, source: 'docs', out: '.okf' });
    expect(res.ok).toBe(true);
    expect(res.okfVersion).toBe('0.1');

    const intro = read(dir, '.okf/intro.md');
    expect(frontMatterInner(intro)).toMatch(/^type:/m);
    expect(intro).toContain('# Introduction');
    expect(intro).toContain('Welcome to the project.');

    const setup = read(dir, '.okf/guides/setup.md');
    expect(frontMatterInner(setup)).toMatch(/type:/);
    expect(setup).toContain('Install steps here.');
  });

  test('README.md at repo root is NOT swept in when source is docs/', () => {
    const dir = makeDocsRepo();
    generateBundle({ root: dir, source: 'docs', out: '.okf' });
    expect(fs.existsSync(path.join(dir, '.okf', 'README.md'))).toBe(false);
  });

  test('root index.md is the ONLY index.md with frontmatter and carries okf_version "0.1"', () => {
    const dir = makeDocsRepo();
    generateBundle({ root: dir, source: 'docs', out: '.okf' });

    const rootIdx = read(dir, '.okf/index.md');
    expect(hasFrontMatter(rootIdx)).toBe(true);
    expect(rootIdx).toMatch(/okf_version:\s*"0\.1"/);
    expect(rootIdx).not.toMatch(/okf_version:\s*0\.1\s*$/m); // must be the STRING "0.1"

    const subIdx = read(dir, '.okf/guides/index.md');
    expect(hasFrontMatter(subIdx)).toBe(false);

    // Assert globally: exactly one index.md in the whole bundle has frontmatter.
    const indexes = walkFiles(path.join(dir, '.okf')).filter(f => f.endsWith('index.md'));
    const withFm = indexes.filter(f => hasFrontMatter(read(dir, path.posix.join('.okf', f))));
    expect(withFm).toEqual(['index.md']);
  });

  test('infers "guide" from path and defaults to "document"', () => {
    const dir = makeDocsRepo();
    generateBundle({ root: dir, source: 'docs', out: '.okf' });
    expect(frontMatterInner(read(dir, '.okf/guides/setup.md'))).toMatch(/type:\s*"guide"/);
    expect(frontMatterInner(read(dir, '.okf/intro.md'))).toMatch(/type:\s*"document"/);
  });

  test('merges into existing YAML frontmatter without duplicating the fence', () => {
    const dir = makeDocsRepo(d => {
      fs.writeFileSync(
        path.join(d, 'docs', 'faq.md'),
        '---\ndescription: Common questions\n---\n\n# FAQ\n\nQ and A here.\n',
      );
    });
    generateBundle({ root: dir, source: 'docs', out: '.okf' });
    const faq = read(dir, '.okf/faq.md');
    const fences = (faq.match(/^---\s*$/gm) || []).length;
    expect(fences).toBe(2); // exactly ONE frontmatter block
    expect(faq).toContain('description: Common questions'); // original key preserved
    expect(frontMatterInner(faq)).toMatch(/type:/); // required key injected
    expect(faq).toContain('Q and A here.'); // body preserved
  });

  test('auto source prefers docs/ when present', () => {
    const dir = makeDocsRepo();
    const res = generateBundle({ root: dir, out: '.okf' });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, '.okf', 'intro.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.okf', 'README.md'))).toBe(false);
  });

  test('refuses to write a concept through a symlink target', () => {
    const dir = makeDocsRepo();
    fs.mkdirSync(path.join(dir, '.okf'));
    let linked = true;
    try {
      fs.symlinkSync(path.join(os.tmpdir(), 'forge-okf-evil-concept'), path.join(dir, '.okf', 'intro.md'));
    } catch { linked = false; }
    if (!linked) return; // platform without symlink perms
    expect(() => generateBundle({ root: dir, source: 'docs', out: '.okf' })).toThrow(/symlink/i);
  });

  test('refuses a symlinked out dir', () => {
    const dir = makeDocsRepo();
    let linked = true;
    try { fs.symlinkSync(os.tmpdir(), path.join(dir, '.okf')); } catch { linked = false; }
    if (!linked) return;
    expect(() => generateBundle({ root: dir, source: 'docs', out: '.okf' })).toThrow(/symlink/i);
  });

  test('rejects blank source/out paths and a repo-root out dir', () => {
    const dir = makeDocsRepo();
    expect(() => generateBundle({ root: dir, source: '   ', out: '.okf' })).toThrow();
    expect(() => generateBundle({ root: dir, source: 'docs', out: '   ' })).toThrow();
    expect(() => generateBundle({ root: dir, source: 'docs', out: '.' })).toThrow(/root/i);
  });
});

describe('okf AGENTS.md overlay (linkAgentsMd)', () => {
  test('writes an idempotent managed nav block pointing at the bundle index', () => {
    const dir = makeDocsRepo();
    generateBundle({ root: dir, source: 'docs', out: '.okf' });

    linkAgentsMd({ root: dir, out: '.okf' });
    const first = read(dir, 'AGENTS.md');
    expect(first).toContain('.okf/index.md');
    expect((first.match(/BEGIN FORGE OKF NAV/g) || []).length).toBe(1);

    // Second run must not duplicate the block.
    linkAgentsMd({ root: dir, out: '.okf' });
    const second = read(dir, 'AGENTS.md');
    expect((second.match(/BEGIN FORGE OKF NAV/g) || []).length).toBe(1);
    expect(second).toBe(first);
  });

  test('preserves existing AGENTS.md content around the managed block', () => {
    const dir = makeDocsRepo();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n\nHand-written guidance.\n');
    generateBundle({ root: dir, source: 'docs', out: '.okf' });
    linkAgentsMd({ root: dir, out: '.okf' });
    const text = read(dir, 'AGENTS.md');
    expect(text).toContain('Hand-written guidance.');
    expect(text).toContain('.okf/index.md');
  });

  test('refuses to write AGENTS.md through a symlink', () => {
    const dir = makeDocsRepo();
    let linked = true;
    try {
      fs.symlinkSync(path.join(os.tmpdir(), 'forge-okf-evil-agents'), path.join(dir, 'AGENTS.md'));
    } catch { linked = false; }
    if (!linked) return;
    expect(() => linkAgentsMd({ root: dir, out: '.okf' })).toThrow(/symlink/i);
  });
});
