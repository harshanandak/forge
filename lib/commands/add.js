'use strict';

const path = require('node:path');
const { addLockEntry } = require('../forge-lock');

function hasArg(args, name) {
  return Array.isArray(args) && args.includes(name);
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  const prefix = `${name}=`;
  const match = args.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function deriveName(source) {
  const base = path.basename(String(source || '').replace(/\/$/, ''));
  const withoutExt = base.replace(/\.(?:plugin\.json|json|tgz|tar\.gz)$/i, '');
  return withoutExt.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'extension';
}

function usage() {
  return 'Usage: forge add <source> [--name <id>] [--allow-untrusted]';
}

async function handler(args, _flags, projectRoot) {
  const source = args.find(arg => !arg.startsWith('-'));
  if (!source) {
    return { success: false, error: usage() };
  }

  try {
    const result = addLockEntry(projectRoot, {
      name: argValue(args, '--name') || deriveName(source),
      source,
      allowUntrusted: hasArg(args, '--allow-untrusted'),
    });
    const trustNote = result.entry.trust.trusted
      ? 'trusted source verified'
      : 'untrusted source accepted by explicit policy';
    return {
      success: true,
      output: `Added ${result.entry.name} to forge.lock (${trustNote}).`,
    };
  } catch (error) {
    const message = error.message.includes('Untrusted source')
      ? `${error.message}\nUse --allow-untrusted only for sources you intentionally trust for this project.`
      : error.message;
    return { success: false, error: message };
  }
}

module.exports = {
  name: 'add',
  description: 'Record an extension source in forge.lock',
  usage: usage(),
  flags: {
    '--name': 'Lockfile extension id to record',
    '--allow-untrusted': 'Explicitly record an untrusted remote/package source',
  },
  handler,
};

