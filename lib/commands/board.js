'use strict';

const { readBeadsSnapshot } = require('../status/beads-snapshot');
const { buildBoardJson, formatBoard } = require('../status/presenter');
const { detectRepoContext } = require('./status');

function hasJsonFlag(args = [], flags = {}) {
	return flags.json === true || flags['--json'] === true || args.includes('--json');
}

async function handler(args = [], flags = {}, projectRoot = process.cwd()) {
	const context = detectRepoContext(projectRoot);
	const snapshot = readBeadsSnapshot(projectRoot, {
		now: flags.now,
		staleAfterDays: flags.staleAfterDays,
	});
	const payload = { context, snapshot };
	const output = hasJsonFlag(args, flags)
		? JSON.stringify(buildBoardJson(payload), null, 2)
		: formatBoard(payload);

	return {
		success: true,
		context,
		snapshot,
		output,
	};
}

module.exports = {
	name: 'board',
	description: 'Show a local team runtime board from Beads state',
	handler,
	hasJsonFlag,
};
