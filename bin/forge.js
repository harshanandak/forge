#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const COMMANDS = [
  'status.md', 'research.md', 'plan.md', 'dev.md', 'check.md',
  'ship.md', 'review.md', 'merge.md', 'verify.md'
];

const SKILLS_PARALLEL_AI = [
  'SKILL.md', 'README.md', 'api-reference.md', 'quick-reference.md', 'research-workflows.md'
];

const SKILLS_SONARCLOUD = ['SKILL.md', 'reference.md'];

console.log('');
console.log('  ___                   ');
console.log(' |  _|___  _ _  ___  ___ ');
console.log(' |  _| . || \'_|| . || -_|');
console.log(' |_| |___||_|  |_  ||___|');
console.log('                 |___|   ');
console.log('');
console.log('Installing Forge - 9-Stage TDD-First Workflow...');
console.log('');

// Get the project root (where npm install was run)
const projectRoot = process.env.INIT_CWD || process.cwd();

// Get the package directory (where forge is installed)
const packageDir = path.dirname(__dirname);

// Directories to create
const dirs = [
  '.claude/commands',
  '.claude/rules',
  '.claude/skills/parallel-ai',
  '.claude/skills/sonarcloud',
  '.claude/scripts',
  'docs/research'
];

// Create directories
console.log('Creating directories...');
dirs.forEach(dir => {
  const fullPath = path.join(projectRoot, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
});

// Copy function
function copyFile(src, dest) {
  try {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      return true;
    }
  } catch (err) {
    // Silently continue if file doesn't exist
  }
  return false;
}

// Copy commands
console.log('Copying workflow commands...');
COMMANDS.forEach(cmd => {
  const src = path.join(packageDir, '.claude/commands', cmd);
  const dest = path.join(projectRoot, '.claude/commands', cmd);
  if (copyFile(src, dest)) {
    console.log(`  ✓ ${cmd}`);
  }
});

// Copy rules
console.log('Copying workflow rules...');
const rulesSrc = path.join(packageDir, '.claude/rules/workflow.md');
const rulesDest = path.join(projectRoot, '.claude/rules/workflow.md');
if (copyFile(rulesSrc, rulesDest)) {
  console.log('  ✓ workflow.md');
}

// Copy skills
console.log('Copying skills...');
SKILLS_PARALLEL_AI.forEach(file => {
  const src = path.join(packageDir, '.claude/skills/parallel-ai', file);
  const dest = path.join(projectRoot, '.claude/skills/parallel-ai', file);
  copyFile(src, dest);
});
console.log('  ✓ parallel-ai');

SKILLS_SONARCLOUD.forEach(file => {
  const src = path.join(packageDir, '.claude/skills/sonarcloud', file);
  const dest = path.join(projectRoot, '.claude/skills/sonarcloud', file);
  copyFile(src, dest);
});
console.log('  ✓ sonarcloud');

// Copy scripts
console.log('Copying scripts...');
const scriptSrc = path.join(packageDir, '.claude/scripts/load-env.sh');
const scriptDest = path.join(projectRoot, '.claude/scripts/load-env.sh');
if (copyFile(scriptSrc, scriptDest)) {
  console.log('  ✓ load-env.sh');
}

// Copy documentation
console.log('Copying documentation...');
const workflowSrc = path.join(packageDir, 'docs/WORKFLOW.md');
const workflowDest = path.join(projectRoot, 'docs/WORKFLOW.md');
if (copyFile(workflowSrc, workflowDest)) {
  console.log('  ✓ WORKFLOW.md');
}

const templateSrc = path.join(packageDir, 'docs/research/TEMPLATE.md');
const templateDest = path.join(projectRoot, 'docs/research/TEMPLATE.md');
if (copyFile(templateSrc, templateDest)) {
  console.log('  ✓ research/TEMPLATE.md');
}

console.log('');
console.log('✅ Forge installed successfully!');
console.log('');
console.log('┌─────────────────────────────────────────────────────────┐');
console.log('│                    GET STARTED                          │');
console.log('├─────────────────────────────────────────────────────────┤');
console.log('│  /status    - Check current context                     │');
console.log('│  /research  - Start researching a feature               │');
console.log('│  /plan      - Create implementation plan                │');
console.log('│  /dev       - Start TDD development                     │');
console.log('│  /check     - Run validation                            │');
console.log('│  /ship      - Create pull request                       │');
console.log('│  /review    - Address PR feedback                       │');
console.log('│  /merge     - Merge and cleanup                         │');
console.log('│  /verify    - Final documentation check                 │');
console.log('├─────────────────────────────────────────────────────────┤');
console.log('│  Full guide: docs/WORKFLOW.md                           │');
console.log('│  Research template: docs/research/TEMPLATE.md           │');
console.log('└─────────────────────────────────────────────────────────┘');
console.log('');
