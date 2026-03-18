const fs = require('node:fs');
const path = require('node:path');

function ensureTaskFile(taskFile) {
	if (!taskFile || typeof taskFile !== 'string') {
		throw new Error('Task file path is required');
	}

	const absolutePath = path.resolve(taskFile);
	if (!fs.existsSync(absolutePath)) {
		throw new Error(`Task file does not exist: ${absolutePath}`);
	}

	return absolutePath;
}

function parseFilesLine(value) {
	if (!value) {
		return [];
	}

	return value
		.split(',')
		.map((file) => file.replace(/`/g, '').trim())
		.filter(Boolean);
}

function flushTask(tasks, currentTask) {
	if (!currentTask) {
		return;
	}

	tasks.push({
		number: currentTask.number,
		title: currentTask.title,
		files: currentTask.files,
		whatToImplement: currentTask.whatToImplement.trim(),
		expectedOutput: currentTask.expectedOutput.trim(),
	});
}

function extractSymbols(text) {
	return Array.from(new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*\(\)/g) ?? []))
		.map((match) => match.slice(0, -2));
}

function detectContractType(symbol, annotation = '') {
	if (annotation === 'data-format' || annotation === 'command-contract' || annotation === 'return-shape') {
		return annotation;
	}

	if (/Schema$|Format$/i.test(symbol)) {
		return 'data-format';
	}

	if (/Contract$/i.test(symbol)) {
		return 'command-contract';
	}

	if (/Shape$/i.test(symbol)) {
		return 'return-shape';
	}

	return 'modified';
}

function extractContractMentions(text) {
	const mentions = new Map();
	for (const symbol of extractSymbols(text)) {
		mentions.set(symbol, {
			symbol,
			annotation: 'modified',
		});
	}

	for (const match of text.match(/\b[A-Za-z_][A-Za-z0-9_]*(?:Schema|Format|Contract|Shape)\b/g) ?? []) {
		if (mentions.has(match)) {
			continue;
		}

		mentions.set(match, {
			symbol: match,
			annotation: detectContractType(match),
		});
	}

	return Array.from(mentions.values());
}

function fileContainsSymbol(repositoryRoot, filePath, symbol) {
	if (!repositoryRoot) {
		return false;
	}

	const absolutePath = path.resolve(repositoryRoot, filePath);
	if (!fs.existsSync(absolutePath)) {
		return false;
	}

	const content = fs.readFileSync(absolutePath, 'utf8');
	return new RegExp(`\\b${symbol}\\b`).test(content);
}

function resolveMentionFiles(task, mention, repositoryRoot) {
	const files = task.files ?? [];
	if (files.length === 0) {
		return [];
	}

	if (files.length === 1) {
		return files;
	}

	const matchingFiles = files.filter((file) => fileContainsSymbol(repositoryRoot, file, mention.symbol));
	return matchingFiles;
}

function extractTaskContracts(taskContext, options = {}) {
	if (!taskContext || !Array.isArray(taskContext.tasks)) {
		return [];
	}

	const contracts = new Set();
	const repositoryRoot = options.repositoryRoot;

	for (const task of taskContext.tasks) {
		const mentions = extractContractMentions(task.whatToImplement ?? '');
		for (const mention of mentions) {
			for (const file of resolveMentionFiles(task, mention, repositoryRoot)) {
				contracts.add(`${file}:${mention.symbol}(${mention.annotation})`);
			}
		}
	}

	return Array.from(contracts).sort();
}

function parseTaskFile(taskFile) {
	const absolutePath = ensureTaskFile(taskFile);
	const content = fs.readFileSync(absolutePath, 'utf8');
	const lines = content.split(/\r?\n/);
	const tasks = [];
	let currentTask = null;
	let currentField = null;

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		const taskMatch = line.match(/^## Task (\d+):\s*(.+)$/);

		if (taskMatch) {
			flushTask(tasks, currentTask);
			currentTask = {
				number: Number(taskMatch[1]),
				title: taskMatch[2].trim(),
				files: [],
				whatToImplement: '',
				expectedOutput: '',
			};
			currentField = null;
			continue;
		}

		if (!currentTask) {
			continue;
		}

		if (line.startsWith('File(s):')) {
			currentTask.files = parseFilesLine(line.slice('File(s):'.length).trim());
			currentField = null;
			continue;
		}

		if (line.startsWith('What to implement:')) {
			currentTask.whatToImplement = line.slice('What to implement:'.length).trim();
			currentField = 'whatToImplement';
			continue;
		}

		if (line.startsWith('Expected output:')) {
			currentTask.expectedOutput = line.slice('Expected output:'.length).trim();
			currentField = 'expectedOutput';
			continue;
		}

		if (/^(TDD steps:|---)$/.test(line)) {
			currentField = null;
			continue;
		}

		if (currentField && line.trim()) {
			currentTask[currentField] = `${currentTask[currentField]} ${line.trim()}`.trim();
		}
	}

	flushTask(tasks, currentTask);

	return {
		path: absolutePath,
		taskCount: tasks.length,
		tasks,
	};
}

module.exports = {
	detectContractType,
	extractContractMentions,
	extractTaskContracts,
	parseTaskFile,
};
