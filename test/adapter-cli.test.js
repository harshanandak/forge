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
});
