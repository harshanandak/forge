'use strict';

const path = require('node:path');

/**
 * Remove modulesPath when it is a link (symlink or Windows junction), without
 * following it. A real directory is left alone.
 * @param {string} modulesPath - Path to a node_modules entry
 * @param {object} fsApi - fs-compatible module (lstatSync, unlinkSync)
 * @returns {boolean} true when a link was detached
 * @throws when the entry cannot be inspected or the link cannot be removed.
 */
function detachModulesLink(modulesPath, fsApi) {
  try {
    if (!fsApi.lstatSync(modulesPath).isSymbolicLink()) return false;
    fsApi.unlinkSync(modulesPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Detach a worktree's shared node_modules link before the worktree is deleted.
 * `git worktree remove` (and --force) follows a junction and empties the linked
 * target — another checkout's install — so callers must refuse the removal when
 * this throws.
 * @param {string} worktreePath - Absolute worktree path
 * @param {object} fsApi - fs-compatible module
 * @returns {boolean} true when a link was detached
 * @throws {Error} naming node_modules when a link exists and cannot be detached.
 */
function detachWorktreeModulesLink(worktreePath, fsApi) {
  const modulesPath = path.join(worktreePath, 'node_modules');
  try {
    return detachModulesLink(modulesPath, fsApi);
  } catch (error) {
    throw new Error(`could not detach the node_modules link at ${modulesPath} (${error.message}); removing the worktree would follow it into the linked install`);
  }
}

/**
 * Detach a worktree's node_modules link and return a function that puts it back.
 * Use when the removal after the detach can still be refused (a dirty worktree):
 * the worktree then survives intact, including its dependency link.
 * @param {string} worktreePath - Absolute worktree path
 * @param {object} fsApi - fs-compatible module (adds readlinkSync, symlinkSync)
 * @returns {() => void} restore; a no-op when no link was detached. Never throws.
 * @throws {Error} naming node_modules when a link exists and cannot be detached.
 */
function detachWorktreeModulesLinkRestorable(worktreePath, fsApi) {
  const modulesPath = path.join(worktreePath, 'node_modules');
  let target = null;
  try {
    if (fsApi.lstatSync(modulesPath).isSymbolicLink()) target = fsApi.readlinkSync(modulesPath);
  } catch (_error) { /* unreadable: detachWorktreeModulesLink below reports it */ }
  if (!detachWorktreeModulesLink(worktreePath, fsApi) || !target) return () => {};
  return () => {
    try {
      if (!fsApi.existsSync(worktreePath)) return;
      fsApi.symlinkSync(target, modulesPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (_error) { /* best effort: the worktree still works after a reinstall */ }
  };
}

module.exports = { detachModulesLink, detachWorktreeModulesLink, detachWorktreeModulesLinkRestorable };
