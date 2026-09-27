'use strict';

/* global FORGE_COMPILED */

const fs = require('node:fs');
const path = require('node:path');

const WORKSPACE_LOADERS = Object.freeze({
  contracts: () => require('../../packages/contracts'),
  memory: () => require('../../packages/memory'),
  flow: () => require('../../packages/flow'),
});

function isCompiledBinary() {
  return typeof FORGE_COMPILED !== 'undefined' && FORGE_COMPILED === true;
}

function targetExists(target) {
  try {
    fs.statSync(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function loadInternal(name) {
  if (!Object.hasOwn(WORKSPACE_LOADERS, name)) throw new TypeError(`Unknown internal package: ${name}`);
  const workspaceEntry = path.resolve(__dirname, '../..', 'packages', name, 'index.js');
  if (isCompiledBinary() || targetExists(workspaceEntry)) return WORKSPACE_LOADERS[name]();
  return require(path.join(__dirname, 'vendor', name, 'index.js'));
}

module.exports = { loadInternal };
