'use strict';

const { describe, it, expect } = require('bun:test');
const { validateOwnership } = require('../lib/task-ownership');

describe('validateOwnership', () => {
  it('parses single wave with no conflicts and returns valid', () => {
    const content = `## Wave 1

### Task 1: Create utils
**OWNS**: \`lib/utils.js\`

### Task 2: Create helpers
**OWNS**: \`lib/helpers.js\`
`;
    const result = validateOwnership(content);
    expect(result).toEqual({ valid: true, violations: [] });
  });

  it('detects duplicate file ownership within same wave', () => {
    const content = `## Wave 1

### Task 1: Create utils
**OWNS**: \`lib/utils.js\`

### Task 2: Also touches utils
**OWNS**: \`lib/utils.js\`
`;
    const result = validateOwnership(content);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toEqual({
      wave: 1,
      task1: 1,
      task2: 2,
      file: 'lib/utils.js',
    });
  });

  it('allows same file in different waves', () => {
    const content = `## Wave 1

### Task 1: Create utils
**OWNS**: \`lib/utils.js\`

## Wave 2

### Task 2: Refactor utils
**OWNS**: \`lib/utils.js\`
`;
    const result = validateOwnership(content);
    expect(result).toEqual({ valid: true, violations: [] });
  });

  it('handles tasks with multiple OWNS files', () => {
    const content = `## Wave 1

### Task 1: Create utils and helpers
**OWNS**: \`lib/utils.js\`, \`lib/helpers.js\`

### Task 2: Create config and helpers
**OWNS**: \`lib/config.js\`, \`lib/helpers.js\`
`;
    const result = validateOwnership(content);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toEqual({
      wave: 1,
      task1: 1,
      task2: 2,
      file: 'lib/helpers.js',
    });
  });

  it('handles missing OWNS line by skipping task without error', () => {
    const content = `## Wave 1

### Task 1: Create utils
**OWNS**: \`lib/utils.js\`

### Task 2: Documentation only
Some description without OWNS line.

### Task 3: Also utils
**OWNS**: \`lib/utils.js\`
`;
    const result = validateOwnership(content);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toEqual({
      wave: 1,
      task1: 1,
      task2: 3,
      file: 'lib/utils.js',
    });
  });

  it('returns all violations not just the first', () => {
    const content = `## Wave 1

### Task 1: Create A and B
**OWNS**: \`lib/a.js\`, \`lib/b.js\`

### Task 2: Also A
**OWNS**: \`lib/a.js\`

### Task 3: Also B
**OWNS**: \`lib/b.js\`
`;
    const result = validateOwnership(content);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations).toContainEqual({
      wave: 1,
      task1: 1,
      task2: 2,
      file: 'lib/a.js',
    });
    expect(result.violations).toContainEqual({
      wave: 1,
      task1: 1,
      task2: 3,
      file: 'lib/b.js',
    });
  });

  it('exports validateOwnership as a function', () => {
    expect(typeof validateOwnership).toBe('function');
  });
});
