'use strict';

const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hooks = require('../../lib/commands/hooks');
const projectMemory = require('../../lib/project-memory');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const fixture = require('../fixtures/memory-recall-holdouts.json');

const roots = [];
const drivers = [];

afterEach(() => {
  while (drivers.length) drivers.pop().close();
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('project-local memory recall holdout', () => {
  test('foreign rows cannot crowd an unseen local memory out of additionalContext', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-holdout-'));
    roots.push(root);
    const commonDir = path.join(root, '.git');
    fs.mkdirSync(commonDir);
    const projectId = commonDir.replaceAll('\\', '/').toLowerCase();
    const store = createBuiltinSQLiteDriver({ databasePath: path.join(root, 'kernel.sqlite') });
    drivers.push(store);

    for (let index = 0; index < fixture.foreign.count; index += 1) {
      projectMemory.write(root, {
        key: `foreign-${index}`,
        value: `auth token ${'auth '.repeat(20)}`,
        sourceAgent: 'forge remember',
        scope: fixture.foreign.scope,
        tags: [],
      }, { store });
    }
    projectMemory.write(root, {
      key: fixture.projectLocal.memoryId,
      value: fixture.projectLocal.content,
      sourceAgent: 'forge remember',
      tags: [],
    }, { store });

    const result = await hooks.handler(
      ['memory-recall', '--harness', 'claude'],
      {},
      root,
      {
        railEnabled: () => true,
        readInput: () => JSON.stringify({
          session_id: 'holdout',
          prompt: fixture.projectLocal.prompt,
        }),
        search: (_root, query, limit, options) => projectMemory.searchRankedScored(
          root,
          query,
          limit,
          {
            ...options,
            store,
            gitCommonDir: commonDir,
            realpath: value => value,
            platform: 'win32',
          },
        ),
        loadSeen: () => [],
        saveSeen: () => {},
        appendShadow: () => {},
      },
    );

    const context = JSON.parse(result.output).hookSpecificOutput.additionalContext;
    expect(projectId).not.toBe(fixture.foreign.scope);
    expect(context).toContain(fixture.projectLocal.content);
    expect(context).not.toContain('foreign-');
  });
});
