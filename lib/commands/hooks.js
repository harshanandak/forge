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

function usage() {
  return 'Usage: forge hooks install --global [--harness codex|hermes|all] [--dry-run]';
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

async function handler(args, flags = {}, _projectRoot, opts = {}) {
  const action = args[0];
  if (action !== 'install') {
    return {
      success: false,
      error: `forge hooks supports one action: install.\n${usage()}`,
    };
  }

  const parsed = parseInstallArgs(args.slice(1));
  const dryRun = parsed.dryRun || Boolean(flags.dryRun);

  if (parsed.unknown.length > 0) {
    return { success: false, error: `Unknown argument(s): ${parsed.unknown.join(' ')}\n${usage()}` };
  }

  if (!parsed.global) {
    return {
      success: false,
      error: [
        'forge hooks install writes GLOBAL (home-directory) harness config:',
        '  - Codex : $CODEX_HOME/config.toml (default ~/.codex/config.toml)',
        '  - Hermes: ~/.hermes/config.yaml',
        'Global config affects EVERY project on this machine, so Forge never writes it',
        'silently — re-run with the explicit --global flag to consent, and add --dry-run',
        'first to preview exactly what would be written.',
        usage(),
      ].join('\n'),
    };
  }

  const harnesses = parsed.harness === 'all' ? GLOBAL_HOOK_HARNESSES : [parsed.harness];
  if (!harnesses.every(h => GLOBAL_HOOK_HARNESSES.includes(h))) {
    return {
      success: false,
      error: `Unknown --harness '${parsed.harness}'. Allowed: codex, hermes, all.\n${usage()}`,
    };
  }

  // env/homeDir are injectable through the command opts so tests never touch the
  // real home directory; real dispatch passes neither and gets the defaults.
  const env = opts.env || process.env;
  const homeDir = opts.homeDir; // undefined → os.homedir()

  const out = [];
  out.push(dryRun
    ? 'forge hooks install --global (dry-run — nothing will be written)'
    : 'forge hooks install --global');
  out.push('');
  out.push('This merges the following Forge hook block into each GLOBAL config,');
  out.push('preserving all existing user config (idempotent re-runs):');

  const results = installGlobalHooks({ harnesses, dryRun, env, homeDir });

  for (const res of results) {
    out.push('');
    out.push(`${res.harness} -> ${res.file}`);
    if (res.skipped) {
      out.push(`  SKIPPED (left untouched): ${res.reason}`);
      if (res.backup) out.push(`  Backed up existing file to: ${res.backup} (.bak)`);
      else if (dryRun) out.push('  (dry-run: existing file would be backed up to a .bak and skipped)');
      continue;
    }
    out.push(indent(renderGlobalHookBlock(res.harness), '    '));
    if (dryRun) {
      out.push(res.changed === false
        ? '  [dry-run] already up to date — a real run would change nothing'
        : '  [dry-run] would merge the block above into this file');
    } else {
      out.push(res.changed === false
        ? '  Already up to date (no changes written).'
        : `  Merged Forge hooks into ${res.existed ? 'existing' : 'new'} config.`);
    }
  }

  out.push('');
  out.push('Note: the hook commands invoke `node .forge/hooks/forge-native-hook.js` relative');
  out.push('to the workspace root (Codex and Hermes run hooks from there), so enforcement');
  out.push('applies inside Forge-initialized projects; elsewhere the adapter is absent and');
  out.push('the hook fails open (no deny decision is emitted), leaving tool calls untouched.');

  return { success: true, output: out.join('\n'), results };
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
