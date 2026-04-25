'use strict';

const { isSharedField } = require('./authority.js');

const FLAG_TO_SHARED_FIELD = new Map([
  ['--title', 'shared.title'],
  ['--body', 'shared.body'],
  ['--state', 'shared.state'],
  ['--assignee', 'shared.assignees'],
  ['--assignees', 'shared.assignees'],
  ['--label', 'shared.labels'],
  ['--labels', 'shared.labels'],
  ['--milestone', 'shared.milestone'],
  ['--claim', 'shared.assignees'],
]);

const OPERATIONS_WITH_DEFAULT_SHARED_FIELDS = new Map([
  ['close', ['shared.state']],
]);

function uniquePush(items, value) {
  if (value && !items.includes(value)) {
    items.push(value);
  }
}

function isHelpInvocation(args = []) {
  return Array.isArray(args) && args.some(arg => arg === '--help' || arg === '-h');
}

function appendDefaultSharedFields(operation, fieldPaths) {
  for (const defaultField of OPERATIONS_WITH_DEFAULT_SHARED_FIELDS.get(operation) || []) {
    if (isSharedField(defaultField)) {
      uniquePush(fieldPaths, defaultField);
    }
  }
}

function inferCreateTitleField(operation, args = []) {
  if (operation !== 'create' || !Array.isArray(args) || args.length === 0) {
    return null;
  }

  const firstNonFlagArg = args.find(arg => typeof arg === 'string' && !arg.startsWith('-'));
  if (firstNonFlagArg === undefined) {
    return null;
  }

  return 'shared.title';
}

function collectSharedFieldsFromFlags(args = []) {
  const fieldPaths = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string') {
      continue;
    }

    const flagKey = arg.startsWith('--') ? arg.split('=')[0] : arg;
    const fieldPath = FLAG_TO_SHARED_FIELD.get(flagKey);
    if (!fieldPath || !isSharedField(fieldPath)) {
      continue;
    }

    uniquePush(fieldPaths, fieldPath);

    if (flagKey === '--claim') {
      continue;
    }

    if (flagKey.startsWith('--') && !arg.includes('=')) {
      index += 1;
    }
  }

  return fieldPaths;
}

function collectSharedFieldPaths(operation, args = []) {
  if (typeof operation !== 'string' || operation.length === 0) {
    return [];
  }

  if (isHelpInvocation(args)) {
    return [];
  }

  const fieldPaths = [];
  appendDefaultSharedFields(operation, fieldPaths);

  if (!Array.isArray(args)) {
    return fieldPaths;
  }

  uniquePush(fieldPaths, inferCreateTitleField(operation, args));
  for (const fieldPath of collectSharedFieldsFromFlags(args)) {
    uniquePush(fieldPaths, fieldPath);
  }

  return fieldPaths;
}

function createGitHubProjectionPlan(operation, args = []) {
  const fieldPaths = collectSharedFieldPaths(operation, args);

  if (fieldPaths.length === 0) {
    return null;
  }

  return {
    operation,
    args: Array.isArray(args) ? [...args] : [],
    fieldPaths,
  };
}

module.exports = {
  collectSharedFieldPaths,
  createGitHubProjectionPlan,
  isHelpInvocation,
};
