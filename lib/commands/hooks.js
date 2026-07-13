'use strict';

/**
 * `forge hooks install --global [--harness codex|hermes|all] [--dry-run]`
 *
 * The opt-in, CONSENT-GUARDED delivery path for the last native-hooks gap
 * (kernel issue 66dd5a1f, epics 90f2f631 + 1390e1d1): Codex and Hermes have
 * real native hook surfaces, but both live in GLOBAL (home-dir) config —
 * `$CODEX_HOME/config.toml` and `~/.hermes/config.yaml` — which project
 * `forge setup` intentionally never writes.
 *
 * Consent model:
 *   - the explicit `--global` flag IS the consent — without it the command
 *     refuses with guidance and writes nothing;
 *   - the command prints exactly which files are written and the exact Forge
 *     hook block merged into each, BEFORE reporting results;
 *   - `--dry-run` shows the same plan without touching disk;
 *   - existing user config is preserved (read → merge → write, idempotent via
 *     the forge-native-hook.js marker); unmergeable config is backed up and
 *     skipped, never overwritten.
 *
 * This command is deliberately NOT wired into project `forge setup`.
 */

const {
  GLOBAL_HOOK_HARNESSES,
  renderGlobalHookBlock,
  installGlobalHooks,
} = require('../hook-global-installer');
const { sessionStartCapability, userPromptSubmitCapability } = require('../hook-renderer');
const { collectDigestData, buildMemoryDigest } = require('../memory-digest');
const { collectInbox, buildInboxNudge } = require('../inbox');

function usage() {
  return 'Usage: forge hooks install --global [--harness codex|hermes|all] [--dry-run]\n'
    + '       forge hooks session-start --harness <claude> (machine-facing; emits SessionStart context)\n'
    + '       forge hooks inbox-pickup --harness <claude> (machine-facing; emits UserPromptSubmit context)';
}

/** Parse `--harness <h>` (defaults to claude) from a session-start arg slice. */
function parseHarness(rest) {
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--harness') return rest[i + 1] || 'claude';
    if (rest[i].startsWith('--harness=')) return rest[i].slice('--harness='.length);
  }
  return 'claude';
}

/** Wrap a digest into a harness-native SessionStart payload, or '' when unsupported. */
function formatSessionStart(harness, text) {
  if (harness === 'claude') {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    });
  }
  // No other harness has a verified session-start context surface — emit nothing.
  return '';
}

/**
 * `forge hooks session-start --harness <h>` — the CONTEXT hook Forge PUSHES to an agent
 * at session start. Machine-facing plumbing: emits harness-native SessionStart JSON on
 * stdout (Claude: { hookSpecificOutput.additionalContext }). FAIL-OPEN by construction —
 * any failure, an unsupported harness, or an empty digest yields '' (the harness then
 * injects nothing). NEVER throws and NEVER emits malformed JSON.
 *
 * @param {string[]} rest - args after the `session-start` action.
 * @param {string} projectRoot
 * @param {object} [opts] - injectable digest fetchers ({ fetchNotes, fetchIssues }).
 * @returns {Promise<{ success: boolean, output: string }>}
 */
async function handleSessionStart(rest, projectRoot, opts = {}) {
  try {
    const harness = parseHarness(rest);
    if (!sessionStartCapability(harness).rendered) return { success: true, output: '' };
    const data = await collectDigestData(projectRoot, opts);
    const digest = buildMemoryDigest(data, opts);
    if (digest.empty) return { success: true, output: '' };
    return { success: true, output: formatSessionStart(harness, digest.text) };
  } catch {
    // Fail-open: a context hook must never break a session.
    return { success: true, output: '' };
  }
}

/** Wrap a digest into a harness-native UserPromptSubmit payload, or '' when unsupported. */
function formatUserPromptSubmit(harness, text) {
  if (harness === 'claude') {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
    });
  }
  // No other harness has a verified UserPromptSubmit context surface — emit nothing.
  return '';
}

/**
 * `forge hooks inbox-pickup --harness <h>` — the COMPLIANT comment-back CONTEXT hook. On each
 * prompt it emits harness-native UserPromptSubmit JSON carrying a COMPACT count+pointer nudge
 * (Claude: { hookSpecificOutput.additionalContext }). It deliberately does NOT re-emit the full
 * fenced bodies: Claude APPENDS UserPromptSubmit additionalContext to history on every prompt
 * (it does not replace prior injections — a documented context-bloat limitation), so a compact
 * nudge keeps per-prompt accumulation negligible while still flagging "you have pending items,
 * run `forge inbox`". The full fenced digest surfaces once at SessionStart and on demand via
 * `forge inbox`. It reads the user's OWN kernel data via a supported hook — it NEVER injects
 * into a running session's stdin and NEVER drives the agent programmatically (Anthropic Usage
 * Policy, kernel issue 6d10c1a1). FAIL-OPEN: any failure, an unsupported harness, or nothing
 * pending yields '' (the harness injects nothing). NEVER throws, NEVER emits malformed JSON.
 *
 * @param {string[]} rest - args after the `inbox-pickup` action.
 * @param {string} projectRoot
 * @param {object} [opts] - injectable inbox fetchers ({ fetchClaims, fetchComments, ... }).
 * @returns {Promise<{ success: boolean, output: string }>}
 */
async function handleInboxPickup(rest, projectRoot, opts = {}) {
  try {
    const harness = parseHarness(rest);
    if (!userPromptSubmitCapability(harness).rendered) return { success: true, output: '' };
    const pending = await collectInbox(projectRoot, opts);
    const nudge = buildInboxNudge(pending);
    if (nudge.empty) return { success: true, output: '' };
    return { success: true, output: formatUserPromptSubmit(harness, nudge.text) };
  } catch {
    // Fail-open: a context hook must never break a prompt.
    return { success: true, output: '' };
  }
}

function parseInstallArgs(rest) {
  const parsed = { global: false, dryRun: false, harness: 'all', unknown: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--global') parsed.global = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--harness') { parsed.harness = rest[i + 1]; i += 1; }
    else if (arg.startsWith('--harness=')) parsed.harness = arg.slice('--harness='.length);
    else parsed.unknown.push(arg);
  }
  return parsed;
}

function indent(text, prefix) {
  return String(text).replace(/\s+$/, '').split('\n').map(l => prefix + l).join('\n');
}

const GLOBAL_CONSENT_ERROR = [
  'forge hooks install writes GLOBAL (home-directory) harness config:',
  '  - Codex : $CODEX_HOME/config.toml (default ~/.codex/config.toml)',
  '  - Hermes: ~/.hermes/config.yaml',
  'Global config affects EVERY project on this machine, so Forge never writes it',
  'silently — re-run with the explicit --global flag to consent, and add --dry-run',
  'first to preview exactly what would be written.',
  usage(),
].join('\n');

const INSTALL_FOOTER = [
  '',
  'Note: the hook commands invoke `node .forge/hooks/forge-native-hook.js` relative',
  'to the workspace root (Codex and Hermes run hooks from there), so enforcement',
  'applies inside Forge-initialized projects; elsewhere the adapter is absent and',
  'the hook fails open (no deny decision is emitted), leaving tool calls untouched.',
];

/** Validate parsed install args; returns an error string or null when valid. */
function validateInstallArgs(parsed) {
  if (parsed.unknown.length > 0) return `Unknown argument(s): ${parsed.unknown.join(' ')}\n${usage()}`;
  if (!parsed.global) return GLOBAL_CONSENT_ERROR;
  const harnesses = parsed.harness === 'all' ? GLOBAL_HOOK_HARNESSES : [parsed.harness];
  if (!harnesses.every(h => GLOBAL_HOOK_HARNESSES.includes(h))) {
    return `Unknown --harness '${parsed.harness}'. Allowed: codex, hermes, all.\n${usage()}`;
  }
  return null;
}

/** Format the output lines for a single install result. */
function renderInstallResult(res, dryRun) {
  const lines = ['', `${res.harness} -> ${res.file}`];
  if (res.skipped) {
    lines.push(`  SKIPPED (left untouched): ${res.reason}`);
    if (res.backup) lines.push(`  Backed up existing file to: ${res.backup} (.bak)`);
    else if (dryRun) lines.push('  (dry-run: existing file would be backed up to a .bak and skipped)');
    return lines;
  }
  lines.push(indent(renderGlobalHookBlock(res.harness), '    '));
  if (dryRun) {
    lines.push(res.changed === false
      ? '  [dry-run] already up to date — a real run would change nothing'
      : '  [dry-run] would merge the block above into this file');
  } else {
    lines.push(res.changed === false
      ? '  Already up to date (no changes written).'
      : `  Merged Forge hooks into ${res.existed ? 'existing' : 'new'} config.`);
  }
  return lines;
}

/** The `install` action — consent-guarded GLOBAL hook install (Codex/Hermes). */
function handleInstall(args, flags, opts) {
  const parsed = parseInstallArgs(args.slice(1));
  const dryRun = parsed.dryRun || Boolean(flags.dryRun);

  const validationError = validateInstallArgs(parsed);
  if (validationError) return { success: false, error: validationError };

  const harnesses = parsed.harness === 'all' ? GLOBAL_HOOK_HARNESSES : [parsed.harness];
  // env/homeDir are injectable through the command opts so tests never touch the
  // real home directory; real dispatch passes neither and gets the defaults.
  const results = installGlobalHooks({ harnesses, dryRun, env: opts.env || process.env, homeDir: opts.homeDir });

  const out = [
    dryRun ? 'forge hooks install --global (dry-run — nothing will be written)' : 'forge hooks install --global',
    '',
    'This merges the following Forge hook block into each GLOBAL config,',
    'preserving all existing user config (idempotent re-runs):',
    ...results.flatMap(res => renderInstallResult(res, dryRun)),
    ...INSTALL_FOOTER,
  ];
  return { success: true, output: out.join('\n'), results };
}

async function handler(args, flags = {}, projectRoot, opts = {}) {
  const action = args[0];
  if (action === 'session-start') return handleSessionStart(args.slice(1), projectRoot, opts);
  if (action === 'inbox-pickup') return handleInboxPickup(args.slice(1), projectRoot, opts);
  if (action === 'install') return handleInstall(args, flags, opts);
  return {
    success: false,
    error: `forge hooks supports: install, session-start, inbox-pickup.\n${usage()}`,
  };
}

module.exports = {
  name: 'hooks',
  description: 'Opt-in install of Forge native hooks into GLOBAL harness config (Codex/Hermes)',
  usage: usage(),
  flags: {
    '--global': 'Required consent flag — this command writes home-directory config',
    '--harness': 'codex | hermes | all (default: all)',
    '--dry-run': 'Preview the merge without writing anything',
  },
  handler,
};
