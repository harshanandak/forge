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

function positionalArgs(args) {
  const positionals = [];
  const flagsWithValues = new Set(['--name']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith('--') && arg.includes('=')) {
      continue;
    }
    if (arg.startsWith('-')) {
      if (flagsWithValues.has(arg) && index + 1 < args.length && !args[index + 1].startsWith('-')) {
        index++;
      }
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

function stripKnownExtension(base) {
  const lowerBase = base.toLowerCase();
  for (const suffix of ['.plugin.json', '.tar.gz', '.json', '.tgz']) {
    if (lowerBase.endsWith(suffix)) {
      return base.slice(0, base.length - suffix.length);
    }
  }
  return base;
}

function normalizeNameSegment(value) {
  let normalized = '';
  let previousWasSeparator = true;
  for (const character of value) {
    const isAllowed = (
      (character >= 'A' && character <= 'Z')
      || (character >= 'a' && character <= 'z')
      || (character >= '0' && character <= '9')
      || character === '.'
      || character === '_'
      || character === '-'
    );
    if (isAllowed) {
      normalized += character;
      previousWasSeparator = false;
    } else if (!previousWasSeparator) {
      normalized += '-';
      previousWasSeparator = true;
    }
  }
  return normalized.endsWith('-') ? normalized.slice(0, -1) : normalized;
}

function deriveName(source) {
  const sourceText = String(source || '');
  const base = path.basename(sourceText.endsWith('/') ? sourceText.slice(0, -1) : sourceText);
  return normalizeNameSegment(stripKnownExtension(base)) || 'extension';
}

function usage() {
  return 'Usage: forge add <source> [--name <id>] [--allow-untrusted]';
}

async function handler(args, _flags, projectRoot) {
  const [source] = positionalArgs(args);
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
