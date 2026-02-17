/**
 * skills init - Initialize skills registry in current project
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

export async function initCommand() {
  const skillsDir = join(process.cwd(), '.skills');
  const registryPath = join(skillsDir, '.registry.json');

  // Create .skills/ directory
  if (existsSync(skillsDir)) {
    console.log('⚠ Skills directory already exists');
  } else {
    mkdirSync(skillsDir, { recursive: true });
    console.log('✓ Created .skills/ directory');
  }

  // Create .registry.json if doesn't exist
  if (existsSync(registryPath)) {
    console.log('⚠ Registry already exists');
  } else {
    const registry = {
      version: '1.0.0',
      skills: {},
      config: {
        agents: {},
        autoSync: true,
        autoUpdateAgentsMd: true,
        preserveAgentsMd: false
      }
    };

    writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    console.log('✓ Created .registry.json');
  }

  console.log('\n✅ Skills registry initialized');
  console.log('\nNext steps:');
  console.log('  - Create a skill: skills create my-skill');
  console.log('  - List skills: skills list');
  console.log('  - Sync to agents: skills sync');
}
