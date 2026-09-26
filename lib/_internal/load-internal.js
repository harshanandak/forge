'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
  const workspaceEntry = path.resolve(__dirname, '../..', 'packages', name, 'index.js');
  if (targetExists(workspaceEntry)) return require(workspaceEntry);
  return require(path.join(__dirname, 'vendor', name, 'index.js'));
}

module.exports = { loadInternal };
