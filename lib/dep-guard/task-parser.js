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
	parseTaskFile,
};
