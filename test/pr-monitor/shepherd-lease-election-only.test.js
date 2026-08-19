'use strict';

const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lease = require('../../lib/pr-monitor/shepherd-lease');

let root;
afterEach(() => {
	if (root) fs.rmSync(root, { recursive: true, force: true });
	root = null;
});

describe('shepherd daemon election lease', () => {
	test('contains daemon election fields only and exposes no watcher mutation API', () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-election-'));
		const gitCommonDir = path.join(root, '.git');
		fs.mkdirSync(gitCommonDir);
		const result = lease.acquire(root, {
			gitCommonDir,
			pid: 123,
			isAlive: () => true,
			now: () => 0,
		});
		expect(result.ok).toBe(true);
		const payload = JSON.parse(fs.readFileSync(result.file, 'utf8'));
		expect(Object.keys(payload).sort()).toEqual(['heartbeatAt', 'pid', 'startedAt', 'token']);
		expect(lease.updateWatchers).toBeUndefined();
	});
});
