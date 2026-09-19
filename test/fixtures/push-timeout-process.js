'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { createProcessTree } = require('../../scripts/process-tree');

const processTree = createProcessTree({
	env: process.env,
	platform: process.platform,
	getProcessIdentity: pid => `test:${pid}`,
});
const reservation = processTree.reserveChild({ kind: 'push-timeout-descendant' });
if (!reservation) throw new Error('timeout fixture could not reserve its descendant');

const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
	detached: true,
	stdio: 'ignore',
	env: processTree.envFor(process.env),
	windowsHide: true,
});
fs.writeFileSync(process.env.FORGE_PUSH_TIMEOUT_PID_FILE, JSON.stringify({
	supervisorPid: process.pid,
	descendantPid: descendant.pid,
	registered: false,
}));
if (!processTree.registerChild(reservation, descendant)) {
	processTree.abortChild(reservation, descendant);
	throw new Error('timeout fixture could not register its descendant');
}

fs.writeFileSync(process.env.FORGE_PUSH_TIMEOUT_PID_FILE, JSON.stringify({
	supervisorPid: process.pid,
	descendantPid: descendant.pid,
	registered: true,
}));
setInterval(() => {}, 1000);
