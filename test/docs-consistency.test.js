const { describe, it, expect } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');

/**
 * Reads a file relative to the project root.
 * @param {string} relPath - Relative path from project root
 * @returns {string} File contents as UTF-8 string
 */
function readDoc(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

describe('README.md consistency', () => {
  const readme = readDoc('README.md');

  it('uses bun add -D for install command (dev dependency)', () => {
    expect(readme).toContain('bun add -D forge-workflow');
  });

  it('does not use the old bun install command for package install', () => {
    // The old install command should not appear as the primary install instruction.
    // We check that "bun install forge-workflow" does NOT appear (it was replaced).
    // Note: "bun install" alone (for deps) is fine; we specifically check the package name.
    expect(readme).not.toContain('bun install forge-workflow');
  });

  it('documents --dry-run flag', () => {
    expect(readme).toContain('--dry-run');
  });

  it('documents --non-interactive flag', () => {
    expect(readme).toContain('--non-interactive');
  });

  it('documents --symlink flag', () => {
    expect(readme).toContain('--symlink');
  });

  it('documents --sync flag', () => {
    expect(readme).toContain('--sync');
  });

  it('documents --agents flag', () => {
    expect(readme).toContain('--agents');
  });

  it('mentions CI auto-detection', () => {
    expect(readme).toContain('CI=true');
  });
});

describe('docs/INDEX.md reference links', () => {
  const index = readDoc('docs/INDEX.md');

  it('links to agent skill parity proof boundary docs', () => {
    expect(index).toContain('reference/AGENT_SKILL_PARITY.md');
  });
});

describe('docs/reference/AGENT_SKILL_PARITY.md follow-up boundary', () => {
  const parity = readDoc('docs/reference/AGENT_SKILL_PARITY.md');

  it('documents the skills-first stage graph follow-up', () => {
    expect(parity).toContain('Required Follow-Up: Skills-First Stage Graph');
    expect(parity).toContain('Tracked as `forge-wj36`');
    expect(parity).toContain('Claude commands should become compatibility shims');
    expect(parity).toContain('Cursor Agent Skills are not proven in the W0 fixture');
  });

  it('documents the machine-readable capability matrix evidence command', () => {
    expect(parity).toContain('node scripts/spikes/harness-capability-matrix.js');
    expect(parity).toContain('lib/harness-capability-matrix.js');
    expect(parity).toContain('rendererContract.rendererFamilies');
    expect(parity).toContain('Cursor hooks remain unsupported');
	});
});

describe('docs/PROJECT_DESIGN.md authority boundary', () => {
	const projectDesign = readDoc('docs/PROJECT_DESIGN.md');

	it('states routine Kernel authority state is not persisted through repository metadata commits', () => {
		expect(projectDesign).toContain('Routine issue, workflow, claim, run, and knowledge writes must not depend on committing repository metadata to the protected default branch');
		expect(projectDesign).toContain('Local-only state uses the local Kernel SQLite authority');
		expect(projectDesign).toContain('cross-machine or team state uses serialized server authority');
	});
});

describe('docs/reference/FORGE_KERNEL_STORAGE_MODEL.md authority boundary', () => {
	const storageModel = readDoc('docs/reference/FORGE_KERNEL_STORAGE_MODEL.md');

	it('separates local/server authority from repository projections', () => {
		expect(storageModel).toContain('Routine close/verify state is never made durable by committing tracker metadata to the protected default branch');
		expect(storageModel).toContain('Repository exports are explicit projection artifacts, not the write-ahead log for normal work');
	});
});

describe('docs/guides/SETUP.md consistency', () => {
	const setup = readDoc('docs/guides/SETUP.md');

  it('mentions install.sh is a bootstrapper', () => {
    expect(setup).toContain('bootstrapper');
  });

  it('documents PAT requirements for Beads sync', () => {
    // Should mention either PAT or BEADS_SYNC_TOKEN
    const mentionsPat = setup.includes('PAT') || setup.includes('BEADS_SYNC_TOKEN');
    expect(mentionsPat).toBe(true);
  });

  it('documents Beads sync setup with --sync flag', () => {
    expect(setup).toContain('--sync');
  });

  it('uses bun add -D for install command (dev dependency)', () => {
    expect(setup).toContain('bun add -D forge-workflow');
  });
});

describe('CHANGELOG.md consistency', () => {
  const changelog = readDoc('CHANGELOG.md');

  it('has an entry for the install-fixes changes', () => {
    // Should mention key features from this branch
    expect(changelog).toContain('bootstrapper');
  });

  it('mentions --dry-run in changelog', () => {
    expect(changelog).toContain('--dry-run');
  });

  it('mentions --symlink in changelog', () => {
    expect(changelog).toContain('--symlink');
  });

  it('mentions Beads sync', () => {
    const mentionsBeadsSync = changelog.includes('Beads sync') || changelog.includes('beads sync');
    expect(mentionsBeadsSync).toBe(true);
  });
});
