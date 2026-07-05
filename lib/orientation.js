'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
  };
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

function buildQueueSections() {
  return [
    placeholderSection(
      'ready_queue',
      'Ready Queue',
      'Placeholder: Kernel-backed ready queue is not implemented in D21 V1. Use `forge issue ready --json` when the issue read model is available.',
      'ready_queue',
      false,
      50
    ),
    placeholderSection(
      'active_claims',
      'Active Claims',
      'Placeholder: Kernel-backed claim state is not implemented in D21 V1. This section keeps the contract shape so Kernel can replace it.',
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
    return rest;
  });
}

function buildOrientation(projectRoot, options = {}) {
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
    ...buildWorkSections(projectRoot, options),
    ...buildQueueSections(),
  ];
  const budgeted = applyBudget(sections, options.budgetTokens ?? options.budget);

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
  const orientation = buildOrientation(projectRoot, options);
  return {
    schema_version: 1,
    kind: 'prime',
    generated_at: orientation.generated_at,
    purpose: 'session-entry',
    token_budget: orientation.token_budget,
    orientation,
    sources: orientation.sources,
    next_commands: [
      'forge orient --json',
      'forge status --json',
      'forge issue ready --json',
    ],
  };
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

function runOrientationCommand(build, args, projectRoot) {
  const result = build(projectRoot, {
    budgetTokens: readOption(args, '--budget', undefined),
  });
  return {
    success: true,
    output: args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : formatOrientationText(result),
  };
}

module.exports = {
  DEFAULT_BUDGET_TOKENS,
  buildIssueRecap,
  buildOrientation,
  buildPrime,
  discoverWorkFolder,
  estimateTokens,
  formatOrientationText,
  normalizeBudgetTokens,
  readOption,
  runOrientationCommand,
};
