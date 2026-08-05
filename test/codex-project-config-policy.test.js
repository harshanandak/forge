'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const configPath = path.resolve(__dirname, '..', '.codex', 'config.toml');

describe('tracked Codex project configuration', () => {
  test('does not override user-owned approval or sandbox policy', () => {
    if (!fs.existsSync(configPath)) return;

    const config = fs.readFileSync(configPath, 'utf8');
    expect(config).not.toMatch(/^\s*(approval_policy|sandbox_mode)\s*=/m);
    expect(config).not.toMatch(/^\s*\[sandbox_workspace_write\]\s*$/m);
  });
});
