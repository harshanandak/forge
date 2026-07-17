'use strict';

const { describe, test, expect } = require('bun:test');

// buildHookVerdict is the PURE reporting/exit layer for git-hook enforcement (issue
// eda6d866). It maps the file-presence hook check (verifyHooksActive) PLUS the resolved
// config state (resolveHookEnforcementState) onto a human-facing { message, level,
// exitFailure } verdict. The bug it fixes: setup used to print "enforcement active" (or
// even fail loudly + exit 1) for a state the user DELIBERATELY chose by disabling the TDD
// gate. These cases pin the four honesty outcomes without spawning setup.
const setup = require('../lib/commands/setup');

const ACTIVE = { active: true, method: 'native' };
const INERT = { active: false, method: 'none', reason: 'no pre-commit hook installed' };
const ENABLED = { tddActive: true };
const DISABLED = { tddActive: false };

describe('buildHookVerdict (honest reporting/exit layer)', () => {
  test('hooks active + TDD enabled → "enforcement active", no failure exit', () => {
    const v = setup.buildHookVerdict(ACTIVE, ENABLED, { loud: true });
    expect(v.message).toContain('Git hook enforcement active');
    expect(v.message).toContain('(native)');
    expect(v.exitFailure).toBe(false);
  });

  test('hooks active + TDD disabled → inert message, no failure exit (the reported bug)', () => {
    const v = setup.buildHookVerdict(ACTIVE, DISABLED, { loud: true });
    expect(v.message).toContain('TDD gate disabled in .forge/config.yaml');
    expect(v.message).toContain('inert');
    expect(v.message).not.toContain('enforcement active');
    expect(v.exitFailure).toBe(false);
  });

  test('no hooks + TDD disabled + loud → info message, exitFailure FALSE (minimal setup must not exit 1)', () => {
    const v = setup.buildHookVerdict(INERT, DISABLED, { loud: true });
    expect(v.level).toBe('info');
    expect(v.message).toContain('disabled in .forge/config.yaml anyway');
    expect(v.message).not.toContain('TDD ENFORCEMENT IS NOT ACTIVE');
    expect(v.exitFailure).toBe(false);
  });

  test('no hooks + TDD enabled + loud → failure banner text, exitFailure TRUE (preserved behavior)', () => {
    const v = setup.buildHookVerdict(INERT, ENABLED, { loud: true });
    expect(v.level).toBe('error');
    expect(v.message).toContain('TDD ENFORCEMENT IS NOT ACTIVE');
    expect(v.exitFailure).toBe(true);
  });

  test('no hooks + TDD enabled + quiet → warn, exitFailure false', () => {
    const v = setup.buildHookVerdict(INERT, ENABLED, { loud: false });
    expect(v.level).toBe('warn');
    expect(v.message).toContain('NOT active');
    expect(v.exitFailure).toBe(false);
  });
});
