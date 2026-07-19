'use strict';

/**
 * Per-harness native HOOK config renderer.
 *
 * Projects Forge's lifecycle enforcement — the TDD gate (source changes require
 * tests) and the protected-path guard — onto each harness's REAL native hook
 * surface, using read → merge → write (idempotent, preserves user hooks). This is
 * the hook analogue of lib/mcp-config-renderer.js and closes the honesty gap that
 * #311 recorded: the capability matrix advertised native hooks that no renderer
 * actually wrote.
 *
 * Verified native hook surfaces:
 *   - Claude : `.claude/settings.json`  → a `hooks` block
 *              (PreToolUse matcher groups → { type:'command', command })
 *   - Cursor : `.cursor/hooks.json`      → { version: 1, hooks: { <event>: [ { command } ] } }
 *              (Cursor 1.7+; only `before*` events can DENY — there is NO pre-edit
 *               deny event, so protected-path write-blocking + commit gating run on
 *               `beforeShellExecution`, and `afterFileEdit` is an observational audit.)
 *   - Codex  : `.codex/config.toml`      → `[hooks]` matcher groups. Codex reads the
 *              GLOBAL `~/.codex/config.toml` (per #311 / lib/agents-config.js), so
 *              project `forge setup` MUST NOT write it. Rendered + tested here for a
 *              global-config follow-up only.
 *   - Hermes : `~/.hermes/config.yaml`   → a `hooks:` block of shell hooks (matcher +
 *              command; JSON-stdin/stdout wire protocol). A `pre_tool_call` hook CAN
 *              deny a tool call (it even accepts Claude's {decision:block} shape). Lives
 *              in GLOBAL (home) config, so project `forge setup` MUST NOT write it —
 *              rendered + tested here for a global-config follow-up only.
 *
 * The rendered `command` invokes Forge's installed native-hook adapter
 * (`.forge/hooks/forge-native-hook.js`), which the setup flow installs alongside
 * `.forge/hooks/check-tdd.js`. The adapter reads the harness's hook stdin, enforces
 * the protected-path set, and delegates the TDD gate to the real `check-tdd.js`.
 *
 * Dependency-free (JSON only; no TOML lib) so it runs under `bun test` and the
 * release gates. Reuses the MCP renderer's `backupFile` for the data-loss guard.
 *
 * @module hook-renderer
 */

const fs = require('node:fs');
const path = require('node:path');
const { backupFile } = require('./mcp-config-renderer');

const HARNESS_HOOK_FILES = {
  claude: '.claude/settings.json',
  cursor: '.cursor/hooks.json',
  codex: '.codex/config.toml',
  hermes: '~/.hermes/config.yaml',
};

// The adapter Forge installs into every project (see lib/commands/setup.js). The
// stable `forge-native-hook.js` token also MARKS Forge-owned hook entries so a
// re-merge replaces them in place instead of duplicating (idempotency) and never
// clobbers a user's own hooks.
const FORGE_HOOK_ADAPTER_REL = '.forge/hooks/forge-native-hook.js';
const FORGE_HOOK_ADAPTER = `node ${FORGE_HOOK_ADAPTER_REL}`;
const FORGE_HOOK_MARKER = 'forge-native-hook.js';

// CONTEXT intents route to the `forge` CLI (which loads lib/), NOT the self-contained
// adapter — memory injection needs kernel/FTS access and must FAIL OPEN. The marker
// token below stamps Forge-owned context-hook entries so a re-merge replaces them in
// place (idempotency), the same role FORGE_HOOK_MARKER plays for enforcement entries.
//
// The command is a RESOLVED `node <abs bin/forge.js>` invocation — NOT a bare `forge`.
// A bare `forge` on a hook's minimal PATH either does not resolve (feature silently
// never fires) or resolves to the WRONG binary (e.g. a global `forge` that misroutes),
// whose stdout would then be injected as session context. Resolving the exact CLI that
// rendered the hook (via __dirname, works in the repo and under node_modules) removes
// both failure modes. FORGE_CONTEXT_MARKER is the stable idempotency token.
const FORGE_CLI_BIN = path.join(__dirname, '..', 'bin', 'forge.js');
const FORGE_CLI = `node "${FORGE_CLI_BIN}"`;
const FORGE_CONTEXT_MARKER = 'hooks session-start';
// The inbox-pickup context hook (UserPromptSubmit tier). A SECOND context marker so a
// re-merge recognizes + replaces the Forge-owned UserPromptSubmit entry in place, exactly
// as FORGE_CONTEXT_MARKER does for the SessionStart entry.
const FORGE_INBOX_CONTEXT_MARKER = 'hooks inbox-pickup';
// The PR-shepherd events context hook (a SECOND UserPromptSubmit-tier hook). Its own
// marker so a re-merge recognizes + replaces the Forge-owned entry in place. The whole
// Forge UserPromptSubmit group is already recognized via the inbox marker, but this keeps
// the shepherd-events command independently identifiable (symmetry with the other tiers).
const FORGE_SHEPHERD_EVENTS_MARKER = 'hooks shepherd-events';
// The capture-on-exit context hook (PreCompact + Stop tier). A THIRD context marker so a
// re-merge recognizes + replaces the Forge-owned PreCompact/Stop entries in place. Both
// events share this one marker (they differ only by a --trigger suffix on the command).
//
// It matches the FULL resolved Forge invocation (`node "<abs bin/forge.js>" hooks capture`),
// NOT the bare `hooks capture` verb: a bare-substring check would treat ANY user hook command
// that merely mentions "hooks capture" as Forge-owned and DELETE it on re-merge (data-integrity
// bug, CodeRabbit on #397). Only Forge's own rendered capture command contains this prefix, so
// the merge replaces exactly Forge's group and preserves the user's.
const FORGE_CAPTURE_CONTEXT_MARKER = `${FORGE_CLI} hooks capture`;

// Per-harness SessionStart HOOK-render capability. This constant governs ONE thing: whether
// Forge renders a harness-native SessionStart *hook* that injects additionalContext. Only Claude
// exposes that surface, so only Claude is rendered:true. Every other harness is rendered:false
// with an HONEST reason naming WHERE the same dispatch bootstrap is delivered instead — because
// the bootstrap is NOT Claude-only, it just travels a different always-on surface per harness
// (see BOOTSTRAP_DELIVERY below): Cursor auto-applies an always-on rule (.cursor/rules/*.mdc,
// alwaysApply:true); Codex reads the committed project-local AGENTS.md every session; Hermes
// consumes it through the forge CLI (forge prime/orient + forge skill for). We NEVER fake parity
// and NEVER branch on harness identity at runtime — delivery is keyed by SURFACE TYPE.
const SESSION_START_SUPPORT = Object.freeze({
  claude: Object.freeze({ rendered: true }),
  cursor: Object.freeze({ rendered: false, reason: 'delivered-via-rule-surface' }),
  codex: Object.freeze({ rendered: false, reason: 'delivered-via-agents-md' }),
  hermes: Object.freeze({ rendered: false, reason: 'delivered-via-cli-fallback' }),
});

// Where the using-forge dispatch BOOTSTRAP reaches each harness EVERY session. Data, not
// identity-branching: the parity gate iterates this so no harness is silently left with no
// auto-surface. Only Claude's is a native SessionStart hook; the rest are equally always-on
// surfaces (a Cursor always-apply rule, the committed AGENTS.md for Codex, the forge CLI as an
// honest fallback for Hermes). All four ALSO carry the full using-forge SKILL.md via the synced
// skill mirrors. 'cli-fallback' is the explicit honest-fallback marker (no faked native surface).
const BOOTSTRAP_DELIVERY = Object.freeze({
  claude: 'session-start-hook',
  cursor: 'always-apply-rule',
  codex: 'agents-md',
  hermes: 'cli-fallback',
});

// Per-harness UserPromptSubmit context-injection capability (the near-real-time inbox
// tier). Only Claude has a verified UserPromptSubmit surface that injects
// additionalContext alongside the submitted prompt. Same honesty rule as SessionStart:
// every non-Claude harness carries an explicit, tested skip reason — no faked parity.
const USER_PROMPT_SUBMIT_SUPPORT = Object.freeze({
  claude: Object.freeze({ rendered: true }),
  cursor: Object.freeze({ rendered: false, reason: 'no-user-prompt-surface' }),
  codex: Object.freeze({ rendered: false, reason: 'global-config' }),
  hermes: Object.freeze({ rendered: false, reason: 'global-config' }),
});

// Per-harness session-END (capture-on-exit) capability. Only Claude exposes native
// PreCompact + Stop hook surfaces where Forge can snapshot session learnings BEFORE
// context is compacted or the session ends. Cursor 1.7 hooks are deny-oriented with no
// session-end surface; Codex and Hermes hooks live in GLOBAL home config project setup
// never writes. Same honesty rule as the other context tiers — no faked parity.
const SESSION_END_SUPPORT = Object.freeze({
  claude: Object.freeze({ rendered: true }),
  cursor: Object.freeze({ rendered: false, reason: 'no-session-end-surface' }),
  codex: Object.freeze({ rendered: false, reason: 'global-config' }),
  hermes: Object.freeze({ rendered: false, reason: 'global-config' }),
});

// Claude exposes $CLAUDE_PROJECT_DIR (absolute project root) to hook commands and
// documents it as THE cwd-independent way to reference project-local hook scripts —
// a bare relative path breaks whenever Claude runs the hook from another cwd. Cursor
// and Codex execute hooks from the workspace root, so a repo-relative path resolves.
function adapterInvocation(harness) {
  if (harness === 'claude') return `node "$CLAUDE_PROJECT_DIR/${FORGE_HOOK_ADAPTER_REL}"`;
  return FORGE_HOOK_ADAPTER;
}

/**
 * The frozen Forge hook contract: the two enforcement intents projected onto each
 * harness. Order matters — protected-path (per-write) is listed before tdd-gate
 * (per-commit) so the rendered Claude PreToolUse groups read write-guard first.
 */
const FORGE_HOOK_CONTRACT = Object.freeze({
  schemaVersion: '1.2.0',
  kind: 'forge.hookContract',
  adapter: FORGE_HOOK_ADAPTER,
  intents: Object.freeze([
    Object.freeze({
      id: 'protected-path',
      kind: 'enforcement',
      enforces: 'Protected-path guard: block writes/edits to Forge-protected paths (.forge/, .git/, AGENTS.md, secrets, generated artifacts).',
      lifecycle: 'pre-write',
      command: `${FORGE_HOOK_ADAPTER} --intent protected-path`,
    }),
    Object.freeze({
      id: 'tdd-gate',
      kind: 'enforcement',
      enforces: 'TDD gate: source changes must ship with accompanying tests (blocks bare git commit).',
      lifecycle: 'pre-commit',
      command: `${FORGE_HOOK_ADAPTER} --intent tdd-gate`,
    }),
    Object.freeze({
      id: 'memory-inject',
      kind: 'context',
      cliAction: 'session-start',
      enforces: 'Memory push: inject a bounded, token-capped digest (remembered notes + top open issues) at session start. Additive and FAIL-OPEN — a missing digest never blocks a session.',
      lifecycle: 'session-start',
      command: `${FORGE_CLI} hooks session-start`,
    }),
    Object.freeze({
      id: 'inbox-pickup',
      kind: 'context',
      cliAction: 'inbox-pickup',
      // COMPLIANT COMMENT-BACK: surfaces pending targeted dashboard instruction comments
      // (kernel DATA, fenced) on each prompt. Reads the user's own kernel data via a
      // supported hook — NEVER injects into a running session's stdin, never drives the
      // agent programmatically (Anthropic Usage Policy, kernel issue 6d10c1a1).
      enforces: 'Comment-back pickup: surface a compact count+pointer nudge for pending targeted dashboard instruction comments on each UserPromptSubmit (compact to avoid additionalContext accumulation; full fenced digest is at SessionStart + `forge inbox`). Additive and FAIL-OPEN — a missing nudge never blocks a prompt.',
      lifecycle: 'user-prompt-submit',
      command: `${FORGE_CLI} hooks inbox-pickup`,
    }),
    Object.freeze({
      id: 'shepherd-events',
      kind: 'context',
      cliAction: 'shepherd-events',
      // PR-SHEPHERD DELTAS: surfaces a compact, capped digest of NEW PR-monitor events
      // (verdict changes, failed checks, new threads, merged/closed) since the last read,
      // then advances the per-PR consumer cursor. This is the CONSUMER side of the constant
      // watcher — the watch loop writes the journal, this pushes the deltas each turn. Reads
      // the user's OWN local journal via a supported hook — NEVER stdin injection, never
      // drives the agent (Anthropic Usage Policy).
      enforces: 'PR shepherd events: on each UserPromptSubmit, surface a compact, capped digest of NEW PR-monitor events (verdict changes, failed checks, new threads, merged/closed) since the last read across open-PR journals, then advance the cursor. Compact to avoid additionalContext accumulation. Additive and FAIL-OPEN — a missing digest never blocks a prompt.',
      lifecycle: 'user-prompt-submit',
      command: `${FORGE_CLI} hooks shepherd-events`,
    }),
    Object.freeze({
      id: 'memory-capture',
      kind: 'context',
      cliAction: 'capture',
      // CAPTURE-ON-EXIT: the write half of Forge memory. SessionStart INJECTS remembered
      // notes but nothing ever CAPTURES on the way out, so long sessions lose learnings and
      // memory stays orphaned (the eval scored memory pull-only). PreCompact + Stop fire this
      // to snapshot a bounded session-summary note BEFORE context is compacted / the session
      // ends. Persists to the memory store — it NEVER injects into the turn and never drives
      // the agent (Anthropic Usage Policy). The trigger (precompact|stop) rides as a --trigger
      // suffix stamped by the rendered hook, so the CLI never has to read hook stdin.
      enforces: 'Capture-on-exit: snapshot a bounded session-summary note (trigger + in-progress issues) into the memory store on PreCompact and Stop, BEFORE context is compacted or the session ends. Additive and FAIL-OPEN — a capture failure never blocks a session.',
      lifecycle: 'session-end',
      command: `${FORGE_CLI} hooks capture`,
    }),
  ]),
});

/** Thrown when an existing hook config cannot be parsed — signals "do not overwrite". */
class HookConfigParseError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'HookConfigParseError';
    this.cause = cause;
  }
}

function intentById(contract, id) {
  const intent = contract.intents.find(i => i.id === id);
  if (!intent) throw new Error(`Forge hook contract is missing intent '${id}'`);
  return intent;
}

function harnessCommand(contract, id, harness) {
  const intent = intentById(contract, id);
  // CONTEXT intents route to the `forge` CLI (fail-open memory injection), NOT the
  // self-contained enforcement adapter. Hooks often run with a minimal PATH; if `forge`
  // does not resolve the command simply fails and the harness ignores it (fail-open).
  if (intent.kind === 'context') {
    return `${FORGE_CLI} hooks ${intent.cliAction} --harness ${harness}`;
  }
  // ENFORCEMENT intents build from the harness-specific adapter invocation (Claude →
  // $CLAUDE_PROJECT_DIR; Cursor/Codex → repo-relative). intent.id is the `--intent` value.
  return `${adapterInvocation(harness)} --intent ${intent.id} --harness ${harness}`;
}

/**
 * Report the per-harness SessionStart context-injection capability (the honest matrix).
 * @param {string} harness
 * @returns {{ rendered: boolean, reason?: string }}
 */
function sessionStartCapability(harness) {
  return SESSION_START_SUPPORT[harness] || { rendered: false, reason: 'unknown-harness' };
}

/**
 * Report the per-harness UserPromptSubmit context-injection capability (the honest matrix
 * for the near-real-time inbox tier).
 * @param {string} harness
 * @returns {{ rendered: boolean, reason?: string }}
 */
function userPromptSubmitCapability(harness) {
  return USER_PROMPT_SUBMIT_SUPPORT[harness] || { rendered: false, reason: 'unknown-harness' };
}

/**
 * Report the per-harness session-END (capture-on-exit) capability (the honest matrix for
 * the PreCompact + Stop capture tier).
 * @param {string} harness
 * @returns {{ rendered: boolean, reason?: string }}
 */
function sessionEndCapability(harness) {
  return SESSION_END_SUPPORT[harness] || { rendered: false, reason: 'unknown-harness' };
}

/**
 * Render the Claude `.claude/settings.json` `hooks` block (PreToolUse groups only).
 * Write/Edit/MultiEdit/NotebookEdit → protected-path deny; Bash → TDD gate.
 * @param {object} contract
 * @returns {{ PreToolUse: object[] }}
 */
function renderClaudeHooks(contract) {
  return {
    PreToolUse: [
      {
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: harnessCommand(contract, 'protected-path', 'claude') }],
      },
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: harnessCommand(contract, 'tdd-gate', 'claude') }],
      },
    ],
    // SessionStart context injection (memory push). No matcher → applies to every
    // session source; the command emits { hookSpecificOutput.additionalContext }.
    SessionStart: [
      { hooks: [{ type: 'command', command: harnessCommand(contract, 'memory-inject', 'claude') }] },
    ],
    // UserPromptSubmit context injection (compliant comment-back — near-real-time tier).
    // Surfaces pending targeted dashboard instruction comments (fenced kernel DATA) on each
    // prompt; the command emits { hookSpecificOutput.additionalContext }. Reads the user's
    // own kernel data via a supported hook — NEVER stdin injection (Anthropic Usage Policy).
    // Both UserPromptSubmit context hooks share ONE Forge-owned group (inbox-pickup +
    // PR-shepherd deltas). Claude runs every hook in the group and appends each hook's
    // additionalContext; keeping them in one group means a re-merge replaces the pair
    // atomically (the group is Forge-owned via either marker). Both are compact + fail-open.
    UserPromptSubmit: [
      {
        hooks: [
          { type: 'command', command: harnessCommand(contract, 'inbox-pickup', 'claude') },
          { type: 'command', command: harnessCommand(contract, 'shepherd-events', 'claude') },
        ],
      },
    ],
    // Capture-on-exit (memory capture). PreCompact fires before context is compacted; Stop
    // fires when the agent finishes. Both call the same capture command; the event stamps the
    // --trigger so the CLI never reads hook stdin. The command persists a bounded session
    // summary — it emits NO stdout (a Stop hook that printed text would inject into the turn).
    PreCompact: [
      { hooks: [{ type: 'command', command: `${harnessCommand(contract, 'memory-capture', 'claude')} --trigger precompact` }] },
    ],
    Stop: [
      { hooks: [{ type: 'command', command: `${harnessCommand(contract, 'memory-capture', 'claude')} --trigger stop` }] },
    ],
  };
}

/**
 * Render the Cursor `.cursor/hooks.json` config. Cursor 1.7+ has NO pre-edit deny
 * event, so write-blocking + commit gating run on `beforeShellExecution` (git /
 * redirects), and `afterFileEdit` carries an observational protected-path audit.
 * @param {object} contract
 * @returns {{ version: number, hooks: object }}
 */
function renderCursorHooks(contract) {
  return {
    version: 1,
    hooks: {
      beforeShellExecution: [
        { command: harnessCommand(contract, 'tdd-gate', 'cursor') },
        { command: harnessCommand(contract, 'protected-path', 'cursor') },
      ],
      afterFileEdit: [
        { command: harnessCommand(contract, 'protected-path', 'cursor') },
      ],
    },
  };
}

/**
 * Render a Codex `[hooks]` TOML block (mirrors the Claude matcher-group model).
 * Returned for a GLOBAL-config follow-up ONLY — never written by project setup.
 * @param {object} contract
 * @returns {string}
 */
function renderCodexHooksToml(contract) {
  const groups = [
    { matcher: 'Write|Edit', command: harnessCommand(contract, 'protected-path', 'codex') },
    { matcher: 'Bash', command: harnessCommand(contract, 'tdd-gate', 'codex') },
  ];
  const blocks = groups.map(g =>
    `[[hooks.PreToolUse]]\nmatcher = ${tomlString(g.matcher)}\n\n`
    + `[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${tomlString(g.command)}\n`,
  );
  return blocks.join('\n');
}

function tomlString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Render a Hermes shell-hooks YAML block (the `hooks:` section of ~/.hermes/config.yaml).
 * Hermes runs shell hooks as subprocesses over a JSON-stdin/stdout wire protocol; a
 * `pre_tool_call` hook can DENY a tool call. Matchers are regexes over the Hermes
 * tool_name (write_file/patch = edits → protected-path; terminal = shell → tdd-gate).
 * Returned for a GLOBAL-config follow-up ONLY — Hermes reads ~/.hermes/config.yaml
 * (home dir), so project setup never writes it (mirrors renderCodexHooksToml).
 * @param {object} contract
 * @returns {string}
 */
function renderHermesHooksYaml(contract) {
  const groups = [
    { matcher: 'write_file|patch', command: harnessCommand(contract, 'protected-path', 'hermes') },
    { matcher: 'terminal', command: harnessCommand(contract, 'tdd-gate', 'hermes') },
  ];
  const lines = ['hooks:', '  pre_tool_call:'];
  for (const g of groups) {
    lines.push(`    - matcher: ${yamlString(g.matcher)}`);
    lines.push(`      command: ${yamlString(g.command)}`);
  }
  return lines.join('\n') + '\n';
}

function yamlString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** True when a command is Forge-owned — the enforcement adapter OR a context CLI hook. */
function isForgeCommand(command) {
  return typeof command === 'string'
    && (command.includes(FORGE_HOOK_MARKER)
      || command.includes(FORGE_CONTEXT_MARKER)
      || command.includes(FORGE_INBOX_CONTEXT_MARKER)
      || command.includes(FORGE_SHEPHERD_EVENTS_MARKER)
      || command.includes(FORGE_CAPTURE_CONTEXT_MARKER));
}

/** True when a hook group/entry is Forge-owned (any inner command is Forge-owned). */
function isForgeClaudeGroup(group) {
  const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
  return hooks.some(h => isForgeCommand(h?.command));
}

function isForgeCursorEntry(entry) {
  return isForgeCommand(entry?.command);
}

function parseJsonConfig(existingText) {
  if (!existingText || !existingText.trim()) return {};
  let obj;
  try {
    obj = JSON.parse(existingText);
  } catch (err) {
    // DATA-LOSS GUARD: never silently discard a populated-but-unparseable config
    // (JSONC comments / trailing commas). Signal the caller to back up + skip.
    throw new HookConfigParseError('existing hook config is not valid JSON', err);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  return obj;
}

/**
 * Merge Forge's hooks into an existing `.claude/settings.json` string.
 * Preserves all other settings keys, all non-Forge events, and the user's own
 * matcher-groups; replaces only Forge-owned groups (idempotent).
 * @param {string} existingText
 * @param {object} contract
 * @returns {string}
 */
function mergeClaudeSettings(existingText, contract) {
  const obj = parseJsonConfig(existingText);
  if (!obj.hooks || typeof obj.hooks !== 'object' || Array.isArray(obj.hooks)) obj.hooks = {};
  const rendered = renderClaudeHooks(contract);
  for (const [event, forgeGroups] of Object.entries(rendered)) {
    const existingGroups = Array.isArray(obj.hooks[event]) ? obj.hooks[event] : [];
    const userGroups = existingGroups.filter(group => !isForgeClaudeGroup(group));
    obj.hooks[event] = [...userGroups, ...forgeGroups];
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Merge Forge's hooks into an existing `.cursor/hooks.json` string.
 * Forces `version: 1`, preserves all non-Forge events and the user's own entries;
 * replaces only Forge-owned entries (idempotent).
 * @param {string} existingText
 * @param {object} contract
 * @returns {string}
 */
function mergeCursorHooks(existingText, contract) {
  const obj = parseJsonConfig(existingText);
  obj.version = 1;
  if (!obj.hooks || typeof obj.hooks !== 'object' || Array.isArray(obj.hooks)) obj.hooks = {};
  const rendered = renderCursorHooks(contract);
  for (const [event, forgeEntries] of Object.entries(rendered.hooks)) {
    const existingEntries = Array.isArray(obj.hooks[event]) ? obj.hooks[event] : [];
    const userEntries = existingEntries.filter(entry => !isForgeCursorEntry(entry));
    obj.hooks[event] = [...userEntries, ...forgeEntries];
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

const MERGERS = {
  claude: mergeClaudeSettings,
  cursor: mergeCursorHooks,
};

/**
 * Render (merge) Forge's native hooks into one harness's native config on disk.
 * Read → merge → write. Unparseable existing file → BACKED UP + left untouched
 * (never overwritten), mirroring the MCP renderer's data-loss safety.
 *
 * Codex is GLOBAL-config scope: project setup cannot write it, so this returns a
 * `scope: 'global-config'` skip WITHOUT touching disk (keeps Codex honest).
 *
 * @param {object} params
 * @param {'claude'|'cursor'|'codex'} params.harness
 * @param {string} params.targetRoot - Project root.
 * @param {object} [params.contract] - Forge hook contract (defaults to FORGE_HOOK_CONTRACT).
 * @returns {{ file?: string, existed?: boolean, skipped: boolean, wrote: boolean, backup?: string, scope?: string }}
 */
function renderHookConfig({ harness, targetRoot, contract = FORGE_HOOK_CONTRACT }) {
  if (harness === 'codex' || harness === 'hermes') {
    // Honest: Codex (~/.codex/config.toml) and Hermes (~/.hermes/config.yaml) hooks
    // both live in GLOBAL (home) config; project setup must not write global config.
    // Their renderers are kept + tested for a global-config follow-up.
    return { harness, scope: 'global-config', skipped: true, wrote: false };
  }
  const merge = MERGERS[harness];
  const rel = HARNESS_HOOK_FILES[harness];
  if (!merge || !rel) throw new Error(`Unknown hook harness: ${harness}`);

  const filePath = path.join(targetRoot, rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existed = fs.existsSync(filePath);
  const existing = existed ? fs.readFileSync(filePath, 'utf-8') : '';

  let merged;
  try {
    merged = merge(existing, contract);
  } catch (err) {
    if (err instanceof HookConfigParseError && existed) {
      const backup = backupFile(filePath);
      return { file: filePath, existed, skipped: true, wrote: false, backup };
    }
    throw err;
  }

  fs.writeFileSync(filePath, merged, 'utf-8');
  return { file: filePath, existed, skipped: false, wrote: true };
}

module.exports = {
  FORGE_HOOK_CONTRACT,
  HARNESS_HOOK_FILES,
  FORGE_HOOK_ADAPTER,
  FORGE_HOOK_MARKER,
  FORGE_CONTEXT_MARKER,
  FORGE_INBOX_CONTEXT_MARKER,
  FORGE_CAPTURE_CONTEXT_MARKER,
  SESSION_START_SUPPORT,
  BOOTSTRAP_DELIVERY,
  USER_PROMPT_SUBMIT_SUPPORT,
  SESSION_END_SUPPORT,
  sessionStartCapability,
  userPromptSubmitCapability,
  sessionEndCapability,
  HookConfigParseError,
  renderClaudeHooks,
  renderCursorHooks,
  renderCodexHooksToml,
  renderHermesHooksYaml,
  mergeClaudeSettings,
  mergeCursorHooks,
  renderHookConfig,
};
