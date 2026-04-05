'use strict';

const fs = require('node:fs');
const path = require('node:path');

function writeExecutable(filePath, content, windowsContent = null) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });

  if (process.platform === 'win32' && path.extname(filePath) === '') {
    fs.writeFileSync(
      `${filePath}.cmd`,
      windowsContent || `@echo off\r\nbash \"%~dp0\\${path.basename(filePath)}\" %*\r\n`,
      { mode: 0o755 }
    );
  }
}

function prepareMockSetupTools(projectRoot) {
  const mockBinDir = path.join(projectRoot, '.mock-bin');
  fs.mkdirSync(mockBinDir, { recursive: true });
  writeExecutable(
    path.join(mockBinDir, 'bd'),
    '#!/usr/bin/env bash\necho "bd 0.49.1"\n',
    '@echo off\r\necho bd 0.49.1\r\n'
  );
  writeExecutable(
    path.join(mockBinDir, 'gh'),
    '#!/usr/bin/env bash\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then\n  echo "Logged in"\n  exit 0\nfi\necho "gh version 2.81.0"\n',
    '@echo off\r\nif "%1"=="auth" if "%2"=="status" (\r\n  echo Logged in\r\n  exit /b 0\r\n)\r\necho gh version 2.81.0\r\n'
  );
  writeExecutable(
    path.join(mockBinDir, 'jq'),
    '#!/usr/bin/env bash\necho "jq-1.8.1"\n',
    '@echo off\r\necho jq-1.8.1\r\n'
  );
  return mockBinDir;
}

function createMockSetupCommandRunner() {
  return (command) => {
    switch (command) {
      case 'git --version':
        return 'git version 2.42.0';
      case 'gh --version':
        return 'gh version 2.81.0';
      case 'gh auth status':
        return 'Logged in';
      case 'bd --version':
        return 'bd 0.49.1';
      case 'jq --version':
        return 'jq-1.8.1';
      default:
        return '';
    }
  };
}

async function withMockSetupTools(projectRoot, callback) {
  const previousEnv = {
    INIT_CWD: process.env.INIT_CWD,
    PATH: process.env.PATH,
    Path: process.env.Path,
  };
  const mockBinDir = prepareMockSetupTools(projectRoot);

  process.env.INIT_CWD = projectRoot;
  process.env.PATH = `${mockBinDir}${path.delimiter}${previousEnv.PATH || ''}`;
  process.env.Path = process.env.PATH;

  try {
    return await callback(createMockSetupCommandRunner());
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

module.exports = {
  createMockSetupCommandRunner,
  prepareMockSetupTools,
  withMockSetupTools,
};
