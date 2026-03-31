/**
 * detection-utils.js — Project detection utilities extracted from bin/forge.js
 *
 * Functions that previously relied on the module-level `projectRoot` variable
 * now accept it as an explicit parameter. Functions that mutated the module-level
 * `PKG_MANAGER` variable now return a result object instead.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

/**
 * Safely execute a shell command, returning trimmed stdout or null.
 * NOTE: This uses execSync intentionally for non-user-input detection commands
 * like `bun --version`, `npm --version`, etc. The command strings are hardcoded
 * constants, not user input, so shell injection is not a concern here.
 * @param {string} cmd - Command to run (must be a hardcoded constant).
 * @returns {string|null} Trimmed output or null on failure.
 */
function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (_e) { // NOSONAR — intentional: safeExec returns null on any failure (command not found, etc.)
    return null;
  }
}

/**
 * Detect a package manager from lock file presence.
 * @param {string} name - Package manager name (e.g. 'bun').
 * @param {string[]} lockFiles - Lock file names to check.
 * @param {string} versionPrefix - Display prefix for version string.
 * @param {string} projectRoot - Absolute path to project root.
 * @returns {{ found: boolean, name: string, version: string|null }} Detection result.
 */
function detectFromLockFile(name, lockFiles, versionPrefix, projectRoot) {
  const found = lockFiles.some(f => fs.existsSync(path.join(projectRoot, f)));
  if (!found) return { found: false, name, version: null };

  const version = safeExec(`${name} --version`);
  if (version) console.log(`  ✓ ${versionPrefix}${version} (detected from lock file)`);
  return { found: true, name, version };
}

/**
 * Detect a package manager from command availability.
 * @param {string} name - Package manager name.
 * @param {string} versionPrefix - Display prefix for version string.
 * @returns {{ found: boolean, name: string, version: string|null }} Detection result.
 */
function detectFromCommand(name, versionPrefix) {
  const version = safeExec(`${name} --version`);
  if (!version) return { found: false, name, version: null };

  console.log(`  ✓ ${versionPrefix}${version} (detected as package manager)`);
  return { found: true, name, version };
}

/**
 * Detect package manager from lock files and command availability.
 * @param {string[]} errors - Array to push error messages into.
 * @param {string} projectRoot - Absolute path to project root.
 * @returns {{ name: string, version: string|null }|null} Detected manager, or null.
 */
function detectPackageManager(errors, projectRoot) {
  // Check lock files first (most authoritative)
  const lockFileChecks = [
    { name: 'bun', files: ['bun.lockb', 'bun.lock'], prefix: 'bun v' },
    { name: 'pnpm', files: ['pnpm-lock.yaml'], prefix: 'pnpm ' },
    { name: 'yarn', files: ['yarn.lock'], prefix: 'yarn ' },
  ];

  for (const check of lockFileChecks) {
    const result = detectFromLockFile(check.name, check.files, check.prefix, projectRoot);
    if (result.found) return result;
  }

  // Fallback: detect from installed commands
  const commandChecks = [
    { name: 'bun', prefix: 'bun v' },
    { name: 'pnpm', prefix: 'pnpm ' },
    { name: 'yarn', prefix: 'yarn ' },
    { name: 'npm', prefix: 'npm ' },
  ];

  for (const check of commandChecks) {
    const result = detectFromCommand(check.name, check.prefix);
    if (result.found) return result;
  }

  // No package manager found
  errors.push('npm, yarn, pnpm, or bun - Install a package manager');
  return null;
}

/**
 * Detect test framework from dependency map.
 * @param {Object} deps - Combined dependencies object.
 * @returns {string|null} Framework name or null.
 */
function detectTestFramework(deps) {
  if (deps.jest) return 'jest';
  if (deps.vitest) return 'vitest';
  if (deps.mocha) return 'mocha';
  if (deps['@playwright/test']) return 'playwright';
  if (deps.cypress) return 'cypress';
  if (deps.karma) return 'karma';
  return null;
}

/**
 * Detect language features (TypeScript, monorepo, Docker, CI/CD).
 * @param {Object} pkg - Parsed package.json.
 * @param {string} projectRoot - Absolute path to project root.
 * @returns {{ typescript: boolean, monorepo: boolean, docker: boolean, cicd: boolean }}
 */
function detectLanguageFeatures(pkg, projectRoot) {
  const features = {
    typescript: false,
    monorepo: false,
    docker: false,
    cicd: false
  };

  // Detect TypeScript
  if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
    features.typescript = true;
  }

  // Detect monorepo
  if (pkg.workspaces ||
    fs.existsSync(path.join(projectRoot, 'pnpm-workspace.yaml')) ||
    fs.existsSync(path.join(projectRoot, 'lerna.json'))) {
    features.monorepo = true;
  }

  // Detect Docker
  if (fs.existsSync(path.join(projectRoot, 'Dockerfile')) ||
    fs.existsSync(path.join(projectRoot, 'docker-compose.yml'))) {
    features.docker = true;
  }

  // Detect CI/CD
  if (fs.existsSync(path.join(projectRoot, '.github/workflows')) ||
    fs.existsSync(path.join(projectRoot, '.gitlab-ci.yml')) ||
    fs.existsSync(path.join(projectRoot, 'azure-pipelines.yml')) ||
    fs.existsSync(path.join(projectRoot, '.circleci/config.yml'))) {
    features.cicd = true;
  }

  return features;
}

/**
 * Detect Next.js framework.
 * @param {Object} deps - Combined dependencies.
 * @returns {Object|null} Framework info or null.
 */
function detectNextJs(deps) {
  if (!deps.next) return null;

  return {
    framework: 'Next.js',
    frameworkConfidence: 100,
    projectType: 'fullstack',
    buildTool: 'next',
    testFramework: detectTestFramework(deps)
  };
}

/**
 * Detect NestJS framework.
 * @param {Object} deps - Combined dependencies.
 * @returns {Object|null} Framework info or null.
 */
function detectNestJs(deps) {
  if (!deps['@nestjs/core'] && !deps['@nestjs/common']) return null;

  return {
    framework: 'NestJS',
    frameworkConfidence: 100,
    projectType: 'backend',
    buildTool: 'nest',
    testFramework: 'jest'
  };
}

/**
 * Detect Angular framework.
 * @param {Object} deps - Combined dependencies.
 * @returns {Object|null} Framework info or null.
 */
function detectAngular(deps) {
  if (!deps['@angular/core'] && !deps['@angular/cli']) return null;

  return {
    framework: 'Angular',
    frameworkConfidence: 100,
    projectType: 'frontend',
    buildTool: 'ng',
    testFramework: 'karma'
  };
}

/**
 * Detect Vue.js / Nuxt framework.
 * @param {Object} deps - Combined dependencies.
 * @returns {Object|null} Framework info or null.
 */
function detectVue(deps) {
  if (!deps.vue) return null;

  if (deps.nuxt) {
    return {
      framework: 'Nuxt',
      frameworkConfidence: 100,
      projectType: 'fullstack',
      buildTool: 'nuxt',
      testFramework: detectTestFramework(deps)
    };
  }

  const hasVite = deps.vite;
  const hasWebpack = deps.webpack;

  // Determine build tool without nested ternary
  let buildTool = 'vue-cli';
  if (hasVite) {
    buildTool = 'vite';
  } else if (hasWebpack) {
    buildTool = 'webpack';
  }

  return {
    framework: 'Vue.js',
    frameworkConfidence: deps['@vue/cli'] ? 100 : 90,
    projectType: 'frontend',
    buildTool,
    testFramework: detectTestFramework(deps)
  };
}

/**
 * Detect React framework.
 * @param {Object} deps - Combined dependencies.
 * @returns {Object|null} Framework info or null.
 */
function detectReact(deps) {
  if (!deps.react) return null;

  const hasVite = deps.vite;
  const hasReactScripts = deps['react-scripts'];

  // Determine build tool without nested ternary
  let buildTool = 'webpack';
  if (hasVite) {
    buildTool = 'vite';
  } else if (hasReactScripts) {
    buildTool = 'create-react-app';
  }

  return {
    framework: 'React',
    frameworkConfidence: 95,
    projectType: 'frontend',
    buildTool,
    testFramework: detectTestFramework(deps)
  };
}

/**
 * Detect Express framework.
 * @param {Object} deps - Combined dependencies.
 * @param {{ typescript: boolean }} features - Language features.
 * @returns {Object|null} Framework info or null.
 */
function detectExpress(deps, features) {
  if (!deps.express) return null;

  return {
    framework: 'Express',
    frameworkConfidence: 90,
    projectType: 'backend',
    buildTool: features.typescript ? 'tsc' : 'node',
    testFramework: detectTestFramework(deps)
  };
}

/**
 * Detect Fastify framework.
 * @param {Object} deps - Combined dependencies.
 * @param {{ typescript: boolean }} features - Language features.
 * @returns {Object|null} Framework info or null.
 */
function detectFastify(deps, features) {
  if (!deps.fastify) return null;

  return {
    framework: 'Fastify',
    frameworkConfidence: 95,
    projectType: 'backend',
    buildTool: features.typescript ? 'tsc' : 'node',
    testFramework: detectTestFramework(deps)
  };
}

/**
 * Detect Svelte / SvelteKit framework.
 * @param {Object} deps - Combined dependencies.
 * @returns {Object|null} Framework info or null.
 */
function detectSvelte(deps) {
  if (!deps.svelte) return null;

  if (deps['@sveltejs/kit']) {
    return {
      framework: 'SvelteKit',
      frameworkConfidence: 100,
      projectType: 'fullstack',
      buildTool: 'vite',
      testFramework: detectTestFramework(deps)
    };
  }

  return {
    framework: 'Svelte',
    frameworkConfidence: 95,
    projectType: 'frontend',
    buildTool: 'vite',
    testFramework: detectTestFramework(deps)
  };
}

/**
 * Detect Remix framework.
 * @param {Object} deps - Combined dependencies.
 * @returns {Object|null} Framework info or null.
 */
function detectRemix(deps) {
  if (!deps['@remix-run/react']) return null;

  return {
    framework: 'Remix',
    frameworkConfidence: 100,
    projectType: 'fullstack',
    buildTool: 'remix',
    testFramework: detectTestFramework(deps)
  };
}

/**
 * Detect Astro framework.
 * @param {Object} deps - Combined dependencies.
 * @returns {Object|null} Framework info or null.
 */
function detectAstro(deps) {
  if (!deps.astro) return null;

  return {
    framework: 'Astro',
    frameworkConfidence: 100,
    projectType: 'frontend',
    buildTool: 'astro',
    testFramework: detectTestFramework(deps)
  };
}

/**
 * Detect generic Node.js project.
 * @param {Object} pkg - Parsed package.json.
 * @param {Object} deps - Combined dependencies.
 * @param {{ typescript: boolean }} features - Language features.
 * @returns {Object|null} Framework info or null.
 */
function detectGenericNodeJs(pkg, deps, features) {
  if (!pkg.main && !pkg.scripts?.start) return null;

  return {
    framework: 'Node.js',
    frameworkConfidence: 70,
    projectType: 'backend',
    buildTool: features.typescript ? 'tsc' : 'node',
    testFramework: detectTestFramework(deps)
  };
}

module.exports = {
  detectFromLockFile,
  detectFromCommand,
  detectPackageManager,
  detectTestFramework,
  detectLanguageFeatures,
  detectNextJs,
  detectNestJs,
  detectAngular,
  detectVue,
  detectReact,
  detectExpress,
  detectFastify,
  detectSvelte,
  detectRemix,
  detectAstro,
  detectGenericNodeJs,
};
