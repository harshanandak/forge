const { describe, expect, test } = require('bun:test');
const os = require('node:os');
const path = require('node:path');

describe('local Kernel broker contract', () => {
	test('keys the local broker by git common-dir instead of worktree path', () => {
		const {
			buildLocalBrokerConfig,
			resolveGitCommonDir,
		} = require('../../lib/kernel/broker');
		const projectRoot = path.join(os.tmpdir(), 'forge-worktree');
		const calls = [];

		const commonDir = resolveGitCommonDir(projectRoot, {
			execFileSync: (command, args, options) => {
				calls.push({ command, args, options });
				return `.git${os.EOL}`;
			},
		});
		const config = buildLocalBrokerConfig({ projectRoot, gitCommonDir: commonDir });

		expect(commonDir).toBe(path.resolve(projectRoot, '.git'));
		expect(config.gitCommonDir).toBe(commonDir);
		expect(config.databasePath).toBe(path.join(commonDir, 'forge', 'kernel.sqlite'));
		expect(config.databasePath).not.toContain(`${path.sep}.beads${path.sep}`);
		expect(calls).toEqual([{
			command: 'git',
			args: ['-C', projectRoot, 'rev-parse', '--git-common-dir'],
			// Bounded timeout so a pathological Windows git hang fails fast instead
			// of wedging broker init (issue ba388d01). 30s tolerates a legitimately
			// slow git on a loaded CI runner while still capping a true wedge.
			options: { encoding: 'utf8', timeout: 30000 },
		}]);
	});

	test('resolveGitCommonDir falls back to <projectRoot>/.git when git times out (ETIMEDOUT is non-fatal)', () => {
		const { resolveGitCommonDir } = require('../../lib/kernel/broker');
		const projectRoot = path.join(os.tmpdir(), 'forge-slow-git');
		const warnings = [];

		// Simulate the slow-CI git that exceeds the wall-clock bound: execFileSync
		// throws an ETIMEDOUT error. This must NOT propagate — it would crash
		// `forge remember` and every store-touching command.
		const commonDir = resolveGitCommonDir(projectRoot, {
			execFileSync: () => {
				const error = new Error('spawnSync git ETIMEDOUT');
				error.code = 'ETIMEDOUT';
				throw error;
			},
			warn: (message) => warnings.push(message),
		});

		expect(commonDir).toBe(path.resolve(projectRoot, '.git'));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('ETIMEDOUT');
	});

	test('resolveGitCommonDir falls back gracefully on a non-timeout git failure', () => {
		const { resolveGitCommonDir } = require('../../lib/kernel/broker');
		const projectRoot = path.join(os.tmpdir(), 'forge-broken-git');

		const commonDir = resolveGitCommonDir(projectRoot, {
			execFileSync: () => {
				throw new Error('git: command not found');
			},
			warn: () => {},
		});

		expect(commonDir).toBe(path.resolve(projectRoot, '.git'));
	});

	test('resolveGitCommonDir falls back when git returns an empty path instead of throwing', () => {
		const { resolveGitCommonDir } = require('../../lib/kernel/broker');
		const projectRoot = path.join(os.tmpdir(), 'forge-empty-git');

		const commonDir = resolveGitCommonDir(projectRoot, {
			execFileSync: () => '   \n',
			warn: () => {},
		});

		expect(commonDir).toBe(path.resolve(projectRoot, '.git'));
	});

	test('initializes SQLite-style WAL pragmas before applying Kernel migrations', async () => {
		const { createLocalBroker } = require('../../lib/kernel/broker');
		const projectRoot = path.join(os.tmpdir(), 'forge-worktree');
		const statements = [];

		const broker = createLocalBroker({
			projectRoot,
			execFileSync: () => path.join(projectRoot, '.git'),
			driver: {
				async exec(statement) {
					statements.push(statement);
				},
				// Empty ledger + no pre-existing columns → every migration applies.
				async queryAll() {
					return [];
				},
			},
		});

		const result = await broker.initialize();

		expect(result).toMatchObject({
			success: true,
			journalMode: 'WAL',
			synchronous: 'NORMAL',
			foreignKeys: true,
		});
		expect(statements.slice(0, 4)).toEqual([
			'PRAGMA journal_mode=WAL;',
			'PRAGMA synchronous=NORMAL;',
			'PRAGMA foreign_keys=ON;',
			'PRAGMA busy_timeout=5000;',
		]);
		expect(statements).toContain('CREATE TABLE IF NOT EXISTS kernel_issues (\n  id TEXT NOT NULL PRIMARY KEY,\n  title TEXT NOT NULL,\n  body TEXT,\n  type TEXT NOT NULL DEFAULT \'task\',\n  status TEXT NOT NULL DEFAULT \'open\',\n  priority TEXT NOT NULL DEFAULT \'P2\',\n  priority_rank INTEGER NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  entity_revision INTEGER NOT NULL DEFAULT 0,\n  parent_id TEXT REFERENCES kernel_issues(id),\n  sprint_id TEXT,\n  release_id TEXT,\n  stage_state TEXT,\n  labels TEXT,\n  acceptance_criteria TEXT,\n  estimate TEXT\n);');
	});

	test('exposes a testable issue-operation boundary without requiring a bundled sqlite dependency', async () => {
		const { createLocalBroker } = require('../../lib/kernel/broker');
		const calls = [];
		const broker = createLocalBroker({
			projectRoot: path.join(os.tmpdir(), 'forge-worktree'),
			gitCommonDir: path.join(os.tmpdir(), 'forge-common-dir'),
			driver: {
				async issueOperation(operation, args, context, brokerConfig) {
					calls.push({ operation, args, context, brokerConfig });
					return { success: true, operation, output: '[]' };
				},
			},
		});

		await expect(broker.runIssueOperation('list', ['--json'], { actor: 'tester' }))
			.resolves.toEqual({ success: true, operation: 'list', output: '[]' });
		expect(calls).toEqual([{
			operation: 'list',
			args: ['--json'],
			context: { actor: 'tester' },
			brokerConfig: expect.objectContaining({
				mode: 'local',
				journalMode: 'WAL',
			}),
		}]);
	});
});
