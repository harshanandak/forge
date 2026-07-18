'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fenceUntrusted } = require('./untrusted-content');

const DEFAULT_BUDGET_TOKENS = 2000;
const MIN_BUDGET_TOKENS = 40;
const APPROX_CHARS_PER_TOKEN = 4;

function estimateTokens(value) {
  return Math.ceil(String(value || '').length / APPROX_CHARS_PER_TOKEN);
}

function normalizeBudgetTokens(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_BUDGET_TOKENS;
  return Math.max(MIN_BUDGET_TOKENS, Math.floor(parsed));
}

function toPosix(relativePath) {
  return relativePath.replaceAll(path.sep, '/');
}

function relativePath(projectRoot, filePath) {
  return toPosix(path.relative(projectRoot, filePath));
}

function readText(projectRoot, relativeFilePath) {
  const filePath = path.join(projectRoot, relativeFilePath);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function readJsonFile(projectRoot, relativeFilePath) {
  const text = readText(projectRoot, relativeFilePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    // Malformed JSON in a source file is treated as absent rather than fatal.
    return null;
  }
}

function readJsonl(projectRoot, relativeFilePath) {
  const text = readText(projectRoot, relativeFilePath);
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return {
          _parseError: true,
          line: index + 1,
          error: error.message,
        };
      }
    });
}

function firstLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || '';
}

function getRepositoryUrl(packageJson) {
  const repository = packageJson?.repository;
  if (typeof repository === 'string') return repository;
  if (repository && typeof repository.url === 'string') return repository.url;
  return null;
}

function buildProjectIdentity(projectRoot) {
  const packageJson = readJsonFile(projectRoot, 'package.json') || {};
  const designTitle = firstLine(readText(projectRoot, 'docs/PROJECT_DESIGN.md'));
  const projectName = packageJson.name || path.basename(projectRoot);

  return {
    name: projectName,
    version: packageJson.version || null,
    repository: getRepositoryUrl(packageJson),
    root: projectRoot,
    design_title: designTitle.replace(/^#\s*/, '') || null,
  };
}

function source(pathValue, kind, authority, role) {
  return {
    path: pathValue,
    source_kind: kind,
    authority,
    role,
  };
}

function buildSection({
  id,
  title,
  content,
  sources = [],
  priority = 100,
  preserve = false,
  data = null,
  untrustedSource = null,
}) {
  return {
    id,
    title,
    content: String(content || ''),
    sources,
    priority,
    preserve,
    truncated: false,
    estimated_tokens: estimateTokens(content),
    ...(data ? { data } : {}),
    // Carries a provenance label for sections whose content is untrusted external
    // data (e.g. remembered notes). The assembler fences these AFTER applyBudget.
    ...(untrustedSource ? { untrustedSource } : {}),
  };
}

/**
 * Provenance-fence any section carrying an `untrustedSource`, IN PLACE, AFTER applyBudget
 * has truncated it — so the ⟦END UNTRUSTED⟧ close marker always survives the budget cut
 * (fencing before truncation would let the budget sever the terminator). A planted
 * memory note or issue title is DATA, not instructions, once it reaches agent context.
 *
 * @param {object[]} sections
 * @returns {object[]} the same array, mutated.
 */
function fenceUntrustedSections(sections) {
  for (const section of sections) {
    if (section.untrustedSource && section.content) {
      section.content = fenceUntrusted(section.content, { source: section.untrustedSource });
      section.estimated_tokens = estimateTokens(section.content);
    }
  }
  return sections;
}

function extractCurrentDesignSnapshot(projectDesignText) {
  if (!projectDesignText) return '';

  const snapshotStart = projectDesignText.indexOf('## Current design snapshot');
  if (snapshotStart === -1) return '';

  const registryStart = projectDesignText.indexOf('## Decision registry', snapshotStart);
  const snapshot = registryStart === -1
    ? projectDesignText.slice(snapshotStart)
    : projectDesignText.slice(snapshotStart, registryStart);

  return snapshot.trim();
}

function parseYamlBlockValue(block, key) {
  const line = block
    .split(/\r?\n/)
    .find(candidate => candidate.trim().startsWith(`${key}:`));
  if (!line) return null;
  return line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '') || null;
}

function extractDecisionEntries(projectDesignText) {
  if (!projectDesignText) return [];

  const entries = [];
  const headingRegex = /^###\s+(PD-[^\r\n]+)/gm;
  const matches = [...projectDesignText.matchAll(headingRegex)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index;
    const end = matches[index + 1]?.index ?? projectDesignText.length;
    const block = projectDesignText.slice(start, end);
    const yaml = extractFencedYaml(block);
    const decisionText = extractCurrentDecision(block);
    entries.push({
      id: parseYamlBlockValue(yaml, 'id') || match[1].trim(),
      topic: parseYamlBlockValue(yaml, 'topic'),
      status: parseYamlBlockValue(yaml, 'status'),
      decision: decisionText,
    });
  }

  return entries;
}

function buildProjectDesignSections(projectRoot) {
  const projectDesignPath = 'docs/PROJECT_DESIGN.md';
  const projectDesignText = readText(projectRoot, projectDesignPath);
  if (!projectDesignText) return [];

  const projectDesignSource = source(projectDesignPath, 'project_doc', 'project_registry', 'project_design');
  const snapshot = extractCurrentDesignSnapshot(projectDesignText);
  const decisions = extractDecisionEntries(projectDesignText);
  const decisionContent = decisions
    .map(decision => [
      `- ${decision.id}`,
      decision.topic ? `  topic: ${decision.topic}` : null,
      decision.status ? `  status: ${decision.status}` : null,
      decision.decision ? `  decision: ${decision.decision}` : null,
    ].filter(Boolean).join('\n'))
    .join('\n');

  return [
    buildSection({
      id: 'current_design_snapshot',
      title: 'Current Design Snapshot',
      content: snapshot,
      sources: [projectDesignSource],
      priority: 70,
      preserve: false,
    }),
    buildSection({
      id: 'headline_decisions',
      title: 'Headline Decisions',
      content: decisionContent,
      sources: [projectDesignSource],
      priority: 10,
      preserve: true,
      data: { decisions },
    }),
  ];
}

function listWorkFolders(projectRoot) {
  const docsWork = path.join(projectRoot, 'docs', 'work');
  if (!fs.existsSync(docsWork)) return [];

  return fs.readdirSync(docsWork, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(docsWork, entry.name))
    .filter(folder => ['plan.md', 'design.md', 'tasks.md', 'decisions.md'].some(file => fs.existsSync(path.join(folder, file))))
    .sort((a, b) => {
      const aScore = ['plan.md', 'tasks.md', 'decisions.md'].filter(file => fs.existsSync(path.join(a, file))).length;
      const bScore = ['plan.md', 'tasks.md', 'decisions.md'].filter(file => fs.existsSync(path.join(b, file))).length;
      if (aScore !== bScore) return bScore - aScore;
      return relativePath(projectRoot, b).localeCompare(relativePath(projectRoot, a));
    });
}

// Locate a work-folder by its machine-readable `.forge-issue` marker (dropped by
// `forge worktree create --work-folder`). Deterministic folder → issue resolution that,
// unlike the "most-complete folder" heuristic, does not break under parallel features.
function findWorkFolderByIssue(projectRoot, issueId) {
  for (const folder of listWorkFolders(projectRoot)) {
    const markerPath = path.join(folder, '.forge-issue');
    try {
      if (fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf8').trim() === issueId) {
        return folder;
      }
    } catch { /* unreadable marker — skip */ }
  }
  return null;
}

// Read the current worktree's linkage row from the Kernel. Prefers an injected driver
// (tests / callers already holding one, never closed here); otherwise opens the Kernel
// DB read-only and closes it. Never throws: a missing/locked Kernel, an un-migrated DB,
// or a non-git project all return null so the caller falls back to the heuristic.
function readWorktreeLinkageRow(projectRoot, worktreePath, options) {
  if (options._kernelDriver) {
    try { return options._kernelDriver.getWorktreeLinkage({ path: worktreePath }) || null; }
    catch { return null; }
  }
  let driver;
  try {
    if (!fs.existsSync(path.join(projectRoot, '.git'))) return null; // no repo → no Kernel
    const { resolveKernelDatabasePath, buildKernelIssueDeps } = require('./kernel/cli-broker-factory');
    const databasePath = resolveKernelDatabasePath({ projectRoot });
    if (!databasePath || !fs.existsSync(databasePath)) return null; // no Kernel DB → heuristic
    driver = buildKernelIssueDeps({ projectRoot, databasePath }).kernelDriver;
    return driver.getWorktreeLinkage({ path: worktreePath }) || null;
  } catch {
    return null;
  } finally {
    if (driver && typeof driver.close === 'function') {
      try { driver.close(); } catch { /* ignore */ }
    }
  }
}

// Resolve the work-folder the Kernel linked to the current worktree (row.work_folder,
// else row.issue_id → `.forge-issue` marker), or null when there is no usable linkage.
function resolveKernelLinkedWorkFolder(projectRoot, options = {}) {
  const worktreePath = path.resolve(options.worktreePath || projectRoot);
  const row = readWorktreeLinkageRow(projectRoot, worktreePath, options);
  if (!row) return null;

  if (row.work_folder) {
    const resolved = path.resolve(projectRoot, row.work_folder);
    if (fs.existsSync(resolved)) return resolved;
  }
  if (row.issue_id) {
    const byMarker = findWorkFolderByIssue(projectRoot, row.issue_id);
    if (byMarker) return byMarker;
  }
  return null;
}

function discoverWorkFolder(projectRoot, options = {}) {
  if (options.workFolder) {
    const explicit = path.resolve(projectRoot, options.workFolder);
    if (fs.existsSync(explicit)) return explicit;
  }
  // Kernel linkage (issue → worktree → work-folder) is the backbone: when the current
  // worktree has a recorded row, it wins over the filesystem heuristic. Absent a row,
  // fall back to the most-complete-folder guess.
  const linked = resolveKernelLinkedWorkFolder(projectRoot, options);
  if (linked) return linked;
  return listWorkFolders(projectRoot)[0] || null;
}

function buildWorkArtifactSection(projectRoot, workFolder, artifact) {
  const filePath = path.join(workFolder, artifact.file);
  if (!fs.existsSync(filePath)) return null;

  const relative = relativePath(projectRoot, filePath);
  const artifactSource = source(relative, artifact.sourceKind, 'work_artifact', artifact.role);
  return buildSection({
    id: artifact.id,
    title: artifact.title,
    content: fs.readFileSync(filePath, 'utf8').trim(),
    sources: [artifactSource],
    priority: artifact.priority,
    preserve: artifact.preserve,
  });
}

function buildWorkSections(projectRoot, options = {}) {
  const workFolder = discoverWorkFolder(projectRoot, options);
  if (!workFolder) return [];

  const artifacts = [
    {
      file: 'decisions.md',
      id: 'active_work_decisions',
      title: 'Active Work Decisions',
      sourceKind: 'decision_log',
      role: 'active_work_decisions',
      priority: 20,
      preserve: true,
    },
    {
      file: 'plan.md',
      id: 'active_work_plan',
      title: 'Active Work Plan',
      sourceKind: 'work_plan',
      role: 'active_work_plan',
      priority: 30,
      preserve: false,
    },
    {
      file: 'tasks.md',
      id: 'active_work_tasks',
      title: 'Active Work Tasks',
      sourceKind: 'task_list',
      role: 'active_work_tasks',
      priority: 40,
      preserve: false,
    },
    {
      file: 'design.md',
      id: 'active_work_legacy_design',
      title: 'Active Work Legacy Design',
      sourceKind: 'legacy_work_design',
      role: 'active_work_legacy_design',
      priority: 80,
      preserve: false,
    },
  ];

  return artifacts
    .map(artifact => buildWorkArtifactSection(projectRoot, workFolder, artifact))
    .filter(Boolean)
    .map(section => ({
      ...section,
      work_folder: relativePath(projectRoot, workFolder),
    }));
}

function placeholderSection(id, title, content, role, preserve = false, priority = 90) {
  return buildSection({
    id,
    title,
    content,
    sources: [source(`kernel.${id}`, 'kernel_placeholder', 'future_kernel_read_model', role)],
    priority,
    preserve,
  });
}

// Cap on remembered notes surfaced in the orientation MEMORY section — a bounded
// nudge (applyBudget caps it further), not a full memory dump.
const MEMORY_SECTION_NOTE_LIMIT = 5;

/**
 * Best-effort MEMORY section: the newest remembered notes from the kernel-backed memory
 * store (the read half of `forge remember`/`recall` that was previously ORPHANED — an
 * agent only saw memory if it typed `forge recall`). Recent DECISIONS are already
 * surfaced by `headline_decisions` (from PROJECT_DESIGN.md), so this adds the missing
 * remembered-notes half without duplicating them. Never throws and never blocks orient:
 * a missing/locked kernel, or no notes, yields [] (the section is simply absent).
 *
 * @param {string} projectRoot
 * @param {object} [options] - forwarded to the memory read path (e.g. an injected `store`).
 * @returns {object[]} zero or one section.
 */
function buildMemorySection(projectRoot, options = {}) {
  // Own the store's lifecycle: when we open a kernel driver we MUST close it, so orient
  // never leaves a lingering DB handle (which strands Windows temp cleanup and is a
  // resource leak). An injected store (tests) is used as-is and never closed by us.
  const injected = options.store;
  const store = injected || openMemoryStore(projectRoot);
  if (!store) return [];
  try {
    // Lazy require: keep the default orient path free of the memory stack until needed.
    const memoryRouter = require('./memory/router');
    const result = memoryRouter.recall(projectRoot, { limit: MEMORY_SECTION_NOTE_LIMIT }, { store });
    const notes = Array.isArray(result && result.notes) ? result.notes : [];
    if (notes.length === 0) return [];
    return [buildSection({
      id: 'remembered_notes',
      title: 'Remembered Notes',
      content: notes.map(formatMemoryNote).join('\n'),
      sources: [source('kernel.remembered_notes', 'kernel_memory', 'project_memory', 'remembered_notes')],
      priority: 45,
      preserve: false,
      // Remembered notes are untrusted DATA (a planted note must not read as directives).
      // Raw here; the assembler fences it AFTER applyBudget truncation.
      untrustedSource: 'memory',
    })];
  } catch {
    return [];
  } finally {
    if (!injected && store && typeof store.close === 'function') {
      try { store.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Open a fresh, closeable kernel driver for a read of remembered notes, or null when
 * there is no reachable kernel DB (no repo / no DB file / open failure). Mirrors
 * readWorktreeLinkageRow: never creates the DB, never throws.
 *
 * @param {string} projectRoot
 * @returns {object|null}
 */
function openMemoryStore(projectRoot) {
  try {
    if (!fs.existsSync(path.join(projectRoot, '.git'))) return null;
    const { resolveKernelDatabasePath } = require('./kernel/cli-broker-factory');
    const databasePath = resolveKernelDatabasePath({ projectRoot });
    if (!databasePath || !fs.existsSync(databasePath)) return null;
    const { createBuiltinSQLiteDriver } = require('./kernel/sqlite-driver');
    return createBuiltinSQLiteDriver({ databasePath });
  } catch {
    return null;
  }
}

/** Render one recall note as a compact `- [date] text` line. */
function formatMemoryNote(note) {
  const date = typeof note.timestamp === 'string' && note.timestamp ? note.timestamp.slice(0, 10) : '';
  const prefix = date ? `${date} ` : '';
  return `- ${prefix}${note.note}`;
}

function buildQueueSections() {
  return [
    placeholderSection(
      'ready_queue',
      'Ready Queue',
      'Run `forge ready` to list work that is ready to start (issues with no open blockers).',
      'ready_queue',
      false,
      50
    ),
    placeholderSection(
      'active_claims',
      'Active Claims',
      'Run `forge issue list --status in_progress` to see work that is currently claimed.',
      'active_claims',
      true,
      60
    ),
  ];
}

function truncateText(content, targetTokens) {
  if (estimateTokens(content) <= targetTokens) {
    return { content, truncated: false };
  }
  const suffix = '\n[truncated deterministically by token budget]';
  // If even the truncation marker cannot fit in the allowance, drop the section
  // entirely rather than emit a section that exceeds the requested cap.
  if (estimateTokens(suffix) > targetTokens) {
    return { content: '', truncated: true };
  }
  const targetChars = Math.max(0, targetTokens * APPROX_CHARS_PER_TOKEN);
  let nextContent = String(content).slice(0, Math.max(0, targetChars - suffix.length)).trimEnd();
  let result = `${nextContent}${suffix}`;
  // Guard against ceil() rounding pushing the marker-inclusive result over the cap.
  while (nextContent.length > 0 && estimateTokens(result) > targetTokens) {
    nextContent = nextContent.slice(0, -1).trimEnd();
    result = `${nextContent}${suffix}`;
  }
  return { content: result, truncated: true };
}

function applyBudget(sections, budgetTokens) {
  const budget = normalizeBudgetTokens(budgetTokens);
  const sectionCopies = sections.map(section => ({ ...section }));
  const preserved = sectionCopies.filter(section => section.preserve);
  const flexible = sectionCopies.filter(section => !section.preserve)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  let used = preserved.reduce((sum, section) => sum + estimateTokens(section.content), 0);
  let remaining = Math.max(0, budget - used);
  let truncated = false;

  for (const section of flexible) {
    const fullTokens = estimateTokens(section.content);
    const allowance = Math.min(fullTokens, remaining);
    const next = truncateText(section.content, allowance);
    section.content = next.content;
    section.truncated = next.truncated;
    section.estimated_tokens = estimateTokens(section.content);
    used += section.estimated_tokens;
    remaining = Math.max(0, budget - used);
    if (next.truncated) truncated = true;
  }

  if (used > budget) {
    const preservedByPriority = preserved
      .sort((a, b) => b.priority - a.priority || b.id.localeCompare(a.id));
    for (const section of preservedByPriority) {
      if (used <= budget) break;
      const targetTokens = Math.max(0, estimateTokens(section.content) - (used - budget));
      const next = truncateText(section.content, targetTokens);
      used -= estimateTokens(section.content);
      section.content = next.content;
      section.truncated = next.truncated;
      section.estimated_tokens = estimateTokens(section.content);
      used += section.estimated_tokens;
      if (next.truncated) truncated = true;
    }
  }

  const ordered = sectionCopies.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const section of ordered) {
    section.estimated_tokens = estimateTokens(section.content);
  }

  return {
    sections: ordered,
    token_budget: {
      requested: budget,
      used: Math.min(budget, ordered.reduce((sum, section) => sum + section.estimated_tokens, 0)),
      approximate: true,
      chars_per_token: APPROX_CHARS_PER_TOKEN,
      truncated: truncated || ordered.some(section => section.truncated),
      truncation_order: [
        'active_work_plan',
        'active_work_tasks',
        'active_work_legacy_design',
        'current_design_snapshot',
        'ready_queue',
        'headline_decisions',
        'active_work_decisions',
        'active_claims',
        'key_commands',
      ],
    },
  };
}

function collectSources(sections) {
  const byKey = new Map();
  for (const section of sections) {
    for (const sectionSource of section.sources || []) {
      const key = `${sectionSource.path}|${sectionSource.source_kind}|${sectionSource.role}`;
      if (!byKey.has(key)) byKey.set(key, sectionSource);
    }
  }
  return [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path) || a.role.localeCompare(b.role));
}

function cleanupSections(sections) {
  return sections.map(section => {
    const rest = { ...section };
    delete rest.priority;
    delete rest.preserve;
    delete rest.untrustedSource; // internal fencing marker — not part of the emitted shape
    return rest;
  });
}

function buildOrientationSections(projectRoot, options = {}) {
  const project = buildProjectIdentity(projectRoot);
  const sections = [
    buildSection({
      id: 'project_identity',
      title: 'Project Identity',
      content: [
        `name: ${project.name}`,
        project.version ? `version: ${project.version}` : null,
        project.repository ? `repository: ${project.repository}` : null,
        project.design_title ? `design: ${project.design_title}` : null,
      ].filter(Boolean).join('\n'),
      sources: [
        source('package.json', 'project_manifest', 'project_file', 'project_identity'),
        source('docs/PROJECT_DESIGN.md', 'project_doc', 'project_registry', 'project_identity'),
      ],
      priority: 0,
      preserve: true,
      data: project,
    }),
    ...buildProjectDesignSections(projectRoot),
    ...buildMemorySection(projectRoot, options),
    ...buildWorkSections(projectRoot, options),
    ...buildQueueSections(),
  ];
  return { project, sections };
}

function assembleOrientationResult(project, sections, options) {
  const budgeted = applyBudget(sections, options.budgetTokens ?? options.budget);
  fenceUntrustedSections(budgeted.sections); // provenance-fence untrusted sections post-budget

  return {
    schema_version: 1,
    kind: 'orientation',
    generated_at: new Date().toISOString(),
    assembly: 'deterministic-file-assembly-v1',
    project,
    token_budget: budgeted.token_budget,
    sections: cleanupSections(budgeted.sections),
    sources: collectSources(budgeted.sections),
    next_commands: [
      'forge status --json',
      'forge issue ready --json',
      'forge recap <issue> --json',
      'forge show <issue> --json',
    ],
  };
}

function buildOrientation(projectRoot, options = {}) {
  const { project, sections } = buildOrientationSections(projectRoot, options);
  return assembleOrientationResult(project, sections, options);
}

// Short, fixed reference of capabilities that are easy to miss at session entry:
// closing the remember/recall memory loop, and commands with 0 mentions elsewhere
// in the generated onboarding surface (merge, insights, upgrade, gate, role).
// Kept intentionally tiny (a handful of one-liners) and `preserve: true` with a
// low priority number so it survives prime's token budget even on data-heavy
// projects — this is a fixed reference, not a manual, so it must not grow.
const PRIME_KEY_COMMANDS_CONTENT = [
  'forge remember <note> / forge recall [query] — write a memory note, then read it back',
  'forge insights — detect recurring evidence patterns, suggest workflow follow-ups',
  'forge upgrade [--dry-run] — preview/self-heal safe Forge upgrade readiness',
  'forge gate <verb> <gate-id> — toggle a workflow gate, or approve/reject a human gate',
  'forge role <role> --use <skill> — bind a role to a skill/ideology',
  'forge merge --auto <pr> — opt-in conditional auto-merge (off by default)',
].map(line => `- ${line}`).join('\n');

function buildPrimeKeyCommandsSection() {
  return buildSection({
    id: 'key_commands',
    title: 'Key Commands',
    content: PRIME_KEY_COMMANDS_CONTENT,
    sources: [source('AGENTS.md', 'static_reference', 'cli_help_summary', 'key_commands')],
    priority: 2,
    preserve: true,
  });
}

function findIssue(projectRoot, issueId) {
  const issues = readJsonl(projectRoot, '.beads/issues.jsonl')
    .filter(row => row && !row._parseError && row._type === 'issue');
  return issues.find(issue => issue.id === issueId) || null;
}

function buildIssueSection(projectRoot, issueId) {
  const issue = findIssue(projectRoot, issueId);
  const content = issue
    ? [
      `id: ${issue.id}`,
      issue.title ? `title: ${issue.title}` : null,
      issue.status ? `status: ${issue.status}` : null,
      issue.description ? `description: ${issue.description}` : null,
    ].filter(Boolean).join('\n')
    : `id: ${issueId}\nstatus: unknown\nIssue not found in compatibility projection.`;

  return {
    issue: issue ? {
      id: issue.id,
      title: issue.title || null,
      status: issue.status || null,
    } : {
      id: issueId,
      title: null,
      status: 'unknown',
    },
    section: buildSection({
      id: 'issue_summary',
      title: 'Issue Summary',
      content,
      sources: [source('.beads/issues.jsonl', 'beads_compat', 'compatibility_projection', 'issue_summary')],
      priority: 5,
      preserve: true,
    }),
  };
}

function buildIssueRecap(projectRoot, issueId, options = {}) {
  if (!issueId || typeof issueId !== 'string') {
    throw new Error('Issue id is required for issue-scoped recap.');
  }

  const issueResult = buildIssueSection(projectRoot, issueId);
  const sections = [
    issueResult.section,
    ...buildProjectDesignSections(projectRoot),
    ...buildWorkSections(projectRoot, options),
    ...buildQueueSections(),
  ];
  const budgeted = applyBudget(sections, options.budgetTokens ?? options.budget);
  fenceUntrustedSections(budgeted.sections); // provenance-fence untrusted sections post-budget

  return {
    schema_version: 1,
    kind: 'issue_recap',
    generated_at: new Date().toISOString(),
    assembly: 'deterministic-file-assembly-v1',
    scope: {
      issue_id: issueId,
    },
    issue: issueResult.issue,
    token_budget: budgeted.token_budget,
    sections: cleanupSections(budgeted.sections),
    sources: collectSources(budgeted.sections),
    next_commands: [
      `forge show ${issueId} --json`,
      `forge comment ${issueId} "<handoff note>"`,
      'forge orient --json',
      'forge status --json',
    ],
  };
}

function buildPrime(projectRoot, options = {}) {
  const { project, sections } = buildOrientationSections(projectRoot, options);
  // Prime is the session-entry command, so it LEADS the COMPLETE orientation with LIVE state
  // (stage / claims / ready / gates / one adoption nudge) when the caller supplied it — the
  // live-state section is prepended to the full section list (not just the extra sections), so
  // prime leads with it in every output path. Collected async by the command handler and injected
  // here so buildPrime itself stays pure and synchronous.
  const keyCommands = buildPrimeKeyCommandsSection();
  const allSections = options.liveState
    ? [buildPrimeLiveStateSection(options.liveState), ...sections, keyCommands]
    : [...sections, keyCommands];
  const orientation = assembleOrientationResult(project, allSections, options);
  return {
    schema_version: 1,
    kind: 'prime',
    generated_at: orientation.generated_at,
    purpose: 'session-entry',
    token_budget: orientation.token_budget,
    orientation,
    sources: orientation.sources,
    ...(options.liveState ? { live_state: options.liveState } : {}),
    next_commands: [
      'forge orient --json',
      'forge status --json',
      'forge issue ready --json',
    ],
  };
}

// Cap on claimed issues rendered in the prime live-state block — a bounded nudge, not a dump.
const LIVE_STATE_CLAIM_LIMIT = 3;
const LIVE_STATE_GATE_LIMIT = 6;

/**
 * Render the prime LIVE-state block: current stage, claimed issue(s), ready count, enabled
 * gates/rails, and ONE progressive-adoption nudge. PURE and bounded — the output is always
 * ≤ ~10 lines (well under the 20-line cap), with honest fallbacks for every missing field so
 * a repo with no kernel data still renders a coherent block.
 *
 * @param {object} [liveState]
 * @returns {string}
 */
// Hard cap on any single EXTERNAL value (stage name, issue title, gate id) rendered into the
// live-state block. Counts alone don't bound the block: one long or multiline title/name/id could
// otherwise bloat live_state or break its one-value-per-line structure. clipValue enforces both.
const LIVE_STATE_VALUE_MAX = 60;

/** Collapse all whitespace (incl. newlines) to single spaces and hard-cap length with an ellipsis. */
function clipValue(value, max = LIVE_STATE_VALUE_MAX) {
  const flat = String(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One-line "Stage: <id> — <name>" (or "not recorded"). */
function formatStageLine(stage) {
  if (!stage?.id) return 'Stage: not recorded';
  const suffix = stage.name ? ` — ${clipValue(stage.name)}` : '';
  return `Stage: ${clipValue(stage.id)}${suffix}`;
}

/** Bounded "Claimed:" lines (capped, with an "…and N more" tail), or a single "none". */
function formatClaimedLines(claimed) {
  if (claimed.length === 0) return ['Claimed: none'];
  const lines = claimed
    .slice(0, LIVE_STATE_CLAIM_LIMIT)
    .map(issue => {
      // The issue TITLE is attacker-influenceable (GitHub / Kernel / Beads). Clip it (bound +
      // collapse newlines) and provenance-FENCE it with the SAME guard the memory digest uses
      // (fenceUntrusted), so it enters the trusted session-entry block as data, never as
      // instructions — a prompt-injection guard for the prime live-state surface.
      const title = issue.title
        ? ` ${fenceUntrusted(clipValue(issue.title), { source: 'issue-title' })}`
        : '';
      return `Claimed: ${clipValue(issue.id)}${title}`;
    });
  if (claimed.length > LIVE_STATE_CLAIM_LIMIT) {
    lines.push(`Claimed: …and ${claimed.length - LIVE_STATE_CLAIM_LIMIT} more`);
  }
  return lines;
}

/** One-line "Ready: N issue(s) waiting" (or "none"). */
function formatReadyLine(readyCount) {
  if (readyCount <= 0) return 'Ready: none';
  return `Ready: ${readyCount} issue${readyCount === 1 ? '' : 's'} waiting (forge ready)`;
}

/** One-line "Gates on: <capped list>" (or "defaults"). */
function formatGatesLine(gates) {
  if (gates.length === 0) return 'Gates on: defaults';
  const shown = gates.slice(0, LIVE_STATE_GATE_LIMIT).map(gate => clipValue(gate)).join(', ');
  return `Gates on: ${shown}${gates.length > LIVE_STATE_GATE_LIMIT ? ', …' : ''}`;
}

function formatPrimeLiveState(liveState = {}) {
  const claimed = Array.isArray(liveState.claimed) ? liveState.claimed : [];
  const readyCount = Number.isFinite(liveState.readyCount) ? liveState.readyCount : 0;
  const gates = Array.isArray(liveState.gates) ? liveState.gates : [];

  const lines = [
    formatStageLine(liveState.stage),
    ...formatClaimedLines(claimed),
    formatReadyLine(readyCount),
    formatGatesLine(gates),
  ];
  if (liveState.nudge) lines.push(`Next: ${liveState.nudge}`);
  return lines.join('\n');
}

function buildPrimeLiveStateSection(liveState) {
  return buildSection({
    id: 'live_state',
    title: 'Live State',
    content: formatPrimeLiveState(liveState),
    sources: [source('kernel.live_state', 'kernel_read_model', 'live_session_state', 'live_state')],
    // Priority 0 so prime LEADS with live state in every output path: applyBudget orders sections
    // by priority (project_identity is also 0), and the id tiebreak ('live_state' < 'project_
    // identity') puts live state first — the session-entry "where am I right now" belongs on top.
    priority: 0,
    preserve: true,
  });
}

/** Deterministic, single-line progressive-adoption nudge (at-most-one) for prime live-state. */
function buildAdoptionNudge({ claimed = [], readyCount = 0, topReady = null } = {}) {
  if (claimed.length > 0) return `Resume with forge recap ${claimed[0].id} for full context.`;
  if (readyCount > 0 && topReady && topReady.id) return `Claim work: forge claim ${topReady.id}, then plan or dev.`;
  return 'No active or ready work — forge plan "<feature>" to start, or forge ready to check.';
}

/**
 * True only when a Kernel DB ALREADY EXISTS on disk. `forge prime` is a read-only, session-entry
 * command, so the live-state read must NEVER lazily create/migrate the Kernel DB (which the
 * default snapshot path would otherwise do in a fresh repo). resolveKernelDatabasePath only
 * COMPUTES the path (no side effects); we check the file separately. Never throws.
 * @param {string} projectRoot
 * @returns {boolean}
 */
function hasExistingKernelDb(projectRoot) {
  try {
    const { resolveKernelDatabasePath } = require('./kernel/cli-broker-factory');
    const databasePath = resolveKernelDatabasePath({ projectRoot });
    return !!databasePath && fs.existsSync(databasePath);
  } catch {
    return false;
  }
}

/**
 * True when the live-state read must be SKIPPED to keep `forge prime` strictly READ-ONLY. The
 * Kernel is the SOLE runtime issue backend (Beads is retired from the runtime — the only remaining
 * Beads surface is the opt-in `forge migrate` path, so there is NO runtime Beads live-data source
 * by design). The Kernel read lazily creates/migrates `.git/forge/kernel.sqlite`, so we read live
 * ONLY when that DB already exists; otherwise prime shows honest-degraded/empty state and never
 * creates a store. Never throws.
 * @param {string} projectRoot
 * @returns {boolean} true iff the read must be skipped.
 */
function shouldSkipLiveSnapshot(projectRoot) {
  return !hasExistingKernelDb(projectRoot);
}

/**
 * Acquire the status snapshot for live-state WITHOUT ever creating state. An injected
 * `_readSnapshot` (tests) bypasses the guards; otherwise the read is gated on a real git repo and
 * an existing Kernel DB (the sole runtime issue backend — see shouldSkipLiveSnapshot), so a
 * fresh/un-initialized repo returns null (honest fallback) and nothing is written. Never throws.
 * @returns {Promise<object|null>}
 */
async function acquireLiveSnapshot(projectRoot, env, options) {
  if (options._readSnapshot) {
    try { return await options._readSnapshot(); } catch { return null; }
  }
  if (!fs.existsSync(path.join(projectRoot, '.git'))) return null;
  if (shouldSkipLiveSnapshot(projectRoot)) return null; // read-only: never create the store
  try {
    const { readStatusSnapshot } = require('./status/snapshot');
    return await readStatusSnapshot(projectRoot, { env });
  } catch {
    return null;
  }
}

/** Resolve the current stage for live-state (best-effort, non-throwing). Injectable via options. */
function resolveLiveStage(projectRoot, claimed, options) {
  if (Object.hasOwn(options, '_workflowState')) {
    const ws = options._workflowState;
    return ws && ws.currentStage ? { id: ws.currentStage, name: ws.currentStage } : null;
  }
  try {
    const status = require('./commands/status');
    const issueId = claimed[0] ? claimed[0].id : null;
    const { workflowState } = status.resolveWorkflowState({ projectRoot, issueId });
    if (workflowState && workflowState.currentStage) {
      return { id: workflowState.currentStage, name: status.buildAuthoritativeStatus(workflowState).stageName };
    }
  } catch { /* stage stays null */ }
  return null;
}

/**
 * Best-effort LIVE-state collector for prime. Async + NON-THROWING and strictly READ-ONLY: it
 * never creates or migrates the Kernel DB (a fresh repo yields honest fallbacks, not a new DB).
 * `options.liveState` bypasses all reads; `options._readSnapshot` injects a snapshot (tests).
 *
 * @param {string} projectRoot
 * @param {object} [options] - `{ liveState, env, _readSnapshot, _workflowState }` (all injectable).
 * @returns {Promise<{stage: object|null, claimed: object[], readyCount: number, gates: string[], nudge: string}>}
 */
async function collectPrimeLiveState(projectRoot, options = {}) {
  if (options.liveState) return options.liveState;
  const env = options.env || process.env;
  const gates = readEnabledGates(projectRoot); // config-file backed — safe even with no repo/DB

  const snapshot = await acquireLiveSnapshot(projectRoot, env, options);
  if (!snapshot) {
    return { stage: null, claimed: [], readyCount: 0, gates, nudge: buildAdoptionNudge({}) };
  }

  const claimed = (Array.isArray(snapshot.activeAssigned) ? snapshot.activeAssigned : [])
    .map(issue => ({ id: issue.id, title: issue.title || null }));
  const readyList = Array.isArray(snapshot.ready) ? snapshot.ready : [];
  const readyCount = readyList.length;

  return {
    stage: resolveLiveStage(projectRoot, claimed, options),
    claimed,
    readyCount,
    gates,
    nudge: buildAdoptionNudge({ claimed, readyCount, topReady: readyList[0] || null }),
  };
}

/**
 * Read the enabled gate/rail ids from the resolved runtime graph (config-file backed, no kernel
 * DB — safe on a non-repo path). Never throws; returns [] on any failure.
 * @param {string} projectRoot
 * @returns {string[]}
 */
function readEnabledGates(projectRoot) {
  try {
    const { getResolvedRuntimeGraph } = require('./core/runtime-graph');
    const graph = getResolvedRuntimeGraph({ projectRoot }) || {};
    const primitives = [...(graph.rails || []), ...(graph.gates || [])];
    return primitives.filter(p => p && p.enabled !== false).map(p => p.id).filter(Boolean);
  } catch {
    return [];
  }
}

function formatOrientationText(result) {
  const lines = [
    orientationTitle(result.kind),
    `Assembly: ${result.assembly || result.orientation?.assembly || 'deterministic-file-assembly-v1'}`,
    `Budget: ${result.token_budget.used}/${result.token_budget.requested} estimated tokens${result.token_budget.truncated ? ' (truncated)' : ''}`,
    '',
  ];

  const sections = result.orientation?.sections || result.sections || [];
  for (const section of sections) {
    if (!section.content) continue;
    lines.push(`## ${section.title}`, section.content, '');
  }

  lines.push('Next commands:');
  for (const command of result.next_commands || []) {
    lines.push(`- ${command}`);
  }
  return `${lines.join('\n')}\n`;
}

function orientationTitle(kind) {
  if (kind === 'prime') return 'Forge prime';
  if (kind === 'issue_recap') return 'Forge issue recap';
  return 'Forge orientation';
}

function extractFencedYaml(block) {
  const open = block.indexOf('```yaml');
  if (open === -1) return '';
  const start = open + '```yaml'.length;
  const close = block.indexOf('```', start);
  return close === -1 ? '' : block.slice(start, close).trim();
}

function extractCurrentDecision(block) {
  const marker = '**Current decision:**';
  const at = block.indexOf(marker);
  if (at === -1) return '';
  const after = block.slice(at + marker.length);
  const blank = after.indexOf('\n\n');
  return (blank === -1 ? after : after.slice(0, blank)).trim();
}

function readOption(args, name, fallback) {
  const equals = args.find(arg => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('-')) return args[index + 1];
  return fallback;
}

function runOrientationCommand(build, args, projectRoot, extraOptions = {}) {
  const result = build(projectRoot, {
    budgetTokens: readOption(args, '--budget', undefined),
    ...extraOptions,
  });
  return {
    success: true,
    output: args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : formatOrientationText(result),
  };
}

module.exports = {
  DEFAULT_BUDGET_TOKENS,
  applyBudget,
  buildSection,
  buildAdoptionNudge,
  buildIssueRecap,
  buildMemorySection,
  buildOrientation,
  buildOrientationSections,
  buildPrime,
  buildPrimeLiveStateSection,
  collectPrimeLiveState,
  shouldSkipLiveSnapshot,
  discoverWorkFolder,
  formatPrimeLiveState,
  estimateTokens,
  formatOrientationText,
  normalizeBudgetTokens,
  readOption,
  runOrientationCommand,
  source,
};
