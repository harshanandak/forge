#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const CANONICAL_SKILL = {
  name: 'guard-rails-audit',
  description: 'Use when asked to inspect Forge L1 rail enforcement, audit events, or protected path policy.',
  body: [
    '# Guard Rails Audit',
    '',
    'Check Forge L1 rails, audit-event coverage, and protected path policy before recommending changes.',
  ].join('\n'),
};

const MATCHING_PROMPT = 'Inspect Forge L1 rail enforcement and audit events for protected path policy.';
const NON_MATCHING_PROMPT = 'Draft release notes for a minor README copy edit.';
const FIXTURE_FILE = 'src/index.js';

const HARNESS_TARGETS = [
  {
    harness: 'claude-code',
    target: '.claude/skills/guard-rails-audit/SKILL.md',
    source: 'Claude Code skill directory target',
    buildFrontmatter: () => ({
      name: CANONICAL_SKILL.name,
      description: CANONICAL_SKILL.description,
    }),
  },
  {
    harness: 'cursor',
    target: '.cursor/rules/guard-rails-audit.mdc',
    source: 'Cursor project rule with documented description/globs/alwaysApply metadata',
    buildFrontmatter: () => ({
      description: CANONICAL_SKILL.description,
      globs: null,
      alwaysApply: false,
    }),
  },
  {
    harness: 'codex-cli',
    target: '.agents/skills/guard-rails-audit/SKILL.md',
    source: 'Codex documented repository Agent Skills surface; custom slash prompt files are intentionally not used',
    buildFrontmatter: () => ({
      name: CANONICAL_SKILL.name,
      description: CANONICAL_SKILL.description,
    }),
  },
];

function buildMarkdown(frontmatter, body) {
  return `---\n${YAML.stringify(frontmatter, {
    lineWidth: 0,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'PLAIN',
  }).trimEnd()}\n---\n\n${body}\n`;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return {};
  const parsed = YAML.parse(match[1]);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function writeFile(root, relativePath, content) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function materializeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  writeFile(root, FIXTURE_FILE, 'export function fixture() { return true; }\n');

  for (const target of HARNESS_TARGETS) {
    writeFile(
      root,
      target.target,
      buildMarkdown(target.buildFrontmatter(), CANONICAL_SKILL.body),
    );
  }

  return { root, skill: CANONICAL_SKILL, targets: HARNESS_TARGETS };
}

function tokens(value) {
  return String(value)
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((token) => token.length >= 4) || [];
}

function descriptionMatches(description, prompt) {
  const promptTokens = new Set(tokens(prompt));
  const triggerTokens = tokens(description)
    .filter((token) => !['when', 'asked', 'inspect'].includes(token));

  return triggerTokens.some((token) => promptTokens.has(token));
}

function cursorGlobMatches(globs, filePath) {
  void filePath;
  if (!Array.isArray(globs) || globs.length === 0) return true;
  return globs.includes('**/*') || globs.includes(filePath);
}

function validateHarness(root, target) {
  const absolutePath = path.join(root, target.target);
  const failures = [];

  if (!fs.existsSync(absolutePath)) {
    failures.push(`missing ${target.target}`);
    return { ...target, passed: false, failures };
  }

  const frontmatter = parseFrontmatter(fs.readFileSync(absolutePath, 'utf8'));
  const description = frontmatter.description;
  const positiveMatch = descriptionMatches(description, MATCHING_PROMPT);
  const negativeMatch = descriptionMatches(description, NON_MATCHING_PROMPT);

  if (description !== CANONICAL_SKILL.description) {
    failures.push('description does not match canonical skill description');
  }
  if (!positiveMatch) {
    failures.push('matching prompt did not select the skill by description');
  }
  if (negativeMatch) {
    failures.push('unrelated prompt selected the skill');
  }

  if (target.harness === 'claude-code') {
    if (frontmatter.name !== CANONICAL_SKILL.name) failures.push('Claude skill name is missing or incorrect');
  }

  if (target.harness === 'cursor') {
    if (frontmatter.alwaysApply !== false) failures.push('Cursor rule must keep alwaysApply: false for request-time selection');
    if (!cursorGlobMatches(frontmatter.globs, FIXTURE_FILE)) failures.push(`Cursor globs do not include ${FIXTURE_FILE}`);
  }

  if (target.harness === 'codex-cli') {
    if (!target.target.startsWith('.agents/skills/') || target.target.includes('/prompts/')) {
      failures.push('Codex target must use .agents/skills, not undocumented prompt/slash files');
    }
  }

  return {
    ...target,
    passed: failures.length === 0,
    descriptionMatched: positiveMatch,
    negativePromptIgnored: !negativeMatch,
    frontmatter,
    failures,
  };
}

function runParity(options = {}) {
  const root = options.fixtureDir || fs.mkdtempSync(path.join(os.tmpdir(), 'forge-w0-harness-parity-'));
  const cleanup = options.fixtureDir ? false : options.cleanup !== false;

  try {
    materializeFixture(root);
    const harnesses = HARNESS_TARGETS.map((target) => validateHarness(root, target));
    const passed = harnesses.every((result) => result.passed);
    const feasibleCount = harnesses.filter((result) => result.passed).length;
    const knownIssues = passed ? [] : [{
      issue: 'Cross-harness skill render parity did not pass for all three target harnesses.',
      d38: 'D38 kills v3 if two of Claude/Cursor/Codex cannot render a single skill correctly by the W3 checkpoint.',
      feasibleCount,
    }];

    return {
      fixture: 'w0-skill-auto-invoke-parity',
      fixtureRoot: root,
      matchingPrompt: MATCHING_PROMPT,
      nonMatchingPrompt: NON_MATCHING_PROMPT,
      canonicalSkill: CANONICAL_SKILL,
      harnesses,
      passed,
      knownIssues,
    };
  } finally {
    if (cleanup) fs.rmSync(root, { recursive: true, force: true });
  }
}

function printText(result) {
  console.log(`W0 skill auto-invoke parity: ${result.passed ? 'PASS' : 'FAIL'}`);
  for (const harness of result.harnesses) {
    const status = harness.passed ? 'PASS' : 'FAIL';
    console.log(`${status} ${harness.harness} ${harness.target}`);
    for (const failure of harness.failures) {
      console.log(`  - ${failure}`);
    }
  }
  if (result.knownIssues.length > 0) {
    for (const issue of result.knownIssues) {
      console.log(`Known issue: ${issue.issue} ${issue.d38}`);
    }
  }
}

function readStringFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  const result = runParity({ fixtureDir: readStringFlag(args, '--fixture-dir') });

  if (args.includes('--json')) {
    console.log(JSON.stringify(result));
  } else {
    printText(result);
  }

  if (!result.passed) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  CANONICAL_SKILL,
  HARNESS_TARGETS,
  MATCHING_PROMPT,
  NON_MATCHING_PROMPT,
  descriptionMatches,
  materializeFixture,
  parseFrontmatter,
  runParity,
};
