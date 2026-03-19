const fs = require('node:fs');
const path = require('node:path');
const { normalizeRepoPath } = require('./path-utils.js');

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

function isIdentifierStart(character) {
	return /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character) {
	return /[A-Za-z0-9_]/.test(character);
}

function extractSymbols(text) {
	const symbols = new Set();
	let searchIndex = 0;

	while (searchIndex < text.length) {
		const callIndex = text.indexOf('()', searchIndex);
		if (callIndex === -1) {
			break;
		}

		let startIndex = callIndex - 1;
		while (startIndex >= 0 && isIdentifierPart(text[startIndex])) {
			startIndex -= 1;
		}

		const symbol = text.slice(startIndex + 1, callIndex);
		if (symbol && isIdentifierStart(symbol[0])) {
			symbols.add(symbol);
		}

		searchIndex = callIndex + 2;
	}

	return Array.from(symbols);
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

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveRepositoryFile(repositoryRoot, filePath) {
	if (!repositoryRoot || !filePath || path.isAbsolute(filePath)) {
		return null;
	}

	const absoluteRoot = path.resolve(repositoryRoot);
	const absolutePath = path.resolve(absoluteRoot, filePath);
	const relativePath = path.relative(absoluteRoot, absolutePath);
	if (
		relativePath === ''
		|| relativePath.startsWith(`..${path.sep}`)
		|| relativePath === '..'
		|| path.isAbsolute(relativePath)
	) {
		return null;
	}

	return absolutePath;
}

function fileContainsSymbol(repositoryRoot, filePath, symbol) {
	const absolutePath = resolveRepositoryFile(repositoryRoot, filePath);
	if (!absolutePath) {
		return false;
	}

	if (!fs.existsSync(absolutePath)) {
		return false;
	}

	const content = fs.readFileSync(absolutePath, 'utf8');
	return new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(content);
}

function resolveMentionFiles(task, mention, repositoryRoot) {
	const files = task.files ?? [];
	if (files.length === 0) {
		return [];
	}

	if (!repositoryRoot) {
		return files.map((file) => normalizeRepoPath(file));
	}

	const matchingFiles = files
		.filter((file) => fileContainsSymbol(repositoryRoot, file, mention.symbol))
		.map((file) => normalizeRepoPath(file));
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

	return Array.from(contracts).sort((left, right) => left.localeCompare(right));
}

function isTaskHeader(line) {
	return line.startsWith('## Task ');
}

function parseTaskHeader(line) {
	if (!isTaskHeader(line)) {
		return null;
	}

	const prefixLength = '## Task '.length;
	const separatorIndex = line.indexOf(':', prefixLength);
	if (separatorIndex === -1) {
		return null;
	}

	const numberText = line.slice(prefixLength, separatorIndex).trim();
	if (!numberText || Array.from(numberText).some((character) => character < '0' || character > '9')) {
		return null;
	}

	const title = line.slice(separatorIndex + 1).trim();
	if (!title) {
		return null;
	}

	return {
		number: Number(numberText),
		title,
	};
}

function parseTaskField(currentTask, line, currentField) {
	if (line.startsWith('File(s):')) {
		currentTask.files = parseFilesLine(line.slice('File(s):'.length).trim());
		return null;
	}

	if (line.startsWith('What to implement:')) {
		currentTask.whatToImplement = line.slice('What to implement:'.length).trim();
		return 'whatToImplement';
	}

	if (line.startsWith('Expected output:')) {
		currentTask.expectedOutput = line.slice('Expected output:'.length).trim();
		return 'expectedOutput';
	}

	if (line === 'TDD steps:' || line === '---') {
		return null;
	}

	if (currentField && line.trim()) {
		currentTask[currentField] = `${currentTask[currentField]} ${line.trim()}`.trim();
	}

	return currentField;
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
		const taskHeader = parseTaskHeader(line);

		if (taskHeader) {
			flushTask(tasks, currentTask);
			currentTask = {
				number: taskHeader.number,
				title: taskHeader.title,
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

		currentField = parseTaskField(currentTask, line, currentField);
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
