const fs = require('node:fs');
const path = require('node:path');
const { describe, expect, test } = require('bun:test');

const { ADOPTION_PROFILE_NAMES } = require('../lib/adoption-profiles');

describe('adoption profile docs', () => {
  test('template reference documents all shipped profiles', () => {
    const content = fs.readFileSync(path.join(__dirname, '..', 'docs', 'reference', 'TEMPLATES.md'), 'utf8');

    for (const profile of ADOPTION_PROFILE_NAMES) {
      expect(content).toContain(`\`${profile}\``);
    }
  });
});
