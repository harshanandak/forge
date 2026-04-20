#!/usr/bin/env node

const fs = require('node:fs');

const { analyzePhase3Dependencies } = require('../lib/dep-guard/analyzer.js');

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeListPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === 'object') {
    return [payload];
  }

	return [];
}

function normalizeSingleIssuePayload(payload) {
	if (Array.isArray(payload)) {
		return payload[0] ?? {};
	}

	if (payload && typeof payload === 'object') {
		return payload;
	}

	return {};
}

function readStdinPayload() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) {
    throw new Error('Expected JSON payload on stdin');
  }

  const payload = JSON.parse(raw);
  return {
    currentIssue: normalizeSingleIssuePayload(payload.currentIssue),
    openIssues: normalizeListPayload(payload.openIssues),
    inProgressIssues: normalizeListPayload(payload.inProgressIssues),
    taskFile: payload.taskFile,
    repositoryRoot: payload.repositoryRoot || process.cwd(),
  };
}

function main() {
  const args = process.argv.slice(2);
  let currentIssue;
  let openIssues;
  let taskFile;
  let repositoryRoot;

  if (args[0] === '--stdin') {
    const payload = readStdinPayload();
    currentIssue = payload.currentIssue;
    openIssues = [
      ...payload.openIssues,
      ...payload.inProgressIssues,
    ].filter((issue) => issue && issue.id && issue.id !== currentIssue.id);
    taskFile = payload.taskFile;
    repositoryRoot = payload.repositoryRoot;
  } else {
    const [
      currentIssueFile,
      openIssuesFile,
      inProgressIssuesFile,
      taskFileArg,
      repositoryRootArg = process.cwd(),
    ] = args;

    if (!currentIssueFile || !openIssuesFile || !inProgressIssuesFile || !taskFileArg) {
      throw new Error(
        'Usage: dep-guard-analyze.js <current-issue.json> <open-issues.json> <in-progress-issues.json> <task-file> [repository-root]',
      );
    }

    currentIssue = normalizeSingleIssuePayload(readJsonFile(currentIssueFile));
    openIssues = [
      ...normalizeListPayload(readJsonFile(openIssuesFile)),
      ...normalizeListPayload(readJsonFile(inProgressIssuesFile)),
    ].filter((issue) => issue && issue.id && issue.id !== currentIssue.id);
    taskFile = taskFileArg;
    repositoryRoot = repositoryRootArg;
  }

  const result = analyzePhase3Dependencies({
    currentIssue,
    openIssues,
    taskFile,
    repositoryRoot,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
