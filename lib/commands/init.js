const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const YAML = require('yaml');

const {
  ADOPTION_PROFILE_NAMES,
  renderAdoptionConfigYaml,
} = require('../adoption-profiles');

const PROFILE_REQUIRED_ERROR = '--profile requires a non-empty value: minimal, standard, or full.';
const CLASSIFICATION_REQUIRED_ERROR = '--classification requires a non-empty value: critical, standard, or refactor.';
const HARNESS_REQUIRED_ERROR = '--harness requires a non-empty value: claude, cursor, or codex.';
const PROFILE_SHORTCUTS = Object.freeze({
  '--minimal': 'minimal',
  '--standard': 'standard',
  '--full': 'full',
});
const CLASSIFICATIONS = Object.freeze(['critical', 'standard', 'refactor']);
const HARNESS_TARGETS = Object.freeze(['claude', 'cursor', 'codex']);

function usage() {
  return [
    'Usage: forge init [--profile minimal|standard|full] [--classification critical|standard|refactor] [--harness claude,cursor,codex] [--yes] [--force] [--dry-run]',
    '',
    'Initialize the day-one .forge skeleton for a fresh repository.',
  ].join('\n');
}

function normalizeProfile(value) {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '';
}

function setProfile(parsed, value) {
  const profile = normalizeProfile(value);
  if (profile === '') {
    parsed.error = PROFILE_REQUIRED_ERROR;
    parsed.profile = null;
    return;
  }
  parsed.profile = profile;
}

function normalizeClassification(value) {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : '';
}

function setClassification(parsed, value) {
  const classification = normalizeClassification(value);
  if (classification === '') {
    parsed.error = CLASSIFICATION_REQUIRED_ERROR;
    parsed.classification = null;
    return;
  }
  if (!CLASSIFICATIONS.includes(classification)) {
    parsed.error = `Unknown classification '${classification}'. Choose one of: ${CLASSIFICATIONS.join(', ')}.`;
    parsed.classification = null;
    return;
  }
  parsed.classification = classification;
}

function normalizeHarnessTargets(value) {
  if (Array.isArray(value)) {
    return value.flatMap(item => normalizeHarnessTargets(item));
  }
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function setHarnessTargets(parsed, value) {
  const targets = [...new Set(normalizeHarnessTargets(value))];
  if (targets.length === 0) {
    parsed.error = HARNESS_REQUIRED_ERROR;
    parsed.harnessTargets = null;
    return;
  }
  const unknown = targets.find(target => !HARNESS_TARGETS.includes(target));
  if (unknown) {
    parsed.error = `Unknown harness target '${unknown}'. Choose from: ${HARNESS_TARGETS.join(', ')}.`;
    parsed.harnessTargets = null;
    return;
  }
  parsed.harnessTargets = targets;
}

function consumeProfileArg(args, index, parsed) {
  const arg = args[index];
  if (arg === '--profile') {
    const value = args[index + 1];
    if (typeof value === 'string' && !value.startsWith('--')) {
      setProfile(parsed, value);
      return index + 1;
    }
    parsed.error = PROFILE_REQUIRED_ERROR;
    return index;
  }

  setProfile(parsed, arg.slice('--profile='.length));
  return index;
}

function consumeClassificationArg(args, index, parsed) {
  const arg = args[index];
  if (arg === '--classification') {
    const value = args[index + 1];
    if (typeof value === 'string' && !value.startsWith('--')) {
      setClassification(parsed, value);
      return index + 1;
    }
    parsed.error = CLASSIFICATION_REQUIRED_ERROR;
    return index;
  }

  setClassification(parsed, arg.slice('--classification='.length));
  return index;
}

function consumeHarnessArg(args, index, parsed) {
  const arg = args[index];
  if (arg === '--harness') {
    const value = args[index + 1];
    if (typeof value === 'string' && !value.startsWith('--')) {
      setHarnessTargets(parsed, value);
      return index + 1;
    }
    parsed.error = HARNESS_REQUIRED_ERROR;
    return index;
  }

  setHarnessTargets(parsed, arg.slice('--harness='.length));
  return index;
}

function applyProfileShortcut(arg, parsed) {
  const profile = PROFILE_SHORTCUTS[arg];
  if (profile) {
    parsed.profile = profile;
    parsed.yes = true;
  }
  return Boolean(profile);
}

function parseInitFlags(args = [], flags = {}) {
  const parsed = {
    profile: null,
    error: null,
    yes: Boolean(flags.yes || flags.nonInteractive),
    force: Boolean(flags.force),
    dryRun: Boolean(flags.dryRun),
    classification: null,
    harnessTargets: null,
    railsConfirmed: Boolean(flags.yes || flags.nonInteractive),
  };

  if (Object.hasOwn(flags, 'profile')) {
    setProfile(parsed, flags.profile);
  }
  if (Object.hasOwn(flags, 'classification')) {
    setClassification(parsed, flags.classification);
  }
  if (Object.hasOwn(flags, 'harness')) {
    setHarnessTargets(parsed, flags.harness);
  }

  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      index = consumeProfileArg(args, index, parsed) + 1;
      continue;
    } else if (arg === '--classification' || arg.startsWith('--classification=')) {
      index = consumeClassificationArg(args, index, parsed) + 1;
      continue;
    } else if (arg === '--harness' || arg.startsWith('--harness=')) {
      index = consumeHarnessArg(args, index, parsed) + 1;
      continue;
    } else if (applyProfileShortcut(arg, parsed)) {
      index += 1;
      continue;
    } else if (arg === '--yes' || arg === '-y') {
      parsed.yes = true;
      parsed.railsConfirmed = true;
    } else if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    }
    index += 1;
  }

  return parsed;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function resolveProfile(parsed) {
  if (parsed.profile) {
    return parsed.profile;
  }
  return 'standard';
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch (_err) {
    return false;
  }
}

function detectHarnessTargets(projectRoot = process.cwd()) {
  return HARNESS_TARGETS.filter(target => isDirectory(path.join(projectRoot, `.${target}`)));
}

function renderPatchMd() {
  return [
    '# Forge Patch Intent',
    '',
    '<!--',
    'This file is intentionally empty for day-one setup.',
    'Use it later to document local Forge overrides before applying them.',
    '-->',
    '',
  ].join('\n');
}

function addExistingPath(entries, projectRoot, protectedPath, reason) {
  const absolutePath = projectRoot ? path.join(projectRoot, protectedPath) : null;
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    return;
  }
  const manifestPath = isDirectory(absolutePath) ? `${protectedPath}/**` : protectedPath;
  entries.push({ path: manifestPath.replace(/\\/g, '/'), reason });
}

function addSelectedHarnessPaths(entries, { projectRoot, harnessTargets }) {
  if (!projectRoot) return;
  if (fs.existsSync(path.join(projectRoot, 'AGENTS.md'))) {
    entries.push({ path: 'AGENTS.md', reason: 'Agent workflow instructions' });
  }

  if (harnessTargets.includes('claude')) {
    addExistingPath(entries, projectRoot, 'CLAUDE.md', 'Claude harness instructions');
    addExistingPath(entries, projectRoot, '.claude', 'Claude harness directory');
  }
  if (harnessTargets.includes('cursor')) {
    addExistingPath(entries, projectRoot, '.cursor', 'Cursor harness directory');
  }
  if (harnessTargets.includes('codex')) {
    addExistingPath(entries, projectRoot, '.codex', 'Codex harness directory');
  }
}

function renderProtectedPathsYaml({ classification, harnessTargets, projectRoot = null }) {
  const paths = [
    { path: '.forge/config.yaml', reason: 'Forge runtime configuration' },
    { path: '.forge/patch.md', reason: 'Local patch intent scaffold' },
    { path: '.forge/protected-paths.yaml', reason: 'Protected path manifest scaffold' },
  ];
  addSelectedHarnessPaths(paths, { projectRoot, harnessTargets });

  return YAML.stringify({
    kind: 'forge.protectedPaths',
    version: 1,
    classification,
    harness: {
      targets: harnessTargets,
    },
    paths,
  });
}

function renderDayOneConfigYaml({ profile, classification, harnessTargets, railsConfirmed }) {
  const config = YAML.parse(renderAdoptionConfigYaml(profile));
  config.workflow = config.workflow || {};
  config.workflow.classification = { default: classification };
  config.layer1Rails = {
    confirmed: railsConfirmed,
    rails: [
      'tdd_intent',
      'secret_scan',
      'branch_protection',
      'signed_commits',
      'schema_integrity',
    ],
  };
  config.adapters = config.adapters || {};
  config.adapters.harness = {
    enabled: harnessTargets.length > 0,
    targets: harnessTargets,
  };
  config.protectedPaths = [
    ...new Set([
      ...(Array.isArray(config.protectedPaths) ? config.protectedPaths : []),
      '.forge/config.yaml',
      '.forge/patch.md',
      '.forge/protected-paths.yaml',
    ]),
  ];
  return YAML.stringify(config);
}

function relativeForgePath(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function buildGeneratedFiles(projectRoot, choices) {
  const forgeDir = path.join(projectRoot, '.forge');
  return [
    {
      path: path.join(forgeDir, 'config.yaml'),
      content: renderDayOneConfigYaml(choices),
    },
    {
      path: path.join(forgeDir, 'patch.md'),
      content: renderPatchMd(),
    },
    {
      path: path.join(forgeDir, 'protected-paths.yaml'),
      content: renderProtectedPathsYaml({ ...choices, projectRoot }),
    },
  ];
}

function existingGeneratedFiles(files) {
  return files.filter(file => fs.existsSync(file.path));
}

function formatNoClobberError(projectRoot, files) {
  const names = files.map(file => relativeForgePath(projectRoot, file.path)).join(', ');
  return `${names} already exists. Re-run with --force to overwrite it, or move the existing file and run forge init again.`;
}

async function resolveChoices(parsed, projectRoot, deps = {}) {
  const prompt = deps.prompt || ask;
  const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY;
  const interactive = !parsed.yes && stdinIsTTY;
  const detectedHarnessTargets = detectHarnessTargets(projectRoot);
  const defaultHarnessTargets = detectedHarnessTargets.length > 0 ? detectedHarnessTargets : ['codex'];
  const profile = await resolveProfile(parsed);

  let classification = parsed.classification;
  if (!classification) {
    if (interactive) {
      const answer = await prompt(`Select default classification (${CLASSIFICATIONS.join('/')}), default standard: `);
      classification = answer.trim() || 'standard';
      setClassification(parsed, classification);
      if (parsed.error) return { error: parsed.error };
      classification = parsed.classification;
    } else {
      classification = 'standard';
    }
  }

  let railsConfirmed = parsed.railsConfirmed;
  if (!railsConfirmed) {
    if (interactive) {
      const answer = await prompt('Confirm Layer 1 rails are required for this repo? (Y/n): ');
      const normalized = answer.trim().toLowerCase();
      railsConfirmed = normalized === '' || normalized === 'y' || normalized === 'yes';
    } else {
      railsConfirmed = true;
    }
  }

  if (!railsConfirmed) {
    return {
      error: 'Layer 1 rails must be confirmed before initialization. Re-run forge init and answer yes to continue.',
    };
  }

  let harnessTargets = parsed.harnessTargets;
  if (!harnessTargets) {
    if (interactive) {
      const defaultValue = defaultHarnessTargets.join(',');
      const answer = await prompt(`Select harness targets (${HARNESS_TARGETS.join(',')}), default ${defaultValue}: `);
      const selected = answer.trim() || defaultValue;
      setHarnessTargets(parsed, selected);
      if (parsed.error) return { error: parsed.error };
      harnessTargets = parsed.harnessTargets;
    } else {
      harnessTargets = defaultHarnessTargets;
    }
  }

  return {
    profile,
    classification,
    railsConfirmed,
    harnessTargets,
  };
}

async function handler(args, flags, projectRoot = process.cwd(), deps = {}) {
  const parsed = parseInitFlags(args, flags);
  if (parsed.error) {
    return { success: false, error: parsed.error };
  }
  const choices = await resolveChoices(parsed, projectRoot, deps);
  if (choices.error) {
    return { success: false, error: choices.error };
  }
  const { profile } = choices;
  if (!ADOPTION_PROFILE_NAMES.includes(profile)) {
    return {
      success: false,
      error: `Unknown adoption profile '${profile}'. Available profiles: ${ADOPTION_PROFILE_NAMES.join(', ')}`,
    };
  }
  const forgeDir = path.join(projectRoot, '.forge');
  const files = buildGeneratedFiles(projectRoot, choices);
  const existingFiles = existingGeneratedFiles(files);

  if (existingFiles.length > 0 && !parsed.force) {
    return {
      success: false,
      error: formatNoClobberError(projectRoot, existingFiles),
    };
  }

  if (parsed.dryRun) {
    return {
      success: true,
      ...choices,
      files: files.map(file => relativeForgePath(projectRoot, file.path)),
      output: files[0].content,
    };
  }

  fs.mkdirSync(forgeDir, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(file.path, file.content, 'utf8');
  }

  console.log(`Initialized Forge adoption profile '${profile}' at .forge/`);
  console.log(`Classification: ${choices.classification}`);
  console.log(`Harness targets: ${choices.harnessTargets.join(', ')}`);
  console.log('Inspect with: forge options lint && forge options diff');

  return {
    success: true,
    ...choices,
    files: files.map(file => relativeForgePath(projectRoot, file.path)),
  };
}

module.exports = {
  name: 'init',
  description: 'Initialize Forge adoption config in a fresh repository',
  usage: usage(),
  flags: {
    '--profile <name>': 'Adoption profile: minimal, standard, or full',
    '--minimal': 'Shortcut for --profile minimal --yes',
    '--standard': 'Shortcut for --profile standard --yes',
    '--full': 'Shortcut for --profile full --yes',
    '--classification <name>': 'Default workflow classification: critical, standard, or refactor',
    '--harness <targets>': 'Comma-separated harness targets: claude, cursor, codex',
    '--yes': 'Use the standard profile when no profile is provided',
    '--force': 'Overwrite existing day-one .forge files',
    '--dry-run': 'Print the generated config YAML without writing files',
  },
  handler,
  detectHarnessTargets,
  parseInitFlags,
  renderDayOneConfigYaml,
  renderPatchMd,
  renderProtectedPathsYaml,
};
