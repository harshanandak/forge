const { describe, test, expect } = require('bun:test');

const {
  checkGhAuth,
  validateToken,
  saveSecret,
  setupPAT
} = require('../lib/pat-setup');

// ---------------------------------------------------------------------------
// checkGhAuth
// ---------------------------------------------------------------------------
describe('checkGhAuth', () => {
  test('returns authenticated true with user when gh auth succeeds', () => {
    const mockExec = (_cmd, _args, _opts) => {
      return Buffer.from('Logged in to github.com account testuser (keyring)');
    };
    const result = checkGhAuth({ _exec: mockExec });
    expect(result.authenticated).toBe(true);
    expect(result.user).toBe('testuser');
  });

  test('returns authenticated false when gh auth throws', () => {
    const mockExec = (_cmd, _args, _opts) => {
      const err = new Error('not logged in');
      err.status = 1;
      err.stderr = Buffer.from('You are not logged into any GitHub hosts.');
      throw err;
    };
    const result = checkGhAuth({ _exec: mockExec });
    expect(result.authenticated).toBe(false);
    expect(result.user).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateToken
// ---------------------------------------------------------------------------
describe('validateToken', () => {
  test('accepts valid ghp_ token', () => {
    const result = validateToken('ghp_abc123def456');
    expect(result.valid).toBe(true);
  });

  test('accepts valid github_pat_ token', () => {
    const result = validateToken('github_pat_abc123def456');
    expect(result.valid).toBe(true);
  });

  test('rejects empty string', () => {
    const result = validateToken('');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  test('rejects undefined', () => {
    const result = validateToken(undefined);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  test('rejects token with wrong prefix', () => {
    const result = validateToken('gho_somethingelse');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  test('rejects token that is just the prefix with no body', () => {
    const result = validateToken('ghp_');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// saveSecret
// ---------------------------------------------------------------------------
describe('saveSecret', () => {
  test('returns success true when gh secret set succeeds', () => {
    const mockExec = (cmd, args, opts) => {
      // Verify token is passed via input, not as a CLI argument
      expect(opts.input).toBeDefined();
      expect(args).toContain('BEADS_SYNC_TOKEN');
      return Buffer.from('');
    };
    const result = saveSecret('BEADS_SYNC_TOKEN', 'ghp_testtoken123', { _exec: mockExec });
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
  });

  test('returns success false with error when gh secret set fails', () => {
    const mockExec = (_cmd, _args, _opts) => {
      const err = new Error('failed to set secret');
      err.stderr = Buffer.from('HTTP 403: Resource not accessible by integration');
      throw err;
    };
    const result = saveSecret('BEADS_SYNC_TOKEN', 'ghp_testtoken123', { _exec: mockExec });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// setupPAT — non-interactive mode
// ---------------------------------------------------------------------------
describe('setupPAT', () => {
  test('non-interactive mode skips PAT setup and returns method skipped', () => {
    const result = setupPAT('/fake/root', { interactive: false });
    expect(result.success).toBe(false);
    expect(result.method).toBe('skipped');
    expect(result.reminder).toBeDefined();
    expect(typeof result.reminder).toBe('string');
  });

  test('returns manual instructions when gh is not authenticated', () => {
    const mockExec = (_cmd, _args, _opts) => {
      const err = new Error('not logged in');
      err.status = 1;
      throw err;
    };
    const result = setupPAT('/fake/root', {
      interactive: true,
      _exec: mockExec,
      _prompt: () => 'ghp_testtoken123'
    });
    expect(result.success).toBe(false);
    expect(result.method).toBe('manual');
    expect(result.instructions).toBeDefined();
    expect(typeof result.instructions).toBe('string');
  });

  test('automated flow saves token and returns success', () => {
    const calls = [];
    const mockExec = (cmd, args, opts) => {
      calls.push({ cmd, args, input: opts?.input });
      // First call: gh auth status
      if (args && args.includes('status')) {
        return Buffer.from('Logged in to github.com account testuser (keyring)');
      }
      // Second call: gh secret set
      return Buffer.from('');
    };
    const result = setupPAT('/fake/root', {
      interactive: true,
      _exec: mockExec,
      _prompt: () => 'ghp_validtoken123'
    });
    expect(result.success).toBe(true);
    expect(result.method).toBe('automated');
    // Verify token was piped via input, not in args
    const secretCall = calls.find(c => c.args && c.args.includes('set'));
    expect(secretCall).toBeDefined();
    expect(secretCall.input).toBe('ghp_validtoken123');
  });

  test('automated flow returns error when token is invalid', () => {
    const mockExec = (cmd, args, _opts) => {
      if (args && args.includes('status')) {
        return Buffer.from('Logged in to github.com account testuser (keyring)');
      }
      return Buffer.from('');
    };
    const result = setupPAT('/fake/root', {
      interactive: true,
      _exec: mockExec,
      _prompt: () => 'invalid_token'
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
