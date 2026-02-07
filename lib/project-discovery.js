/**
 * Project Discovery
 *
 * Auto-detects project context (framework, language, stage) from file system.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

async function detectFramework(projectPath) {
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return null;

    const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
    const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    if (allDeps['next']) return 'Next.js';
    if (allDeps['react']) return 'React';
    if (allDeps['vue']) return 'Vue.js';
    if (allDeps['express']) return 'Express';
    return null;
  } catch (error) {
    // Return null if package.json doesn't exist or is invalid
    console.warn('Failed to detect framework:', error.message);
    return null;
  }
}

async function detectLanguage(projectPath) {
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
      const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      if (allDeps['typescript']) return 'typescript';
    }
    return 'javascript';
  } catch (error) {
    // Default to javascript if detection fails
    console.warn('Failed to detect language:', error.message);
    return 'javascript';
  }
}

async function getGitStats(projectPath) {
  try {
    const gitDir = path.join(projectPath, '.git');
    if (!fs.existsSync(gitDir)) {
      return { commits: 0, hasReleases: false };
    }

    // SECURITY: Safe - hardcoded commands, no user input
    // Use timeout to prevent hanging on slow git operations (Greptile feedback)
    const commitCount = execSync('git rev-list --count HEAD', {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000 // 5 second timeout
    }).trim();

    const tags = execSync('git tag', {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000 // 5 second timeout
    }).trim();

    return {
      commits: Number.parseInt(commitCount, 10) || 0,
      hasReleases: tags.split('\n').some(t => t.trim()) // Use .some() instead of .filter().length
    };
  } catch (error) {
    // Return defaults if git commands fail or timeout
    console.warn('Failed to get git stats:', error.message);
    return { commits: 0, hasReleases: false };
  }
}

async function detectCICD(projectPath) {
  const cicdPaths = [
    { path: '.github/workflows', type: 'GitHub Actions' },
    { path: '.gitlab-ci.yml', type: 'GitLab CI' }
  ];

  for (const { path: ciPath, type } of cicdPaths) {
    if (fs.existsSync(path.join(projectPath, ciPath))) {
      return { exists: true, type };
    }
  }

  return { exists: false, type: null };
}

async function getTestCoverage(projectPath) {
  try {
    const coveragePath = path.join(projectPath, 'coverage', 'coverage-summary.json');
    if (fs.existsSync(coveragePath)) {
      const coverageData = JSON.parse(await fs.promises.readFile(coveragePath, 'utf8'));
      // Use optional chaining for cleaner, safer access
      return coverageData.total?.lines?.pct || 0;
    }

    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return 0;

    const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
    // Use optional chaining
    if (!packageJson.scripts?.test) return 0;

    return 50;
  } catch (error) {
    // Return 0 if coverage files are missing or invalid
    console.warn('Failed to get test coverage:', error.message);
    return 0;
  }
}

function inferStage(stats) {
  const { commits = 0, hasCICD = false, hasReleases = false, coverage = 0 } = stats;

  if (commits > 500 && hasCICD && hasReleases && coverage > 80) {
    return 'stable';
  }

  if (commits < 50 && !hasCICD && coverage < 30) {
    return 'new';
  }

  if (commits < 20) {
    return 'new';
  }

  return 'active';
}

function calculateConfidence(context) {
  let score = 0;
  if (context.framework) score += 0.3;
  if (context.language) score += 0.2;
  if (context.commits > 0) score += 0.2;
  if (context.hasCICD) score += 0.15;
  if (context.coverage > 0) score += 0.15;
  return Math.max(score, 0.3);
}

async function autoDetect(projectPath) {
  const framework = await detectFramework(projectPath);
  const language = await detectLanguage(projectPath);
  const gitStats = await getGitStats(projectPath);
  const cicd = await detectCICD(projectPath);
  const coverage = await getTestCoverage(projectPath);

  const context = {
    framework,
    language,
    commits: gitStats.commits,
    hasCICD: cicd.exists,
    cicdType: cicd.type,
    hasReleases: gitStats.hasReleases,
    coverage
  };

  const stage = inferStage(context);
  const confidence = calculateConfidence({ ...context, stage });

  return { ...context, stage, confidence };
}

/**
 * Save detected context to .forge/context.json
 * Normalized to always expect flat object from autoDetect() (Greptile feedback)
 * @param {Object} context - Flat context object with framework, language, stage, confidence
 * @param {string} projectPath - Project root path
 */
async function saveContext(context, projectPath) {
  const forgeDir = path.join(projectPath, '.forge');
  const contextPath = path.join(forgeDir, 'context.json');

  await fs.promises.mkdir(forgeDir, { recursive: true });

  // Always expect flat shape from autoDetect(), build nested structure internally
  const data = {
    auto_detected: {
      framework: context.framework,
      language: context.language,
      stage: context.stage,
      confidence: context.confidence,
      // Include optional fields if present
      ...(context.commits !== undefined && { commits: context.commits }),
      ...(context.hasCICD !== undefined && { hasCICD: context.hasCICD }),
      ...(context.hasReleases !== undefined && { hasReleases: context.hasReleases }),
      ...(context.coverage !== undefined && { coverage: context.coverage })
    },
    user_provided: {},
    last_updated: new Date().toISOString()
  };

  await fs.promises.writeFile(contextPath, JSON.stringify(data, null, 2), 'utf8');
}

async function loadContext(projectPath) {
  try {
    const contextPath = path.join(projectPath, '.forge', 'context.json');
    if (!fs.existsSync(contextPath)) return null;

    const data = await fs.promises.readFile(contextPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // Return null if context file doesn't exist or is invalid
    console.warn('Failed to load context:', error.message);
    return null;
  }
}

module.exports = {
  autoDetect,
  detectFramework,
  detectLanguage,
  inferStage,
  getGitStats,
  detectCICD,
  getTestCoverage,
  calculateConfidence,
  saveContext,
  loadContext
};
