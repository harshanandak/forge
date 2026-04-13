'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function hasBackupJsonl(backupDir, fsApi) {
  try {
    return fsApi.readdirSync(backupDir).some((entry) => entry.endsWith('.jsonl'));
  } catch (_err) {
    return false;
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
  } catch (_err) {
    return projectRoot;
  }
}

function isRecoverableBeadsError(error) {
  const message = error?.message ?? String(error ?? '');
  return (
    message.includes('database not found') ||
    message.includes('database forge not found') ||
    message.includes('failed to open database') ||
    message.includes('no beads configuration found')
  );
}

function bootstrapBeads(projectRoot, options = {}) {
  const exec = options._exec || execFileSync;
  const fsApi = options._fs || fs;
  const platform = options._platform || process.platform;
  const mainProjectRoot = options.mainProjectRoot || resolveMainWorktree(projectRoot, exec);
  const beadsSource = path.resolve(mainProjectRoot, '.beads');
  const beadsDest = path.resolve(projectRoot, '.beads');

  if (beadsSource === beadsDest) {
    return { success: true, strategy: 'in-place', warning: null };
  }

  if (fsApi.existsSync(beadsDest) && typeof fsApi.rmSync === 'function') {
    fsApi.rmSync(beadsDest, { recursive: true, force: true });
  }

  if (fsApi.existsSync(beadsSource)) {
    try {
      if (platform === 'win32') {
        fsApi.symlinkSync(beadsSource, beadsDest, 'junction');
      } else {
        fsApi.symlinkSync(beadsSource, beadsDest);
      }

      return { success: true, strategy: 'linked', warning: null };
    } catch (symlinkErr) {
      if (symlinkErr.code !== 'EPERM') {
        throw symlinkErr;
      }
    }
  }

  exec('bd', ['init', '--force'], { cwd: projectRoot, stdio: 'pipe' });
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

module.exports = {
  bootstrapBeads,
  hasBackupJsonl,
  isRecoverableBeadsError,
  resolveMainWorktree,
};
