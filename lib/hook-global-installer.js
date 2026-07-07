'use strict';

/**
 * Opt-in GLOBAL-config native hook installer for the two harnesses whose hook
 * surface lives in home-directory config, which project `forge setup`
 * intentionally never writes (kernel issue 66dd5a1f, epics 90f2f631 + 1390e1d1):
 *
 *   - Codex  : `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) — the
 *              `[[hooks.PreToolUse]]` groups rendered by renderCodexHooksToml.
 *   - Hermes : `~/.hermes/config.yaml` — the `hooks:`/`pre_tool_call:` shell-hook
 *              entries rendered by renderHermesHooksYaml.
 *
 * CONSENT-GUARDED: this module only runs from `forge hooks install --global`
 * (lib/commands/hooks.js), never from project setup. Same discipline as
 * lib/hook-renderer.js / lib/mcp-config-renderer.js: read → MERGE → write,
 * idempotent via the `forge-native-hook.js` marker, unparseable-for-merging
 * existing config → backed up (backupFile) + skipped, never overwritten.
 *
 * ADAPTER-PATH RESOLUTION (why a project-relative command works in global config):
 * the rendered commands invoke `node .forge/hooks/forge-native-hook.js ...`
 * RELATIVE to the harness's working directory. Codex and Hermes execute hook
 * commands from the workspace root (S7/S16 in lib/harness-capability-matrix.js),
 * so inside any Forge-initialized project the command resolves to THAT project's
 * installed adapter. In a directory without `.forge/hooks/forge-native-hook.js`
 * (a non-Forge project), node exits non-zero WITHOUT emitting a deny decision on
 * stdout — both harnesses only block on an explicit decision payload, so the
 * hook fails OPEN and Forge enforcement simply does not apply there.
 *
 * Dependency-free (no TOML/YAML lib): the mergers are conservative line-based
 * block editors that refuse (HookConfigParseError) any existing shape they
 * cannot merge into without risking corruption.
 *
 * @module hook-global-installer
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FORGE_HOOK_CONTRACT,
  FORGE_HOOK_MARKER,
  HookConfigParseError,
  renderCodexHooksToml,
  renderHermesHooksYaml,
} = require('./hook-renderer');
const { backupFile } = require('./mcp-config-renderer');
const { resolveCodexHome } = require('./codex-skills');

/** The harnesses whose native hooks live in GLOBAL (home-dir) config. */
const GLOBAL_HOOK_HARNESSES = ['codex', 'hermes'];

/**
 * Resolve the global hook config file for a harness.
 * Codex honors $CODEX_HOME (same resolution as lib/codex-skills.js / #311).
 * @param {'codex'|'hermes'} harness
 * @param {{ env?: object, homeDir?: string }} [options]
 * @returns {string} absolute config file path
 */
function resolveGlobalHookFile(harness, options = {}) {
  if (harness === 'codex') {
    return path.join(resolveCodexHome(options), 'config.toml');
  }
  if (harness === 'hermes') {
    return path.join(options.homeDir || os.homedir(), '.hermes', 'config.yaml');
  }
  throw new Error(`Harness '${harness}' has no global hook config surface`);
}

function normalizedTomlHeader(line) {
  return line.trim().replace(/\s+/g, '');
}

/**
 * Remove Forge-owned `[[hooks.PreToolUse]]` groups (a group = the PreToolUse
 * header segment plus its immediately-following `[[hooks.PreToolUse.hooks]]`
 * segments) whose lines carry the forge-native-hook.js marker. Everything else
 * — user tables, comments, user hook groups — is preserved verbatim.
 */
function stripForgeCodexHookGroups(text) {
  const lines = String(text).split('\n');
  const segments = [];
  let current = { header: null, lines: [] };
  for (const line of lines) {
    if (line.trim().startsWith('[')) {
      segments.push(current);
      current = { header: normalizedTomlHeader(line), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  segments.push(current);

  const out = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.header === '[[hooks.PreToolUse]]') {
      const group = [seg];
      let j = i + 1;
      while (j < segments.length && segments[j].header === '[[hooks.PreToolUse.hooks]]') {
        group.push(segments[j]);
        j += 1;
      }
      const forgeOwned = group.some(s => s.lines.some(l => l.includes(FORGE_HOOK_MARKER)));
      if (!forgeOwned) {
        for (const s of group) out.push(...s.lines);
      }
      i = j - 1;
    } else {
      out.push(...seg.lines);
    }
  }
  return out.join('\n');
}

/** True when the `[hooks]` table section assigns PreToolUse as a plain key. */
function hooksTableAssignsPreToolUse(text) {
  const lines = String(text).split('\n');
  let inHooksTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inHooksTable = normalizedTomlHeader(line) === '[hooks]';
      continue;
    }
    if (inHooksTable && /^PreToolUse\s*=/.test(trimmed)) return true;
  }
  return false;
}

/**
 * Merge Forge's `[[hooks.PreToolUse]]` groups into an existing Codex global
 * `config.toml` string. Preserves ALL existing user config (idempotent via the
 * forge-native-hook.js marker). TOML permits re-opening an array-of-tables
 * later in the document, so appending fresh Forge groups after the preserved
 * content is always valid — UNLESS `hooks.PreToolUse` already exists in a
 * non-array shape, which is refused with HookConfigParseError (never corrupt).
 * @param {string} existingText
 * @param {object} [contract]
 * @returns {string}
 */
function mergeCodexGlobalConfigToml(existingText, contract = FORGE_HOOK_CONTRACT) {
  const text = String(existingText || '');
  const hasPlainPreToolUseTable = text
    .split('\n')
    .some(line => normalizedTomlHeader(line) === '[hooks.PreToolUse]');
  if (hasPlainPreToolUseTable || hooksTableAssignsPreToolUse(text)) {
    throw new HookConfigParseError(
      'existing config defines hooks.PreToolUse in a non-array shape; appending '
      + '[[hooks.PreToolUse]] would corrupt the file',
    );
  }

  const preamble = stripForgeCodexHookGroups(text).replace(/\s+$/, '');
  const rendered = renderCodexHooksToml(contract);
  const result = (preamble ? preamble + '\n\n' : '') + rendered;
  return result.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

/** The rendered Hermes pre_tool_call list items, re-indented to `itemIndent` spaces. */
function hermesForgeItems(contract, itemIndent) {
  // renderHermesHooksYaml emits `hooks:\n  pre_tool_call:\n` then item lines at a
  // 4-space base indent; strip the first two lines and re-base the indentation.
  const rendered = renderHermesHooksYaml(contract).split('\n');
  return rendered
    .slice(2)
    .filter(line => line.trim().length > 0)
    .map(line => ' '.repeat(itemIndent) + line.slice(4));
}

/** Split a YAML block-sequence body into items (each starting at a `- ` line). */
function splitYamlListItems(lines) {
  const items = [];
  let current = null;
  for (const line of lines) {
    if (/^\s*- /.test(line)) {
      if (current) items.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      // Content before the first `- ` item (comments/blank lines) — keep as its own chunk.
      items.push([line]);
    }
  }
  if (current) items.push(current);
  return items;
}

/**
 * Merge Forge's `pre_tool_call` shell-hook entries into an existing Hermes
 * global `config.yaml` string. Preserves all user keys, the user's own hook
 * entries, and other hook events; replaces only Forge-owned entries
 * (idempotent via the forge-native-hook.js marker). Shapes it cannot merge
 * without risking corruption (tabs, inline `hooks:`/`pre_tool_call:` values)
 * are refused with HookConfigParseError so the caller backs up + skips.
 * @param {string} existingText
 * @param {object} [contract]
 * @returns {string}
 */
function mergeHermesGlobalConfigYaml(existingText, contract = FORGE_HOOK_CONTRACT) {
  const text = String(existingText || '');
  if (!text.trim()) return renderHermesHooksYaml(contract);
  if (text.includes('\t')) {
    throw new HookConfigParseError('existing Hermes config contains tabs — cannot merge safely');
  }

  const lines = text.split('\n');
  const inlineHooks = lines.some(l => /^hooks:\s*[^\s#]/.test(l));
  if (inlineHooks) {
    throw new HookConfigParseError(
      'existing `hooks:` key has an inline value Forge cannot merge into',
    );
  }

  const hooksIdx = lines.findIndex(l => /^hooks:\s*(#.*)?$/.test(l));
  if (hooksIdx === -1) {
    const base = text.replace(/\s+$/, '');
    return base + '\n\n' + renderHermesHooksYaml(contract);
  }

  // The hooks block spans until the next non-blank line at column 0.
  let hooksEnd = hooksIdx + 1;
  while (hooksEnd < lines.length && !(lines[hooksEnd] && /^\S/.test(lines[hooksEnd]))) {
    hooksEnd += 1;
  }
  const block = lines.slice(hooksIdx + 1, hooksEnd);

  const preToolRel = block.findIndex(l => /^\s+pre_tool_call:\s*(#.*)?$/.test(l));
  const inlinePreTool = block.some(l => /^\s+pre_tool_call:\s*[^\s#]/.test(l));
  if (inlinePreTool) {
    throw new HookConfigParseError(
      'existing `pre_tool_call:` key has an inline value Forge cannot merge into',
    );
  }

  let newBlock;
  if (preToolRel === -1) {
    // No pre_tool_call event yet — append ours at the end of the hooks block.
    newBlock = [...block, '  pre_tool_call:', ...hermesForgeItems(contract, 4)];
  } else {
    const keyIndent = (block[preToolRel].match(/^\s*/) || [''])[0].length;
    // The pre_tool_call sub-block spans until the next non-blank line indented
    // at or shallower than the key itself.
    let subEnd = preToolRel + 1;
    while (subEnd < block.length) {
      const line = block[subEnd];
      if (line.trim() && (line.match(/^\s*/) || [''])[0].length <= keyIndent) break;
      subEnd += 1;
    }
    const subBody = block.slice(preToolRel + 1, subEnd);
    const kept = splitYamlListItems(subBody)
      .filter(item => !item.some(l => l.includes(FORGE_HOOK_MARKER)))
      .flat();
    const firstItem = subBody.find(l => /^\s*- /.test(l));
    const itemIndent = firstItem ? (firstItem.match(/^\s*/) || [''])[0].length : keyIndent + 2;
    newBlock = [
      ...block.slice(0, preToolRel + 1),
      ...kept,
      ...hermesForgeItems(contract, itemIndent),
      ...block.slice(subEnd),
    ];
  }

  const merged = [...lines.slice(0, hooksIdx + 1), ...newBlock, ...lines.slice(hooksEnd)];
  return merged.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

const GLOBAL_MERGERS = {
  codex: mergeCodexGlobalConfigToml,
  hermes: mergeHermesGlobalConfigYaml,
};

/** The Forge hook block a harness's global config receives (for consent output). */
function renderGlobalHookBlock(harness, contract = FORGE_HOOK_CONTRACT) {
  if (harness === 'codex') return renderCodexHooksToml(contract);
  if (harness === 'hermes') return renderHermesHooksYaml(contract);
  throw new Error(`Harness '${harness}' has no global hook config surface`);
}

/**
 * Install (merge) Forge's native hooks into the GLOBAL configs of the given
 * harnesses. Read → merge → write; dry-run returns previews without touching
 * disk (no writes, no directories, no backups). Unmergeable existing config is
 * backed up (backupFile) and skipped — never overwritten.
 *
 * @param {object} [params]
 * @param {string[]} [params.harnesses] - subset of GLOBAL_HOOK_HARNESSES
 * @param {boolean}  [params.dryRun]
 * @param {object}   [params.env]      - env override (CODEX_HOME resolution / tests)
 * @param {string}   [params.homeDir]  - home-dir override (tests)
 * @param {object}   [params.contract]
 * @returns {Array<{ harness: string, file: string, existed: boolean, wrote: boolean,
 *                   skipped: boolean, changed?: boolean, dryRun?: boolean,
 *                   preview?: string, backup?: string, reason?: string }>}
 */
function installGlobalHooks({
  harnesses = GLOBAL_HOOK_HARNESSES,
  dryRun = false,
  env,
  homeDir,
  contract = FORGE_HOOK_CONTRACT,
} = {}) {
  return harnesses.map((harness) => {
    const merge = GLOBAL_MERGERS[harness];
    if (!merge) throw new Error(`Harness '${harness}' has no global hook config surface`);

    const file = resolveGlobalHookFile(harness, { env, homeDir });
    const existed = fs.existsSync(file);
    const existing = existed ? fs.readFileSync(file, 'utf-8') : '';

    let merged;
    try {
      merged = merge(existing, contract);
    } catch (err) {
      if (err instanceof HookConfigParseError) {
        const result = {
          harness, file, existed, wrote: false, skipped: true, reason: err.message,
        };
        if (dryRun) return { ...result, dryRun: true };
        if (existed) result.backup = backupFile(file);
        return result;
      }
      throw err;
    }

    const changed = merged !== existing;
    if (dryRun) {
      return {
        harness, file, existed, wrote: false, skipped: false,
        changed, dryRun: true, preview: merged,
      };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (changed) fs.writeFileSync(file, merged, 'utf-8');
    return { harness, file, existed, wrote: true, skipped: false, changed };
  });
}

module.exports = {
  GLOBAL_HOOK_HARNESSES,
  resolveGlobalHookFile,
  mergeCodexGlobalConfigToml,
  mergeHermesGlobalConfigYaml,
  renderGlobalHookBlock,
  installGlobalHooks,
};
