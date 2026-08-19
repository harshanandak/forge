'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { describe, expect, test } = require('bun:test');

const {
	FILE_ALL_ACCESS,
	inspectDescriptor,
	inspectIidDescriptor,
	runWithDependencies,
} = require('../../lib/kernel/windows-private-acl');
const {
	WINDOWS_PRIVATE_ACL_SCRIPT_PATH,
	WINDOWS_PRIVATE_ACL_SCRIPT_SHA256,
} = require('../../lib/kernel/sqlite-driver');

const OWNER_SID = 'S-1-5-21-101-202-303-404';
const FOREIGN_SID = 'S-1-5-21-999-888-777-666';

function u16(value) {
	return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value) {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function sidBytes(value) {
	const parts = value.split('-').slice(1).map(Number);
	const [revision, authority, ...subAuthorities] = parts;
	return [revision, subAuthorities.length, 0, 0, 0, 0, 0, authority, ...subAuthorities.flatMap(u32)];
}

function descriptorBytes({
	aceFlags = 0,
	aceMask = FILE_ALL_ACCESS,
	aceType = 0,
	control = 0x9004,
	extraAceBytes = [],
	ownerSid = OWNER_SID,
	trusteeSid = ownerSid,
} = {}) {
	const owner = sidBytes(ownerSid);
	const trustee = sidBytes(trusteeSid);
	const aceSize = 8 + trustee.length + extraAceBytes.length;
	const ace = [aceType, aceFlags, ...u16(aceSize), ...u32(aceMask), ...trustee, ...extraAceBytes];
	const acl = [2, 0, ...u16(8 + ace.length), ...u16(1), 0, 0, ...ace];
	const ownerOffset = 20;
	const daclOffset = ownerOffset + owner.length;
	return [1, 0, ...u16(control), ...u32(ownerOffset), ...u32(0), ...u32(0), ...u32(daclOffset), ...owner, ...acl];
}

function environmentFor(paths, sid = OWNER_SID) {
	const values = {
		FORGE_PRIVATE_ACL_COUNT: String(paths.length),
		FORGE_PRIVATE_ACL_SID: sid,
	};
	paths.forEach((targetPath, index) => { values[`FORGE_PRIVATE_ACL_TARGET_${index}`] = targetPath; });
	return name => values[name] || '';
}

function enumeratorFactory(dacl) {
	let index = 0;
	return {
		atEnd: () => index >= dacl.entries.length,
		item: () => dacl.entries[index],
		moveNext: () => { index += 1; },
	};
}

function captureError(action) {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error('expected action to throw');
}

function fakeDependencies(states, events) {
	const utility = {
		SecurityMask: 0,
		GetSecurityDescriptor(targetPath, _pathFormat, format) {
			events.push(['get', targetPath, format, this.SecurityMask]);
			return format === 2 ? states[targetPath].raw : states[targetPath].iid;
		},
		SetSecurityDescriptor(targetPath, _pathFormat, descriptor, format) {
			events.push(['set', targetPath, format, this.SecurityMask]);
			expect(this.SecurityMask).toBe(4 | 0x80000000);
			const ace = descriptor.DiscretionaryAcl.entries[0];
			states[targetPath] = {
				iid: descriptor,
				raw: descriptorBytes({ aceFlags: ace.AceFlags }),
			};
		},
	};
	return {
		createObject(name) {
			if (name === 'AccessControlList') {
				return { AceCount: 0, entries: [], AddAce(ace) { this.entries.push(ace); this.AceCount += 1; } };
			}
			if (name === 'AccessControlEntry') return {};
			throw new Error(`unexpected object ${name}`);
		},
		enumeratorFactory,
		environment: environmentFor(Object.keys(states)),
		fso: {
			FileExists: targetPath => !states[targetPath].isDirectory,
			FolderExists: targetPath => states[targetPath].isDirectory,
		},
		utility,
	};
}

describe('Windows private ACL cscript verifier', () => {
	test('exports the exact file full-control mask and raw descriptor verifier', () => {
		expect(FILE_ALL_ACCESS).toBe(0x001f01ff);
		expect(typeof inspectDescriptor).toBe('function');
		const source = fs.readFileSync(WINDOWS_PRIVATE_ACL_SCRIPT_PATH);
		expect(createHash('sha256').update(source).digest('hex'))
			.toBe(WINDOWS_PRIVATE_ACL_SCRIPT_SHA256);
		expect(source.toString('utf8')).not.toMatch(/SetOwner|PowerShell|icacls|child_process/i);
	});

	test('accepts only protected exact owner full-control file and directory descriptors', () => {
		expect(inspectDescriptor(descriptorBytes(), OWNER_SID, 0)).toEqual({ aceFlags: 0, ownerSid: OWNER_SID });
		expect(inspectDescriptor(descriptorBytes({ aceFlags: 3 }), OWNER_SID, 3))
			.toEqual({ aceFlags: 3, ownerSid: OWNER_SID });
	});

	test('rejects unprotected, foreign, deny, inherited, partial, object, trailing, and malformed descriptors', () => {
		expect(() => inspectDescriptor(descriptorBytes({ control: 0x8004 }), OWNER_SID, 0)).toThrow('not protected');
		expect(() => inspectDescriptor(descriptorBytes({ ownerSid: FOREIGN_SID }), OWNER_SID, 0)).toThrow('owner changed');
		expect(() => inspectDescriptor(descriptorBytes({ trusteeSid: FOREIGN_SID }), OWNER_SID, 0)).toThrow('trustee');
		expect(() => inspectDescriptor(descriptorBytes({ aceType: 1 }), OWNER_SID, 0)).toThrow('allow');
		expect(() => inspectDescriptor(descriptorBytes({ aceFlags: 0x10 }), OWNER_SID, 0)).toThrow('flags');
		expect(() => inspectDescriptor(descriptorBytes({ aceMask: 0x00120089 }), OWNER_SID, 0)).toThrow('full control');
		expect(() => inspectDescriptor(descriptorBytes({ aceType: 5 }), OWNER_SID, 0)).toThrow('allow');
		expect(() => inspectDescriptor(descriptorBytes({ extraAceBytes: [1, 2, 3, 4] }), OWNER_SID, 0)).toThrow('trailing');
		expect(() => inspectDescriptor(descriptorBytes().slice(0, 24), OWNER_SID, 0)).toThrow();
		const iid = {
			Control: 0x9004,
			DiscretionaryAcl: {
				AceCount: 1,
				entries: [{ AccessMask: FILE_ALL_ACCESS, AceFlags: 0, AceType: 0 }],
			},
			Owner: OWNER_SID,
		};
		expect(() => inspectIidDescriptor({ ...iid, Owner: FOREIGN_SID }, OWNER_SID, 0, enumeratorFactory))
			.toThrow('IID owner changed');
		expect(() => inspectIidDescriptor(iid, OWNER_SID, 0, enumeratorFactory)).not.toThrow();
	});

	test('prechecks every owner before DACL-only mutation and immediately rechecks each target', () => {
		const states = {
			'C:\\one': { iid: { Control: 0x8004, DiscretionaryAcl: {}, Owner: OWNER_SID }, isDirectory: false, raw: descriptorBytes() },
			'C:\\two': { iid: { Control: 0x8004, DiscretionaryAcl: {}, Owner: OWNER_SID }, isDirectory: true, raw: descriptorBytes() },
		};
		const events = [];
		const originalVBArray = globalThis.VBArray;
		globalThis.VBArray = function (value) { this.toArray = () => value; };
		try {
			expect(runWithDependencies(fakeDependencies(states, events))).toBe(true);
		} finally {
			globalThis.VBArray = originalVBArray;
		}
		const sets = events.filter(([operation]) => operation === 'set');
		expect(sets).toEqual([
			['set', 'C:\\one', 1, 4 | 0x80000000],
			['set', 'C:\\two', 1, 4 | 0x80000000],
		]);
		const firstSet = events.findIndex(([operation]) => operation === 'set');
		expect(events.slice(0, firstSet).filter(([operation]) => operation === 'get')).toHaveLength(6);
		expect(events[firstSet - 2]).toEqual(['get', 'C:\\one', 2, 5]);
		expect(events[firstSet - 1]).toEqual(['get', 'C:\\one', 1, 5]);
	});

	test('a non-owner precheck or owner race causes zero DACL mutation', () => {
		const originalVBArray = globalThis.VBArray;
		globalThis.VBArray = function (value) { this.toArray = () => value; };
		try {
			const nonOwnerStates = {
				'C:\\one': { iid: { Owner: OWNER_SID }, isDirectory: false, raw: descriptorBytes() },
				'C:\\two': { iid: { Owner: FOREIGN_SID }, isDirectory: false, raw: descriptorBytes({ ownerSid: FOREIGN_SID }) },
			};
			const nonOwnerEvents = [];
			const nonOwnerError = captureError(() => runWithDependencies(fakeDependencies(nonOwnerStates, nonOwnerEvents)));
			expect(nonOwnerError.message).toContain('precheck owner mismatch');
			expect(nonOwnerError.forgeExitCode).toBe(24);
			expect(nonOwnerEvents.some(([operation]) => operation === 'set')).toBe(false);

			const racedStates = {
				'C:\\one': { iid: { Owner: OWNER_SID }, isDirectory: false, raw: descriptorBytes() },
			};
			const racedEvents = [];
			const dependencies = fakeDependencies(racedStates, racedEvents);
			let rawReads = 0;
			const get = dependencies.utility.GetSecurityDescriptor;
			dependencies.utility.GetSecurityDescriptor = function (targetPath, pathFormat, format) {
				if (format === 2 && ++rawReads === 2) racedStates[targetPath].raw = descriptorBytes({ ownerSid: FOREIGN_SID });
				return get.call(this, targetPath, pathFormat, format);
			};
			const raceError = captureError(() => runWithDependencies(dependencies));
			expect(raceError.message).toContain('owner changed before mutation');
			expect(raceError.forgeExitCode).toBe(30);
			expect(racedEvents.some(([operation]) => operation === 'set')).toBe(false);
		} finally {
			globalThis.VBArray = originalVBArray;
		}
	});

	test('maps each owner precheck failure to a distinct privacy-safe exit code', () => {
		const originalVBArray = globalThis.VBArray;
		globalThis.VBArray = function (value) { this.toArray = () => value; };
		try {
			const rawStates = {
				'C:\\one': { iid: { Owner: OWNER_SID }, isDirectory: false, raw: descriptorBytes().slice(0, 24) },
			};
			const rawError = captureError(() => runWithDependencies(fakeDependencies(rawStates, [])));
			expect(rawError.forgeExitCode).toBe(22);

			const iidStates = {
				'C:\\one': { iid: {}, isDirectory: false, raw: descriptorBytes() },
			};
			const iidError = captureError(() => runWithDependencies(fakeDependencies(iidStates, [])));
			expect(iidError.forgeExitCode).toBe(23);

			const ownerStates = {
				'C:\\one': { iid: { Owner: FOREIGN_SID }, isDirectory: false, raw: descriptorBytes({ ownerSid: FOREIGN_SID }) },
			};
			const ownerError = captureError(() => runWithDependencies(fakeDependencies(ownerStates, [])));
			expect(ownerError.forgeExitCode).toBe(24);
		} finally {
			globalThis.VBArray = originalVBArray;
		}
	});
});
