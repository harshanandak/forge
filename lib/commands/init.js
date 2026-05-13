const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const {
  ADOPTION_PROFILE_NAMES,
  renderAdoptionConfigYaml,
} = require('../adoption-profiles');

function usage() {
  return [
    'Usage: forge init [--profile minimal|standard|full] [--yes] [--force]',
    '',
    'Initialize .forge/config.yaml for a fresh repository.',
  ].join('\n');
}

function parseInitFlags(args = [], flags = {}) {
  const parsed = {
    profile: flags.profile || null,
    yes: Boolean(flags.yes || flags.nonInteractive),
    force: Boolean(flags.force),
    dryRun: Boolean(flags.dryRun),
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--profile' && args[index + 1]) {
      parsed.profile = args[++index];
    } else if (arg.startsWith('--profile=')) {
      parsed.profile = arg.slice('--profile='.length);
    } else if (arg === '--yes' || arg === '-y') {
      parsed.yes = true;
    } else if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--minimal') {
      parsed.profile = 'minimal';
      parsed.yes = true;
    } else if (arg === '--standard') {
      parsed.profile = 'standard';
      parsed.yes = true;
    } else if (arg === '--full') {
      parsed.profile = 'full';
      parsed.yes = true;
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
  if (parsed.yes) {
    return 'standard';
  }

  const answer = await ask(`Select Forge adoption profile (${ADOPTION_PROFILE_NAMES.join('/')}): `);
  return answer.trim() || 'standard';
}

async function handler(args, flags, projectRoot = process.cwd()) {
  const parsed = parseInitFlags(args, flags);
  const profile = await resolveProfile(parsed);
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
    console.log(configYaml);
    return { success: true, profile, configPath };
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
  },
  handler,
  parseInitFlags,
};
