const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const newCommand = require('../lib/commands/new');
const adapterCommand = require('../lib/commands/adapter');

function makeProjectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-adapter-cli-'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Test project\n');
  return root;
}

describe('adapter CLI commands', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeProjectRoot();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test('forge new adapter scaffolds a review adapter starter', async () => {
    const result = await newCommand.handler(
      ['adapter', 'coderabbit', '--kind=review', '--template=greptile'],
      {},
      projectRoot
    );

    const adapterPath = path.join(projectRoot, '.forge', 'adapters', 'review', 'coderabbit.js');
    expect(result.success).toBe(true);
    expect(result.output).toContain('.forge/adapters/review/coderabbit.js');
    expect(fs.existsSync(adapterPath)).toBe(true);
    expect(fs.readFileSync(adapterPath, 'utf8')).toContain('class CoderabbitReviewAdapter');
  });

  test('generated review adapter loads and fails closed until parse is implemented', async () => {
    await newCommand.handler(
      ['adapter', 'coderabbit', '--kind=review', '--template=greptile'],
      {},
      projectRoot
    );
    const fixturePath = path.join(projectRoot, 'empty-fixture.json');
    fs.writeFileSync(fixturePath, JSON.stringify({ input: [], expect: { threads: 0 } }));

    const result = await adapterCommand.handler(
      ['test', 'coderabbit', `--fixture=${fixturePath}`],
      {},
      projectRoot
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('parse must normalize provider payloads');
  });

  test('rejects unsafe adapter names before composing paths', async () => {
    const result = await newCommand.handler(
      ['adapter', '../escape', '--kind=review', '--template=greptile'],
      {},
      projectRoot
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Adapter name must start');
    expect(fs.existsSync(path.join(projectRoot, '.forge', 'adapters', 'escape.js'))).toBe(false);
  });

  test('rejects adapter names that cannot produce valid class names', async () => {
    const result = await newCommand.handler(
      ['adapter', '123', '--kind=review', '--template=greptile'],
      {},
      projectRoot
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Adapter name must start');
  });

  test('rejects local adapters that collide with the built-in Greptile adapter', async () => {
    const result = await newCommand.handler(
      ['adapter', 'greptile', '--kind=review', '--template=greptile'],
      {},
      projectRoot
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('reserved');
  });

  test('does not treat the next flag as a missing option value', async () => {
    const result = await newCommand.handler(
      ['adapter', 'coderabbit', '--kind', '--template=greptile'],
      {},
      projectRoot
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Only --kind=review');
  });

  test('forge adapter test replays a Greptile fixture offline', async () => {
    const fixturePath = path.join(projectRoot, 'greptile-fixture.json');
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({
        input: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: 'thread-1',
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            databaseId: 55,
                            path: 'README.md',
                            line: 3,
                            author: { login: 'greptile-apps[bot]' },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
        expect: { threads: 1 },
      })
    );

    const result = await adapterCommand.handler(
      ['test', 'greptile', `--fixture=${fixturePath}`],
      {},
      projectRoot
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Adapter greptile fixture replay passed');
    expect(result.output).toContain('1 parsed thread');
  });

  test('forge adapter test returns structured errors for invalid fixtures', async () => {
    const fixturePath = path.join(projectRoot, 'invalid-fixture.json');
    fs.writeFileSync(fixturePath, '{not-json');

    const result = await adapterCommand.handler(
      ['test', 'greptile', `--fixture=${fixturePath}`],
      {},
      projectRoot
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Fixture replay failed');
  });

  test('forge adapter test awaits async adapter scoring', async () => {
    const adapterDir = path.join(projectRoot, '.forge', 'adapters', 'review');
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.writeFileSync(
      path.join(adapterDir, 'async-score.js'),
      `'use strict';
module.exports = {
  id: 'async-score',
  kind: 'review',
  async fetchThreads() {},
  parse(payload) {
    return payload.map((thread, index) => ({
      id: String(index),
      commentId: index,
      file: thread.file,
      line: thread.line,
      body: '',
      author: 'fixture',
      isResolved: false,
      raw: thread,
    }));
  },
  async reply() {},
  async resolve() {},
  async score(threads) { return threads.map((thread) => ({ ...thread, resolved: true })); },
};
`
    );
    const fixturePath = path.join(projectRoot, 'async-fixture.json');
    fs.writeFileSync(fixturePath, JSON.stringify({ input: [{ file: 'README.md', line: 1 }], expect: { threads: 1 } }));

    const result = await adapterCommand.handler(
      ['test', 'async-score', `--fixture=${fixturePath}`],
      {},
      projectRoot
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('1 scored result');
  });

  test('forge adapter test preserves explicit falsy fixture input', async () => {
    const adapterDir = path.join(projectRoot, '.forge', 'adapters', 'review');
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.writeFileSync(
      path.join(adapterDir, 'falsy-input.js'),
      `'use strict';
module.exports = {
  id: 'falsy-input',
  kind: 'review',
  async fetchThreads() {},
  parse(payload) {
    return [{
      id: 'thread-1',
      commentId: 'comment-1',
      file: 'README.md',
      line: 1,
      body: String(payload),
      author: 'fixture',
      isResolved: false,
      raw: payload,
    }];
  },
  async reply() {},
  async resolve() {},
  score(threads) { return threads; },
};
`
    );
    const fixturePath = path.join(projectRoot, 'falsy-input-fixture.json');
    fs.writeFileSync(fixturePath, JSON.stringify({ input: false, expect: { threads: 1 } }));

    const result = await adapterCommand.handler(
      ['test', 'falsy-input', `--fixture=${fixturePath}`],
      {},
      projectRoot
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('1 parsed thread');
  });

  test('forge adapter test rejects non-array parse output', async () => {
    const adapterDir = path.join(projectRoot, '.forge', 'adapters', 'review');
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.writeFileSync(
      path.join(adapterDir, 'bad-parse.js'),
      `'use strict';
module.exports = {
  id: 'bad-parse',
  kind: 'review',
  async fetchThreads() {},
  parse() { return { file: 'README.md' }; },
  async reply() {},
  async resolve() {},
  score() { return []; },
};
`
    );
    const fixturePath = path.join(projectRoot, 'bad-parse-fixture.json');
    fs.writeFileSync(fixturePath, JSON.stringify({ input: [] }));

    const result = await adapterCommand.handler(['test', 'bad-parse', `--fixture=${fixturePath}`], {}, projectRoot);

    expect(result.success).toBe(false);
    expect(result.error).toContain('parse must return an array');
  });

  test('forge adapter test rejects non-array score output', async () => {
    const adapterDir = path.join(projectRoot, '.forge', 'adapters', 'review');
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.writeFileSync(
      path.join(adapterDir, 'bad-score.js'),
      `'use strict';
module.exports = {
  id: 'bad-score',
  kind: 'review',
  async fetchThreads() {},
  parse(payload) {
    return payload.map((thread, index) => ({
      id: String(index),
      commentId: index,
      file: thread.file,
      line: thread.line,
      body: '',
      author: 'fixture',
      isResolved: false,
      raw: thread,
    }));
  },
  async reply() {},
  async resolve() {},
  score() { return { resolved: true }; },
};
`
    );
    const fixturePath = path.join(projectRoot, 'bad-score-fixture.json');
    fs.writeFileSync(fixturePath, JSON.stringify({ input: [{ file: 'README.md', line: 1 }] }));

    const result = await adapterCommand.handler(['test', 'bad-score', `--fixture=${fixturePath}`], {}, projectRoot);

    expect(result.success).toBe(false);
    expect(result.error).toContain('score must return an array');
  });

  test('forge adapter test rejects non-normalized parse output', async () => {
    const adapterDir = path.join(projectRoot, '.forge', 'adapters', 'review');
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.writeFileSync(
      path.join(adapterDir, 'raw-parse.js'),
      `'use strict';
module.exports = {
  id: 'raw-parse',
  kind: 'review',
  async fetchThreads() {},
  parse(payload) { return payload; },
  async reply() {},
  async resolve() {},
  score(threads) { return threads; },
};
`
    );
    const fixturePath = path.join(projectRoot, 'raw-parse-fixture.json');
    fs.writeFileSync(fixturePath, JSON.stringify({ input: [{ file: 'README.md', line: 1 }] }));

    const result = await adapterCommand.handler(['test', 'raw-parse', `--fixture=${fixturePath}`], {}, projectRoot);

    expect(result.success).toBe(false);
    expect(result.error).toContain('normalized review threads');
  });

  test('forge adapter list returns deterministic adapter order', async () => {
    await newCommand.handler(
      ['adapter', 'zeta', '--kind=review', '--template=greptile'],
      {},
      projectRoot
    );
    await newCommand.handler(
      ['adapter', 'alpha', '--kind=review', '--template=greptile'],
      {},
      projectRoot
    );

    const result = await adapterCommand.handler(['list'], {}, projectRoot);

    expect(result.success).toBe(true);
    expect(result.output.trim().split('\n')).toEqual(['alpha', 'greptile', 'zeta']);
  });

  test('forge adapter enable preserves existing adapter settings', async () => {
    const configDir = path.join(projectRoot, '.forge');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'adapters.json'),
      JSON.stringify({ review: { coderabbit: { provider: 'api', enabled: false } } })
    );

    const result = await adapterCommand.handler(['enable', 'coderabbit'], {}, projectRoot);
    const config = JSON.parse(fs.readFileSync(path.join(configDir, 'adapters.json'), 'utf8'));

    expect(result.success).toBe(true);
    expect(config.review.coderabbit).toEqual({ provider: 'api', enabled: true });
  });

  test('forge adapter enable returns structured errors for invalid config JSON', async () => {
    const configDir = path.join(projectRoot, '.forge');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'adapters.json'), '{not-json');

    const result = await adapterCommand.handler(['enable', 'coderabbit'], {}, projectRoot);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to update adapter config');
  });

  test('forge adapter enable replaces non-object config roots', async () => {
    const configDir = path.join(projectRoot, '.forge');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'adapters.json'), '[]');

    const result = await adapterCommand.handler(['enable', 'coderabbit'], {}, projectRoot);
    const config = JSON.parse(fs.readFileSync(path.join(configDir, 'adapters.json'), 'utf8'));

    expect(result.success).toBe(true);
    expect(config).toEqual({ review: { coderabbit: { enabled: true } } });
  });

  test('forge adapter enable rejects invalid adapter names before writing config', async () => {
    const result = await adapterCommand.handler(['enable', '__proto__'], {}, projectRoot);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Adapter name must start');
    expect(fs.existsSync(path.join(projectRoot, '.forge', 'adapters.json'))).toBe(false);
  });
});
