'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const { runIssueSubcommand } = require('../../lib/commands/_issue');

// Reliability truth (kernel d71a824b / eea2f9ce): a claim returning ok:true does NOT
// by itself prove the caller won the lease — a SAME-key duplicate replay also returns
// ok:true (echoing the current call's claim_id), and pre actor-identity fix a losing
// agent's claim collapsed to that duplicate. The `forge issue owns <id>` primitive is
// the authority: it reports OWNED iff the resolving actor holds the LIVE (active +
// unexpired) lease, so a worker must verify ownership before doing work rather than
// trusting the claim result. See skills/claim-safety/SKILL.md.
describe('forge issue owns — lease ownership verification', () => {
  let tmpDir;
  let driver;
  let broker;
  let config;
  const now = '2026-06-20T00:00:00.000Z';

  async function createIssue(id, title = id) {
    return broker.runIssueOperation(
      'create',
      ['--id', id, '--title', title, '--type', 'task'],
      { now, actor: 'tester' },
    );
  }

  async function claim(id, actor, at = now) {
    return broker.runIssueOperation('claim', ['--issue', id], { now: at, actor });
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-owns-'));
    const dbPath = path.join(tmpDir, 'kernel.sqlite');
    config = { databasePath: dbPath };
    driver = createBuiltinSQLiteDriver({});
    broker = createLocalBroker({
      projectRoot: tmpDir,
      execFileSync: () => path.join(tmpDir, '.git'),
      databasePath: dbPath,
      driver,
    });
    await broker.initialize();
  });

  afterEach(() => {
    if (driver) driver.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('A wins the lease; owns reports OWNED for A and NON-OWNED for the loser B (driver level)', async () => {
    await createIssue('own-1', 'Contended');
    const a = await claim('own-1', 'forge-a');
    expect(a.ok).toBe(true);
    // With distinct actors (post actor-identity fix) B's second claim is a genuine
    // conflict; even if it had duplicate-collapsed to ok:true, owns — not the claim
    // result — is what decides ownership.
    await claim('own-1', 'forge-b', '2026-06-20T00:01:00.000Z');

    const asA = await driver.issueOperation('owns', ['own-1'], { now, actor: 'forge-a' }, config);
    expect(asA.ok).toBe(true);
    expect(asA.command).toBe('issue.owns');
    expect(asA.data.owned).toBe(true);
    expect(asA.data.claimed_by).toBe('forge-a');

    const asB = await driver.issueOperation('owns', ['own-1'], { now, actor: 'forge-b' }, config);
    expect(asB.ok).toBe(true);
    expect(asB.data.owned).toBe(false);
    expect(asB.data.claimed_by).toBe('forge-a');
  });

  test('CLI: owns exits 0 for the lease holder and non-zero for a non-owner', async () => {
    await createIssue('own-2', 'Contended');
    await claim('own-2', 'forge-a');

    const opts = { issueBackend: 'kernel', kernelBroker: broker };
    const ownedA = await runIssueSubcommand('owns', ['own-2'], tmpDir, {
      ...opts,
      env: { FORGE_ACTOR: 'forge-a' },
    });
    expect(ownedA.success).toBe(true);

    const ownedB = await runIssueSubcommand('owns', ['own-2'], tmpDir, {
      ...opts,
      env: { FORGE_ACTOR: 'forge-b' },
    });
    expect(ownedB.success).toBe(false);
    expect(ownedB.exitCode).toBeGreaterThan(0);
    expect(ownedB.error).toContain('own-2');
  });

  test('owns treats an expired lease as NON-OWNED even for the original holder', async () => {
    await createIssue('own-3', 'Expiring');
    // Insert a claim with a fixed expires_at directly (the CLI expiry flag is out of
    // scope for this primitive) so the expiry branch is exercised deterministically.
    await driver.exec(
      'INSERT INTO kernel_claims (id, issue_id, actor, state, claimed_at, expires_at) VALUES '
        + "('c-own-3', 'own-3', 'forge-a', 'active', '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:30.000Z');",
      config,
    );

    const before = await driver.issueOperation(
      'owns', ['own-3'], { now: '2026-06-20T00:00:10.000Z', actor: 'forge-a' }, config,
    );
    expect(before.data.owned).toBe(true);
    expect(before.data.expired).toBe(false);

    const after = await driver.issueOperation(
      'owns', ['own-3'], { now: '2026-06-20T00:01:00.000Z', actor: 'forge-a' }, config,
    );
    expect(after.data.owned).toBe(false);
    expect(after.data.expired).toBe(true);
  });

  test('owns on an unknown issue is a not-found error', async () => {
    const missing = await driver.issueOperation('owns', ['nope'], { now, actor: 'forge-a' }, config);
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe('FORGE_ISSUE_NOT_FOUND');
    expect(missing.error.exit_code).toBe(3);
  });
});
