'use strict';

const fs = require('node:fs');
const YAML = require('yaml');

const PROTECTED_PATH_CATEGORY_IDS = [
	'forge_core',
	'user_protocol',
	'generated_artifacts',
	'append_only_logs',
	'secrets',
	'beads_state',
	'immutable',
];

const ALLOWED_MODES = [
	'checksum-verified',
	'cli-only',
	'ci-blocked',
	'runtime-only',
	'secret-scan-blocked',
	'bd-cli-only',
	'tool-owned',
];

const EXPECTED_CATEGORY_MODES = {
	forge_core: 'checksum-verified',
	user_protocol: 'cli-only',
	generated_artifacts: 'ci-blocked',
	append_only_logs: 'runtime-only',
	secrets: 'secret-scan-blocked',
	beads_state: 'bd-cli-only',
	immutable: 'tool-owned',
};

const DEFAULT_PROTECTED_PATH_MANIFEST = {
	schemaVersion: '1.0.0',
	kind: 'ProtectedPathManifest',
	manifestPath: '.forge/protected-paths.yaml',
	categories: [
		{
			id: 'forge_core',
			mode: 'checksum-verified',
			paths: ['lib/**', 'bin/**', 'scripts/**', 'skills/**'],
			ownerSurface: 'Forge core release or checksum updater',
			repairHint: 'Use the Forge release/update flow; do not hand-edit checksum-protected core files.',
		},
		{
			id: 'user_protocol',
			mode: 'cli-only',
			paths: [
				'AGENTS.md',
				'CLAUDE.md',
				'.cursorrules',
				'opencode.json',
				'.mcp.json',
				'.forge/config.yaml',
				'.forge/config.yml',
				'.forge/config.json',
				'.forge/protected-paths.yaml',
			],
			ownerSurface: 'forge setup or forge options',
			repairHint: 'Use Forge setup/options commands so harness protocol files stay synchronized.',
		},
		{
			id: 'generated_artifacts',
			mode: 'ci-blocked',
			paths: [
				'.claude/commands/**',
				'.claude/skills/**',
				'.cursor/rules/**',
				'.cursor/skills/**',
				'.codex/skills/**',
				'.cline/**',
				'.roo/**',
				'.kilocode/**',
				'.opencode/**',
				'.github/prompts/**',
				'.github/workflows/**',
				'.forge/hooks/**',
				'lefthook.yml',
				'.forge/extensions/*/manifest.json',
				'.github/PLUGIN_TEMPLATE.json',
				'plugins/*/plugin.json',
				'plugins/*/extension.json',
				'plugins/*/manifest.json',
				'bun.lock',
				'package-lock.json',
				'pnpm-lock.yaml',
				'yarn.lock',
				'requirements.lock',
				'poetry.lock',
				'Cargo.lock',
				'go.sum',
				'.forge/extensions.lock',
				'docs/sessions/**',
				'docs/memory/**',
				'.forge/memory/**',
				'memory.md',
				'MEMORY.md',
				'**/memory.md',
				'**/MEMORY.md',
			],
			ownerSurface: 'Forge harness renderer',
			repairHint: 'Regenerate harness artifacts from the canonical Forge contract.',
		},
		{
			id: 'append_only_logs',
			mode: 'runtime-only',
			paths: ['.forge/*.jsonl', '.forge/audit.log', '.forge/agent-log.ndjson', '.beads/*.jsonl', '.beads/interactions.jsonl'],
			ownerSurface: 'Forge or Beads audit writer',
			repairHint: 'Append through the runtime writer; do not rewrite audit history.',
		},
		{
			id: 'secrets',
			mode: 'secret-scan-blocked',
			paths: ['.env', '.env.*', '**/.env', '**/.env.*', 'secrets.json', '**/secrets.json', 'credentials.json', '**/credentials.json'],
			ownerSurface: 'secret manager',
			repairHint: 'Move secrets to the configured secret manager or local ignored env file.',
		},
		{
			id: 'beads_state',
			mode: 'bd-cli-only',
			paths: ['.beads/**'],
			ownerSurface: 'bd CLI or Forge issue adapter',
			repairHint: 'Use bd or Forge issue commands instead of editing Beads state files.',
		},
		{
			id: 'immutable',
			mode: 'tool-owned',
			paths: ['.git/**', '.hg/**', '.svn/**'],
			ownerSurface: 'VCS tool',
			repairHint: 'Use the owning VCS command instead of editing runtime internals.',
		},
	],
};

const PROTECTED_PATH_HARNESS_ENFORCEMENT = {
	claude: {
		status: 'native-hook-contract',
		surface: 'Claude PreToolUse hook for write/edit tools',
		configPath: '.claude/settings.json',
		evidenceRequired: ['hook receives target path', 'blocked write returns repair hint'],
	},
	cursor: {
		status: 'fallback',
		surface: 'Forge CLI/pre-commit check or file-watcher fallback',
		configPath: 'lefthook.yml',
		evidenceRequired: ['staged file check', 'watcher proof before native hook claim'],
		knownIssue: 'No verified Cursor hook surface; keep Cursor protected-path enforcement on Forge CLI/pre-commit fallback until proven.',
	},
	codex: {
		status: 'native-hook-contract',
		surface: 'Codex lifecycle hook for write/edit tools',
		configPath: '.codex/config.toml',
		evidenceRequired: ['hook receives target path', 'blocked write returns repair hint'],
	},
};

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function getDefaultProtectedPathManifest() {
	return clone(DEFAULT_PROTECTED_PATH_MANIFEST);
}

function getProtectedPathHarnessEnforcement() {
	return clone(PROTECTED_PATH_HARNESS_ENFORCEMENT);
}

function validateProtectedPathManifest(manifest) {
	const errors = [];
	if (!manifest || typeof manifest !== 'object') {
		return { ok: false, errors: ['Manifest must be an object.'] };
	}
	if (!isSupportedManifestKind(manifest)) {
		errors.push('kind must be ProtectedPathManifest or forge.protectedPaths.');
	}
	if (!isSupportedManifestVersion(manifest)) {
		errors.push('schemaVersion/version must be 1.0.0 or 1.');
	}

	if (isLegacyProtectedPathsManifest(manifest)) {
		if (!Array.isArray(manifest.paths) || manifest.paths.length === 0) {
			errors.push('Legacy forge.protectedPaths manifest must declare at least one path.');
		}
		return { ok: errors.length === 0, errors };
	}

	if (!Array.isArray(manifest.categories)) errors.push('categories must be an array.');

	const categories = Array.isArray(manifest.categories) ? manifest.categories : [];
	const ids = categories.map(category => category && category.id).filter(Boolean);
	for (const requiredId of PROTECTED_PATH_CATEGORY_IDS) {
		if (!ids.includes(requiredId)) errors.push(`Missing required protected path category: ${requiredId}.`);
	}
	const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
	if (duplicates.length > 0) errors.push(`Duplicate protected path categories: ${[...new Set(duplicates)].join(', ')}.`);

	for (const category of categories) {
		validateCategory(category, errors);
	}
	validateLegacySurfaceCoverage(manifest, categories, errors);

	return { ok: errors.length === 0, errors };
}

function validateCategory(category, errors) {
	if (!category || typeof category !== 'object') {
		errors.push('Each category must be an object.');
		return;
	}
	if (!category.id || typeof category.id !== 'string') errors.push('Category id must be a string.');
	if (!ALLOWED_MODES.includes(category.mode)) errors.push(`Invalid mode for ${category.id || 'unknown'}: ${category.mode}.`);
	const expectedMode = EXPECTED_CATEGORY_MODES[category.id];
	if (expectedMode && category.mode !== expectedMode) {
		errors.push(`Category ${category.id} must use mode ${expectedMode}.`);
	}
	if (!Array.isArray(category.paths) || category.paths.length === 0) {
		errors.push(`Category ${category.id || 'unknown'} must declare at least one path.`);
	}
	if (!category.ownerSurface || typeof category.ownerSurface !== 'string') {
		errors.push(`Category ${category.id || 'unknown'} must declare ownerSurface.`);
	}
	if (!category.repairHint || typeof category.repairHint !== 'string') {
		errors.push(`Category ${category.id || 'unknown'} must declare repairHint.`);
	}
}

function isSupportedManifestKind(manifest) {
	return manifest.kind === 'ProtectedPathManifest' || manifest.kind === 'forge.protectedPaths';
}

function isSupportedManifestVersion(manifest) {
	if (manifest.kind === 'ProtectedPathManifest') {
		return manifest.schemaVersion === '1.0.0';
	}
	if (manifest.kind === 'forge.protectedPaths') {
		return manifest.version === '1' || manifest.version === 1;
	}
	return false;
}

function isLegacyProtectedPathsManifest(manifest) {
	return manifest.kind === 'forge.protectedPaths';
}

function loadProtectedPathManifest(filePath) {
	const content = fs.readFileSync(filePath, 'utf8');
	return YAML.parse(content);
}

function buildProtectedPathManifestEvidence(manifest = getDefaultProtectedPathManifest()) {
	const categoryIds = Array.isArray(manifest.categoryIds)
		? manifest.categoryIds
		: Array.isArray(manifest.categories)
			? manifest.categories.map(category => category && category.id).filter(Boolean)
			: PROTECTED_PATH_CATEGORY_IDS;
	return {
		schemaVersion: manifest.schemaVersion,
		kind: 'forge.protectedPathManifest',
		manifestPath: manifest.manifestPath || '.forge/protected-paths.yaml',
		categoryIds,
		categories: manifest.categories,
		harnessEnforcement: getProtectedPathHarnessEnforcement(),
		validation: validateProtectedPathManifest(manifest),
	};
}

function validateLegacySurfaceCoverage(manifest, categories, errors) {
	if (!manifest.surfaces) return;
	if (manifest.surfacesDeprecated !== true) {
		errors.push('surfaces must be marked surfacesDeprecated: true when categories are authoritative.');
	}
	if (!manifest.surfacesMigrationNote || typeof manifest.surfacesMigrationNote !== 'string') {
		errors.push('surfacesMigrationNote must describe the legacy surfaces migration.');
	}
	const categoryPaths = categories.flatMap(category => (Array.isArray(category.paths) ? category.paths : []));
	for (const [surfaceId, surface] of Object.entries(manifest.surfaces)) {
		if (!Array.isArray(surface?.examples) || surface.examples.length === 0) {
			errors.push(`Legacy surface ${surfaceId} must declare examples for category coverage.`);
			continue;
		}
		for (const example of surface.examples) {
			if (!categoryPaths.some(pattern => pathPatternCoversExample(pattern, example))) {
				errors.push(`Legacy surface ${surfaceId} example is not covered by category paths: ${example}.`);
			}
		}
	}
}

function pathPatternCoversExample(pattern, example) {
	const normalizedPattern = normalizeManifestPath(pattern);
	const normalizedExample = normalizeManifestPath(example);
	if (normalizedPattern === normalizedExample) return true;
	if (normalizedPattern.endsWith('/**')) {
		const prefix = normalizedPattern.slice(0, -3);
		return normalizedExample === prefix || normalizedExample.startsWith(`${prefix}/`);
	}
	return wildcardPatternToRegex(normalizedPattern).test(normalizedExample);
}

function normalizeManifestPath(value) {
	return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, '');
}

function wildcardPatternToRegex(pattern) {
	let source = '';
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === '*' && pattern[index + 1] === '*') {
			source += '.*';
			index += 1;
		} else if (character === '*') {
			source += '[^/]*';
		} else {
			source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
		}
	}
	return new RegExp(`^${source}$`);
}

module.exports = {
	PROTECTED_PATH_CATEGORY_IDS,
	buildProtectedPathManifestEvidence,
	getDefaultProtectedPathManifest,
	getProtectedPathHarnessEnforcement,
	loadProtectedPathManifest,
	validateProtectedPathManifest,
};
