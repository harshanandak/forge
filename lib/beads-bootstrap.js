'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { safeBeadsInit } = require('./beads-setup');

function isIgnorableFsError(error) {
  return ['EACCES', 'ENOENT', 'ENOTDIR', 'EPERM'].includes(error?.code);
}

function isRecoverableCommandError(error) {
  return error?.code === 'ENOENT' || typeof error?.status === 'number';
}

function hasBackupJsonl(backupDir, fsApi) {
  try {
    return fsApi.readdirSync(backupDir).some((entry) => entry.endsWith('.jsonl'));
  } catch (err) {
    if (isIgnorableFsError(err)) {
      return false;
    }
    throw err;
  }
}

function resolveMainWorktree(projectRoot, exec) {
  try {
    const commonDir = exec('git', ['rev-parse', '--git-common-dir'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim();
    return path.resolve(projectRoot, commonDir, '..');
  } catch (err) {
    if (isRecoverableCommandError(err)) {
      return projectRoot;
    }
    throw err;
  }
}

function isRecoverableBeadsError(error) {
  const message = error?.message ?? String(error ?? '');
  return (
    /database(?:\s+[^\s]+)?\s+not found/i.test(message) ||
    message.includes('failed to open database') ||
    message.includes('no beads configuration found')
  );
}

function readMetadataDatabaseName(projectRoot, fsApi) {
  const metadataPath = path.resolve(projectRoot, '.beads', 'metadata.json');
  if (!fsApi.existsSync(metadataPath)) {
    return null;
  }

  try {
    const metadata = JSON.parse(fsApi.readFileSync(metadataPath, 'utf8'));
    if (typeof metadata.dolt_database === 'string' && metadata.dolt_database.trim()) {
      return metadata.dolt_database.trim();
    }
    if (typeof metadata.database === 'string' && metadata.database.trim()) {
      return metadata.database.trim();
    }
  } catch (err) {
    if (err instanceof SyntaxError || isIgnorableFsError(err)) {
      return null;
    }
    throw err;
  }

  return null;
}

function stageExistingBeadsDest(beadsDest, fsApi) {
  if (!fsApi.existsSync(beadsDest)) {
    return null;
  }

  const stagedDest = `${beadsDest}.bootstrap-backup`;
  if (typeof fsApi.renameSync === 'function') {
    fsApi.renameSync(beadsDest, stagedDest);
    return stagedDest;
  }

  if (typeof fsApi.rmSync === 'function') {
    fsApi.rmSync(beadsDest, { recursive: true, force: true });
  }

  return null;
}

function restoreStagedBeadsDest(beadsDest, stagedDest, fsApi) {
  if (!stagedDest || fsApi.existsSync(beadsDest) || typeof fsApi.renameSync !== 'function') {
    return;
  }

  fsApi.renameSync(stagedDest, beadsDest);
}

function cleanupStagedBeadsDest(stagedDest, fsApi) {
  if (!stagedDest || !fsApi.existsSync(stagedDest) || typeof fsApi.rmSync !== 'function') {
    return;
  }

  fsApi.rmSync(stagedDest, { recursive: true, force: true });
}

function tryLinkBeadsSource(beadsSource, beadsDest, platform, fsApi) {
  if (!fsApi.existsSync(beadsSource)) {
    return false;
  }

  const stagedDest = stageExistingBeadsDest(beadsDest, fsApi);

  try {
    if (platform === 'win32') {
      fsApi.symlinkSync(beadsSource, beadsDest, 'junction');
    } else {
      fsApi.symlinkSync(beadsSource, beadsDest);
    }

    cleanupStagedBeadsDest(stagedDest, fsApi);
    return true;
  } catch (symlinkErr) {
    restoreStagedBeadsDest(beadsDest, stagedDest, fsApi);
    if (symlinkErr.code !== 'EPERM') {
      throw symlinkErr;
    }
    return false;
  }
}

function buildInitArgs(mainProjectRoot, projectRoot, fsApi) {
  const metadataDatabaseName = readMetadataDatabaseName(mainProjectRoot, fsApi)
    || readMetadataDatabaseName(projectRoot, fsApi);
  const initArgs = ['init', '--force'];
  if (metadataDatabaseName) {
    initArgs.push('--database', metadataDatabaseName);
  }

  return initArgs;
}

function runFreshInit(projectRoot, mainProjectRoot, beadsSource, initArgs, exec, runSafeBeadsInit, fsApi) {
  const safeInitResult = runSafeBeadsInit(projectRoot, {
    prefix: path.basename(mainProjectRoot),
    execBdInit: (root) => {
      exec('bd', initArgs, { cwd: root, stdio: 'pipe' });
    }
  });

  if (!safeInitResult.success) {
    const initMessage = safeInitResult.errors?.[0]
      || safeInitResult.warnings?.[0]
      || 'unknown safeBeadsInit failure';
    return {
      success: false,
      strategy: 'fresh-init-failed',
      warning: `Beads bootstrap fresh init failed: ${initMessage}`
    };
  }

  const backupDir = path.resolve(beadsSource, 'backup');
  if (hasBackupJsonl(backupDir, fsApi)) {
    try {
      exec('bd', ['backup', 'restore', backupDir], { cwd: projectRoot, stdio: 'pipe' });
      return {
        success: true,
        strategy: 'backup-restore',
        warning: 'Beads bootstrap restored from backup'
      };
    } catch (restoreErr) {
      return {
        success: true,
        strategy: 'fresh-init',
        warning: `Beads bootstrap initialized fresh after backup restore failed: ${restoreErr.message}`
      };
    }
  }

  return {
    success: true,
    strategy: 'fresh-init',
    warning: 'Beads bootstrap initialized fresh (no backup found)'
  };
}

function bootstrapBeads(projectRoot, options = {}) {
  const exec = options._exec || execFileSync;
  const fsApi = options._fs || fs;
  const platform = options._platform || process.platform;
  const runSafeBeadsInit = options._safeBeadsInit || safeBeadsInit;
  const mainProjectRoot = options.mainProjectRoot || resolveMainWorktree(projectRoot, exec);
  const beadsSource = path.resolve(mainProjectRoot, '.beads');
  const beadsDest = path.resolve(projectRoot, '.beads');

  if (beadsSource === beadsDest) {
    return { success: true, strategy: 'in-place', warning: null };
  }

  if (tryLinkBeadsSource(beadsSource, beadsDest, platform, fsApi)) {
    return { success: true, strategy: 'linked', warning: null };
  }

  const initArgs = buildInitArgs(mainProjectRoot, projectRoot, fsApi);
  return runFreshInit(projectRoot, mainProjectRoot, beadsSource, initArgs, exec, runSafeBeadsInit, fsApi);
}

module.exports = {
  bootstrapBeads,
  hasBackupJsonl,
  isRecoverableBeadsError,
  resolveMainWorktree,
};
