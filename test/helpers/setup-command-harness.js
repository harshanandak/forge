'use strict';

const fs = require('node:fs');
const path = require('node:path');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });

  if (process.platform === 'win32' && path.extname(filePath) === '') {
    const base = path.basename(filePath);
    fs.writeFileSync(
      `${filePath}.cmd`,
      `@echo off\r\nbash \"%~dp0\\${base}\" %*\r\n`,
      { mode: 0o755 }
    );
  }
}

function prepareMockSetupTools(projectRoot) {
  const mockBinDir = path.join(projectRoot, '.mock-bin');
  fs.mkdirSync(mockBinDir, { recursive: true });
  writeExecutable(path.join(mockBinDir, 'bd'), '#!/usr/bin/env bash\necho "bd 0.49.1"\n');
  writeExecutable(
    path.join(mockBinDir, 'gh'),
    '#!/usr/bin/env bash\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then\n  echo "Logged in"\n  exit 0\nfi\necho "gh version 2.81.0"\n'
  );
  writeExecutable(path.join(mockBinDir, 'jq'), '#!/usr/bin/env bash\necho "jq-1.8.1"\n');
  return mockBinDir;
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
    return await callback();
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
  withMockSetupTools,
};
