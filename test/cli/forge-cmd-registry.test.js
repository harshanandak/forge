const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const FORGE_CMD_PATH = path.join(__dirname, '../../bin/forge-cmd.js');

describe('forge-cmd.js registry migration', () => {
	test('should NOT contain a hardcoded HANDLERS object', () => {
		const source = fs.readFileSync(FORGE_CMD_PATH, 'utf8');

		// The old pattern: const HANDLERS = { status: require(...), ... }
		// After migration, this should be replaced with registry import
		expect(source).not.toMatch(/const\s+HANDLERS\s*=/);
	});

	test('should import loadCommands from _registry', () => {
		const source = fs.readFileSync(FORGE_CMD_PATH, 'utf8');
		expect(source).toMatch(/require\(['"]\.\.\/lib\/commands\/_registry['"]\)/);
	});

	test('should call loadCommands to build command map', () => {
		const source = fs.readFileSync(FORGE_CMD_PATH, 'utf8');
		expect(source).toMatch(/loadCommands\(/);
	});

	test('should NOT directly require individual command modules', () => {
		const source = fs.readFileSync(FORGE_CMD_PATH, 'utf8');

		// Should not have direct requires like require('../lib/commands/status')
		// The registry handles loading all command modules
		const directRequires = source.match(/require\(['"]\.\.\/lib\/commands\/(?!_registry)[a-z]+['"]\)/g);
		expect(directRequires).toBeNull();
	});
});
