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

async function main() {
  const [
    currentIssueFile,
    openIssuesFile,
    inProgressIssuesFile,
    taskFile,
    repositoryRoot = process.cwd(),
  ] = process.argv.slice(2);

  if (!currentIssueFile || !openIssuesFile || !inProgressIssuesFile || !taskFile) {
    throw new Error(
      'Usage: dep-guard-analyze.js <current-issue.json> <open-issues.json> <in-progress-issues.json> <task-file> [repository-root]',
    );
  }

  const currentIssue = readJsonFile(currentIssueFile);
  const openIssues = [
    ...normalizeListPayload(readJsonFile(openIssuesFile)),
    ...normalizeListPayload(readJsonFile(inProgressIssuesFile)),
  ].filter((issue) => issue && issue.id && issue.id !== currentIssue.id);

  const result = await analyzePhase3Dependencies({
    currentIssue,
    openIssues,
    taskFile,
    repositoryRoot,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
