const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const {
  ADOPTION_PROFILE_NAMES,
  renderAdoptionConfigYaml,
} = require('../adoption-profiles');

const PROFILE_REQUIRED_ERROR = '--profile requires a non-empty value: minimal, standard, or full.';
const PROFILE_SHORTCUTS = Object.freeze({
  '--minimal': 'minimal',
  '--standard': 'standard',
  '--full': 'full',
});

function usage() {
  return [
    'Usage: forge init [--profile minimal|standard|full] [--yes] [--force] [--dry-run]',
    '',
    'Initialize .forge/config.yaml for a fresh repository.',
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
  };

  if (Object.hasOwn(flags, 'profile')) {
    setProfile(parsed, flags.profile);
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      index = consumeProfileArg(args, index, parsed);
    } else if (applyProfileShortcut(arg, parsed)) {
      continue;
    } else if (arg === '--yes' || arg === '-y') {
      parsed.yes = true;
    } else if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    }
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
  if (parsed.yes || !process.stdin.isTTY) {
    return 'standard';
  }

  const answer = await ask(`Select Forge adoption profile (${ADOPTION_PROFILE_NAMES.join('/')}): `);
  return answer.trim() || 'standard';
}

async function handler(args, flags, projectRoot = process.cwd()) {
  const parsed = parseInitFlags(args, flags);
  if (parsed.error) {
    return { success: false, error: parsed.error };
  }
  const profile = await resolveProfile(parsed);
  if (!ADOPTION_PROFILE_NAMES.includes(profile)) {
    return {
      success: false,
      error: `Unknown adoption profile '${profile}'. Available profiles: ${ADOPTION_PROFILE_NAMES.join(', ')}`,
    };
  }
  const configYaml = renderAdoptionConfigYaml(profile);
  const forgeDir = path.join(projectRoot, '.forge');
  const configPath = path.join(forgeDir, 'config.yaml');

  if (fs.existsSync(configPath) && !parsed.force) {
    return {
      success: false,
      error: `.forge/config.yaml already exists. Re-run with --force to overwrite it.`,
    };
  }

  if (parsed.dryRun) {
    return { success: true, profile, configPath, output: configYaml };
  }

  fs.mkdirSync(forgeDir, { recursive: true });
  fs.writeFileSync(configPath, configYaml, 'utf8');

  console.log(`Initialized Forge adoption profile '${profile}' at .forge/config.yaml`);
  console.log('Inspect with: forge options lint && forge options diff');

  return { success: true, profile, configPath };
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
    '--yes': 'Use the standard profile when no profile is provided',
    '--force': 'Overwrite an existing .forge/config.yaml',
    '--dry-run': 'Print the generated config YAML without writing files',
  },
  handler,
  parseInitFlags,
};
