'use strict';

const memoryRouter = require('../memory/router');
const { stripGlobalFlags } = require('../global-flags');

const usage =
  'Usage: forge remember <note> [--kind <type>] [--tag <label>]... ' +
  '[--what <text>] [--why <text>] [--where <text>] [--learned <text>] [--json]';

// Structured note fields (kernel issue 8cc1db4d). Each is optional and, when present, is
// folded into the stored note body as a labeled line so it stays FTS-searchable. Order is
// fixed for a stable, readable render.
const STRUCTURED_FIELDS = [
  ['--what', 'What'],
  ['--why', 'Why'],
  ['--where', 'Where'],
  ['--learned', 'Learned'],
];

// A note's type is stored as a reserved `type:<value>` tag — cheap, additive, and filterable
// by recall/search WITHOUT a store-schema change (a missing type is fine). The CLI flag is
// `--kind` (NOT `--type`): `--type` is a reserved GLOBAL flag that bin/forge.js hard-validates
// against workflow classifications (critical|standard|…), so it can never carry a note type.
const TYPE_TAG_PREFIX = 'type:';

/**
 * Split positional note words from `--kind`, `--tag <label>`, the structured field flags,
 * and `--json`. Global flags (e.g. `-p <dir>`) are stripped first so they never leak into the
 * stored note content (kernel issue c1e090ff); `--kind` is NOT a global flag, so it survives
 * the strip and is parsed here.
 *
 * @param {string[]} rawArgs - Raw command arguments.
 * @returns {{ note: string, tags: string[], type: (string|undefined), fields: object, json: boolean }}
 */
function parseArgs(rawArgs) {
  const args = stripGlobalFlags(rawArgs);
  const fieldFlags = new Map(STRUCTURED_FIELDS.map(([flag, label]) => [flag, label]));
  const words = [];
  const tags = [];
  const fields = {};
  let type;
  let json = false;

  // Consume `--flag value` / `--flag=value`, guarding against swallowing the next flag.
  const takeValue = (index) => {
    const arg = args[index];
    const eq = arg.indexOf('=');
    if (eq >= 0) return { value: arg.slice(eq + 1), consumed: 0 };
    const next = args[index + 1];
    if (next && !next.startsWith('--')) return { value: next, consumed: 1 };
    return { value: undefined, consumed: 0 };
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const bare = arg.startsWith('--') ? arg.split('=', 1)[0] : arg;
    if (arg === '--json') {
      json = true;
    } else if (bare === '--kind') {
      const { value, consumed } = takeValue(index);
      if (value) type = value.trim();
      index += consumed;
    } else if (bare === '--tag') {
      const { value, consumed } = takeValue(index);
      if (value) tags.push(value);
      index += consumed;
    } else if (fieldFlags.has(bare)) {
      const { value, consumed } = takeValue(index);
      if (value) fields[fieldFlags.get(bare)] = value.trim();
      index += consumed;
    } else {
      words.push(arg);
    }
  }

  return { note: words.join(' ').trim(), tags, type, fields, json };
}

/**
 * Compose the stored note body from the positional note plus any structured fields. Fields
 * are appended as labeled lines under the note so recall renders them readably and they stay
 * searchable. Returns the empty string only when nothing at all was provided.
 */
function composeBody(note, fields) {
  const lines = STRUCTURED_FIELDS
    .map(([, label]) => (fields[label] ? `${label}: ${fields[label]}` : null))
    .filter(Boolean);
  return [note, ...lines].filter(Boolean).join('\n');
}

async function handler(args, _flags, projectRoot) {
  const { note, tags, type, fields, json } = parseArgs(args);
  const body = composeBody(note, fields);

  if (!body) {
    return {
      success: false,
      error: `No note provided.\n${usage}`,
    };
  }

  // The type rides as a reserved tag so it is stored and filterable without a schema change.
  const allTags = type ? [...tags, `${TYPE_TAG_PREFIX}${type}`] : tags;
  const entry = memoryRouter.append(projectRoot, body, { tags: allTags });

  if (json) {
    const payload = type ? { ...entry, type } : entry;
    return { success: true, output: `${JSON.stringify(payload, null, 2)}\n` };
  }

  const userTags = entry.tags.filter(tag => !tag.startsWith(TYPE_TAG_PREFIX));
  const tagSuffix = userTags.length > 0 ? ` [${userTags.join(', ')}]` : '';
  const typePrefix = type ? `(${type}) ` : '';
  return {
    success: true,
    output: `Remembered: ${typePrefix}${entry.note}${tagSuffix}`,
  };
}

module.exports = {
  name: 'remember',
  description: 'Persist a project-memory note to the kernel-backed memory store',
  usage,
  flags: {
    '--kind': 'Type the note (decision|bugfix|gotcha|...) — filterable by recall (--type is reserved)',
    '--tag': 'Attach a search label (repeatable)',
    '--what': 'Structured field: what happened/changed',
    '--why': 'Structured field: why',
    '--where': 'Structured field: where (file/area)',
    '--learned': 'Structured field: what was learned',
    '--json': 'Emit machine-readable JSON output',
  },
  handler,
};
