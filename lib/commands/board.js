'use strict';

const { readBeadsSnapshot } = require('../status/beads-snapshot');
const { buildBoardJson, formatBoard } = require('../status/presenter');
const { detectRepoContext } = require('./status');

function hasJsonFlag(args = [], flags = {}) {
	return flags.json === true || flags['--json'] === true || args.includes('--json');
}

function getFlagValue(args, dashedName, camelName) {
	const inlineDashed = args.find(arg => typeof arg === 'string' && arg.startsWith(`${dashedName}=`));
	if (inlineDashed) {
		return inlineDashed.slice(dashedName.length + 1);
	}
	const inlineCamel = args.find(arg => typeof arg === 'string' && arg.startsWith(`${camelName}=`));
	if (inlineCamel) {
		return inlineCamel.slice(camelName.length + 1);
	}
	const dashedIndex = args.indexOf(dashedName);
	if (dashedIndex !== -1 && dashedIndex + 1 < args.length) {
		return args[dashedIndex + 1];
	}
	const camelIndex = args.indexOf(camelName);
	if (camelIndex !== -1 && camelIndex + 1 < args.length) {
		return args[camelIndex + 1];
	}
	return null;
}

async function handler(args = [], flags = {}, projectRoot = process.cwd()) {
	const context = detectRepoContext(projectRoot);
	const snapshot = readBeadsSnapshot(projectRoot, {
		now: flags.now || flags['--now'] || getFlagValue(args, '--now', '--now'),
		staleAfterDays: flags.staleAfterDays || flags['--stale-after-days'] || flags['--staleAfterDays'] || getFlagValue(args, '--stale-after-days', '--staleAfterDays'),
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
	getFlagValue,
	hasJsonFlag,
};
