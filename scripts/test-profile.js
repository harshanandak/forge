#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = {
    inputDir: 'test-results',
    label: 'local',
    output: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === '--input-dir') args.inputDir = next;
    if (current === '--label') args.label = next;
    if (current === '--output') args.output = next;
    if (current === '--integration-skipped') args.integrationSkipped = next === 'true';
  }

  return args;
}

function walk(dir, extension) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(absolute, extension));
      continue;
    }
    if (absolute.endsWith(extension)) {
      results.push(absolute);
    }
  }
  return results;
}

function parseAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/([a-zA-Z_:][\w:.-]*)="([^"]*)"/g)) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function parseJUnitFiles(files) {
  const fileDurations = new Map();
  const timedOutFiles = new Set();
  let suiteDurationMs = 0;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const suiteMatch of content.matchAll(/<testsuite\b([^>]*)>/g)) {
      const attrs = parseAttributes(suiteMatch[1]);
      suiteDurationMs += Math.round(Number.parseFloat(attrs.time || '0') * 1000);
    }

    for (const caseMatch of content.matchAll(/<testcase\b([^>]*)>([\s\S]*?)<\/testcase>|<testcase\b([^>]*)\/>/g)) {
      const attrs = parseAttributes(caseMatch[1] || caseMatch[3] || '');
      const body = caseMatch[2] || '';
      const key = attrs.file || attrs.classname || attrs.name || path.basename(file);
      const durationMs = Math.round(Number.parseFloat(attrs.time || '0') * 1000);
      fileDurations.set(key, (fileDurations.get(key) || 0) + durationMs);
      if (/timeout/i.test(body)) {
        timedOutFiles.add(key);
      }
    }
  }

  return {
    suiteDurationMs,
    slowestFiles: Array.from(fileDurations.entries())
      .map(([file, durationMs]) => ({ file, durationMs }))
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 10),
    timedOutFiles: Array.from(timedOutFiles).sort((left, right) => left.localeCompare(right)),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputDir = path.resolve(process.cwd(), args.inputDir);
  const files = walk(inputDir, '.xml');
  const metrics = parseJUnitFiles(files);
  const profile = {
    label: args.label,
    suiteDurationMs: metrics.suiteDurationMs,
    slowestFiles: metrics.slowestFiles,
    timedOutFiles: metrics.timedOutFiles,
    integrationSkipped: args.integrationSkipped !== false,
    timestamp: new Date().toISOString(),
  };

  if (args.output) {
    const outputPath = path.resolve(process.cwd(), args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(profile, null, 2));
  }

  process.stdout.write(JSON.stringify(profile));
}

main();
