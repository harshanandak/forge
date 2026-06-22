'use strict';

const { describe, expect, test } = require('bun:test');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

const TIMEOUT = 8000;

function makeBroker() {
  const driver = createBuiltinSQLiteDriver({ databasePath: ':memory:' });
  const projectRoot = path.join(process.cwd(), '.tmp-broker-reason');
  const broker = createLocalBroker({
    projectRoot,
    gitCommonDir: path.join(projectRoot, '.git'),
    databasePath: ':memory:',
    driver,
  });
  return { broker, driver };
}

describe('B4b/B4c — close --reason persists into the kernel event payload', () => {
  test(
    'close --reason=<text> (= form) writes reason into the issue.close event payload_json',
    async () => {
      const { broker, driver } = makeBroker();
      await broker.initialize();

      const context = { actor: 'tester', origin: 'cli' };
      await broker.runIssueOperation('create', ['--id', 'kap-x', '--title', 'X'], context);

      // The acceptance form: --reason="..." arrives as a single =-joined token.
      const result = await broker.runIssueOperation(
        'close',
        ['kap-x', '--reason=Merged and verified on master'],
        context,
      );
      expect(result.ok).toBe(true);

      // The reason must persist in the immutable event log (no kernel_issues column).
      const events = await driver.listKernelEvents('issue', 'kap-x', context, broker.config);
      const closeEvent = events.find(e => e.event_type === 'issue.close');
      expect(closeEvent).toBeDefined();
      const payload = JSON.parse(closeEvent.payload_json);
      expect(payload.reason).toBe('Merged and verified on master');
    },
    TIMEOUT,
  );

  test(
    'close --reason <text> (space form) also persists the reason',
    async () => {
      const { broker, driver } = makeBroker();
      await broker.initialize();
      const context = { actor: 'tester', origin: 'cli' };
      await broker.runIssueOperation('create', ['--id', 'kap-y', '--title', 'Y'], context);

      await broker.runIssueOperation('close', ['kap-y', '--reason', 'Done here'], context);

      const events = await driver.listKernelEvents('issue', 'kap-y', context, broker.config);
      const closeEvent = events.find(e => e.event_type === 'issue.close');
      const payload = JSON.parse(closeEvent.payload_json);
      expect(payload.reason).toBe('Done here');
    },
    TIMEOUT,
  );

  test(
    'close drives the issue to a terminal status regardless of reason',
    async () => {
      const { broker, driver } = makeBroker();
      await broker.initialize();
      const context = { actor: 'tester', origin: 'cli' };
      await broker.runIssueOperation('create', ['--id', 'kap-z', '--title', 'Z'], context);
      const result = await broker.runIssueOperation('close', ['kap-z', '--reason=x'], context);
      expect(result.ok).toBe(true);

      const issue = await driver.loadKernelEntity('issue', 'kap-z', context, broker.config);
      expect(issue.status).toBe('done');
    },
    TIMEOUT,
  );
});
