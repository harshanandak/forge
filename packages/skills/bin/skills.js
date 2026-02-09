#!/usr/bin/env node

/**
 * Skills CLI - Universal tool for managing SKILL.md files
 *
 * Entry point for the skills command-line interface.
 * Provides commands for creating, managing, and syncing skills across AI agents.
 */

import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

// Get package version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf8')
);

// Import commands
import { initCommand } from '../src/commands/init.js';
import { createCommand } from '../src/commands/create.js';
import { listCommand } from '../src/commands/list.js';
import { syncCommand } from '../src/commands/sync.js';
import { removeCommand } from '../src/commands/remove.js';
import { validateCommand } from '../src/commands/validate.js';
import { addCommand } from '../src/commands/add.js';
import { publishCommand } from '../src/commands/publish.js';
import { searchCommand } from '../src/commands/search.js';
import { configCommand } from '../src/commands/config.js';

const program = new Command();

program
  .name('skills')
  .description('Universal CLI tool for managing SKILL.md files across all AI agents')
  .version(packageJson.version);

// skills init
program
  .command('init')
  .description('Initialize skills registry in current project')
  .action(initCommand);

// skills create <name>
program
  .command('create <name>')
  .description('Create new skill from template')
  .option('-t, --template <type>', 'Template type (research, coding, review, testing, deployment)', 'default')
  .option('--ai <description>', 'AI-powered creation (v1.1 feature)')
  .action(createCommand);

// skills list
program
  .command('list')
  .description('Show all installed skills')
  .option('-c, --category <category>', 'Filter by category')
  .option('-a, --agent <agent>', 'Filter by agent')
  .action(listCommand);

// skills sync
program
  .command('sync')
  .description('Synchronize skills to agent directories')
  .option('--preserve-agents', 'Skip AGENTS.md update')
  .action(syncCommand);

// skills remove <name>
program
  .command('remove <name>')
  .description('Uninstall skill')
  .option('-f, --force', 'Skip confirmation')
  .action(removeCommand);

// skills validate <name>
program
  .command('validate <name>')
  .description('Validate skill by name')
  .action(validateCommand);

// skills add <name>
program
  .command('add <name>')
  .description('Install skill from Vercel registry')
  .option('-f, --force', 'Overwrite if skill exists')
  .option('--no-sync', 'Skip auto-sync to agents')
  .action(addCommand);

// skills publish <name>
program
  .command('publish <name>')
  .description('Publish skill to Vercel registry')
  .option('-f, --force', 'Overwrite if skill exists in registry')
  .action(publishCommand);

// skills search <query>
program
  .command('search <query>')
  .description('Search Vercel registry for skills')
  .option('-c, --category <category>', 'Filter by category')
  .option('-a, --author <author>', 'Filter by author')
  .action(searchCommand);

// skills config
program
  .command('config <action> [key] [value]')
  .description('Manage configuration (API keys, registry URL)')
  .action(configCommand);

// Parse arguments
program.parse();
