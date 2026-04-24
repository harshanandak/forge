#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const bunCommand = process.env.BUN_EXE || 'bun';

function color(code, text) {
  return process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function printHeader(title) {
  const line = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  console.log('');
  console.log(color('0;34', line));
  console.log(color('0;34', `▶ ${title}`));
  console.log(color('0;34', line));
}

function printStatus(kind, message) {
  const palette = {
    error: ['0;31', '✗'],
    success: ['0;32', '✓'],
    warning: ['1;33', '⚠'],
  };
  const [code, prefix] = palette[kind];
  console.log(color(code, `${prefix} ${message}`));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.captureOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    shell: false,
    env: options.env || process.env,
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function combinedOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('');
}

function main() {
  console.log('');
  console.log(color('0;34', '╔═══════════════════════════════════════════╗'));
  console.log(color('0;34', '║   Forge Quality Gate - Running Checks    ║'));
  console.log(color('0;34', '╚═══════════════════════════════════════════╝'));

  printHeader('1/4: Type Check');
  const typecheck = run(bunCommand, ['run', 'typecheck']);
  if ((typecheck.status ?? 1) !== 0) {
    printStatus('error', 'Type check failed');
    return 1;
  }
  printStatus('warning', 'SKIPPED (no TypeScript in project)');

  printHeader('2/4: Lint');
  const lint = run(bunCommand, ['run', 'lint']);
  if ((lint.status ?? 1) !== 0) {
    printStatus('error', 'Lint failed');
    return 1;
  }
  printStatus('success', 'Lint passed');

  printHeader('3/4: Security Audit');
  const audit = run(bunCommand, ['audit'], { captureOutput: true });
  const auditOutput = combinedOutput(audit);
  if (auditOutput) {
    process.stdout.write(auditOutput);
    if (!auditOutput.endsWith('\n')) {
      process.stdout.write('\n');
    }
  }
  if (/critical|high/i.test(auditOutput)) {
    printStatus('error', 'Security audit found critical/high vulnerabilities');
    return 1;
  }
  if ((audit.status ?? 1) === 0) {
    printStatus('success', 'Security audit passed');
  } else {
    printStatus('warning', 'Security audit found issues (moderate/low — non-blocking)');
  }

  printHeader('4/4: Tests');
  const tests = run('node', ['scripts/test.js', '--validate']);
  if ((tests.status ?? 1) !== 0) {
    printStatus('error', 'Tests failed');
    return 1;
  }
  printStatus('success', 'All tests passed');

  console.log('');
  console.log(color('0;32', '╔═══════════════════════════════════════════╗'));
  console.log(color('0;32', '║     ✓ All Checks Passed Successfully     ║'));
  console.log(color('0;32', '╚═══════════════════════════════════════════╝'));
  console.log('');
  return 0;
}

process.exit(main());
