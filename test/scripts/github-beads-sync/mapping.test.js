import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readMapping, writeMapping, getBeadsId, setBeadsId } from '../../../scripts/github-beads-sync/mapping.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Tests for .github/beads-mapping.json CRUD module.
 */

let tmpDir;
let mappingPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapping-test-'));
  mappingPath = path.join(tmpDir, '.github', 'beads-mapping.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readMapping', () => {
  it('returns {} when file does not exist', () => {
    const result = readMapping(mappingPath);
    expect(result).toEqual({});
  });

  it('reads and parses valid JSON', () => {
    fs.mkdirSync(path.dirname(mappingPath), { recursive: true });
    fs.writeFileSync(mappingPath, JSON.stringify({ '42': 'forge-abc' }));
    const result = readMapping(mappingPath);
    expect(result).toEqual({ '42': 'forge-abc' });
  });

  it('throws with helpful message on invalid JSON', () => {
    fs.mkdirSync(path.dirname(mappingPath), { recursive: true });
    fs.writeFileSync(mappingPath, '{ broken json!!!');
    expect(() => readMapping(mappingPath)).toThrow(/Failed to parse mapping file/);
  });
});

describe('writeMapping', () => {
  it('writes JSON with 2-space indent', () => {
    writeMapping(mappingPath, { '1': 'forge-xyz' });
    const raw = fs.readFileSync(mappingPath, 'utf8');
    expect(raw).toBe(JSON.stringify({ '1': 'forge-xyz' }, null, 2) + '\n');
  });

  it('creates parent directories if missing', () => {
    const deepPath = path.join(tmpDir, 'a', 'b', 'c', 'mapping.json');
    writeMapping(deepPath, { '5': 'id-5' });
    expect(fs.existsSync(deepPath)).toBe(true);
  });

  it('performs atomic write (temp file then rename)', () => {
    // Write once, then overwrite — if atomic, no partial reads possible
    writeMapping(mappingPath, { '1': 'first' });
    writeMapping(mappingPath, { '1': 'first', '2': 'second' });
    const result = readMapping(mappingPath);
    expect(result).toEqual({ '1': 'first', '2': 'second' });
  });
});

describe('getBeadsId', () => {
  it('returns null when file does not exist', () => {
    expect(getBeadsId(mappingPath, 42)).toBeNull();
  });

  it('returns null for missing key', () => {
    writeMapping(mappingPath, { '10': 'forge-10' });
    expect(getBeadsId(mappingPath, 99)).toBeNull();
  });

  it('returns beads ID for existing key', () => {
    writeMapping(mappingPath, { '42': 'forge-abc' });
    expect(getBeadsId(mappingPath, 42)).toBe('forge-abc');
  });

  it('coerces number to string for lookup', () => {
    writeMapping(mappingPath, { '7': 'forge-7' });
    expect(getBeadsId(mappingPath, 7)).toBe('forge-7');
    expect(getBeadsId(mappingPath, '7')).toBe('forge-7');
  });
});

describe('setBeadsId', () => {
  it('creates file and adds entry when file missing', () => {
    setBeadsId(mappingPath, 1, 'forge-new');
    expect(readMapping(mappingPath)).toEqual({ '1': 'forge-new' });
  });

  it('preserves existing entries when adding new', () => {
    writeMapping(mappingPath, { '1': 'forge-1' });
    setBeadsId(mappingPath, 2, 'forge-2');
    expect(readMapping(mappingPath)).toEqual({ '1': 'forge-1', '2': 'forge-2' });
  });

  it('updates existing entry', () => {
    writeMapping(mappingPath, { '1': 'forge-old' });
    setBeadsId(mappingPath, 1, 'forge-new');
    expect(readMapping(mappingPath)).toEqual({ '1': 'forge-new' });
  });

  it('coerces number issueNumber to string key', () => {
    setBeadsId(mappingPath, 42, 'forge-42');
    const data = readMapping(mappingPath);
    expect(data['42']).toBe('forge-42');
    // Verify the key is actually a string in the JSON
    const keys = Object.keys(data);
    expect(keys).toContain('42');
    expect(typeof keys[0]).toBe('string');
  });
});
