'use strict';

/* global ActiveXObject, Enumerator, VBArray, WScript */

// This file is executed by Windows Script Host and loaded by Bun/Node tests.
// Keep its syntax compatible with the system JScript engine.
var ADS_PATH_FILE = 1;
var ADS_SD_FORMAT_IID = 1;
var ADS_SD_FORMAT_RAW = 2;
var ADS_SECURITY_INFO_OWNER = 1;
var ADS_SECURITY_INFO_DACL = 4;
var PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
var SE_DACL_PRESENT = 0x0004;
var SE_DACL_PROTECTED = 0x1000;
var SE_SELF_RELATIVE = 0x8000;
var FILE_ALL_ACCESS = 0x001f01ff;
var ACCESS_ALLOWED_ACE_TYPE = 0;
var OBJECT_INHERIT_ACE = 1;
var CONTAINER_INHERIT_ACE = 2;
var MAX_TARGETS = 128;

function invariant(condition, message) {
	if (!condition) throw new Error(message);
}

function atStage(code, action) {
	try {
		return action();
	} catch (error) {
		error.forgeExitCode = code;
		throw error;
	}
}

function bytesFromSafeArray(value) {
	var values = new VBArray(value).toArray();
	var bytes = [];
	for (var i = 0; i < values.length; i++) bytes.push(values[i] & 0xff);
	return bytes;
}

function u16(bytes, offset) {
	invariant(offset >= 0 && offset + 2 <= bytes.length, 'truncated uint16');
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes, offset) {
	invariant(offset >= 0 && offset + 4 <= bytes.length, 'truncated uint32');
	return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function sidAt(bytes, offset) {
	invariant(offset > 0 && offset + 8 <= bytes.length, 'missing SID');
	var revision = bytes[offset];
	var count = bytes[offset + 1];
	var end = offset + 8 + (count * 4);
	invariant(revision === 1 && end <= bytes.length, 'malformed SID');
	var authority = 0;
	for (var i = 0; i < 6; i++) authority = (authority * 256) + bytes[offset + 2 + i];
	invariant(authority <= 9007199254740991, 'unsupported SID authority');
	var parts = ['S', String(revision), String(authority)];
	for (var j = 0; j < count; j++) parts.push(String(u32(bytes, offset + 8 + (j * 4))));
	return { end: end, value: parts.join('-') };
}

function inspectDescriptor(bytes, expectedOwnerSid, expectedAceFlags) {
	invariant(bytes && typeof bytes.length === 'number' && bytes.length >= 20, 'malformed security descriptor');
	invariant(/^S-1-[0-9]+(?:-[0-9]+)+$/.test(expectedOwnerSid), 'invalid expected SID');
	invariant(bytes[0] === 1, 'unsupported security descriptor revision');
	var control = u16(bytes, 2);
	invariant((control & SE_SELF_RELATIVE) !== 0, 'security descriptor is not self-relative');
	invariant((control & SE_DACL_PRESENT) !== 0, 'DACL is absent');
	invariant((control & SE_DACL_PROTECTED) !== 0, 'DACL is not protected');
	var owner = sidAt(bytes, u32(bytes, 4));
	invariant(owner.value === expectedOwnerSid, 'owner changed');
	var daclOffset = u32(bytes, 16);
	invariant(daclOffset > 0 && daclOffset + 8 <= bytes.length, 'DACL is malformed');
	var aclRevision = bytes[daclOffset];
	var aclSize = u16(bytes, daclOffset + 2);
	var aceCount = u16(bytes, daclOffset + 4);
	invariant(aclRevision === 2, 'unsupported ACL revision');
	invariant(aclSize >= 8 && daclOffset + aclSize <= bytes.length, 'ACL size is malformed');
	invariant(aceCount === 1, 'DACL must contain one ACE');
	var aceOffset = daclOffset + 8;
	invariant(aceOffset + 8 <= daclOffset + aclSize, 'ACE is truncated');
	var aceType = bytes[aceOffset];
	var aceFlags = bytes[aceOffset + 1];
	var aceSize = u16(bytes, aceOffset + 2);
	invariant(aceType === ACCESS_ALLOWED_ACE_TYPE, 'ACE must allow access');
	invariant(aceFlags === expectedAceFlags, 'ACE flags are not exact');
	invariant(aceSize >= 16 && aceOffset + aceSize === daclOffset + aclSize, 'ACE size is not exact');
	invariant(u32(bytes, aceOffset + 4) === FILE_ALL_ACCESS, 'ACE is not full control');
	var trustee = sidAt(bytes, aceOffset + 8);
	invariant(trustee.value === expectedOwnerSid, 'ACE trustee is not the owner');
	invariant(trustee.end === aceOffset + aceSize, 'ACE contains trailing data');
	return { aceFlags: aceFlags, ownerSid: owner.value };
}

function inspectIidDescriptor(descriptor, expectedOwner, expectedAceFlags, enumeratorFactory) {
	invariant(descriptor && descriptor.Owner, 'IID owner is absent');
	if (expectedOwner !== null) invariant(String(descriptor.Owner) === expectedOwner, 'IID owner changed');
	invariant((descriptor.Control & SE_DACL_PRESENT) !== 0, 'IID DACL is absent');
	invariant((descriptor.Control & SE_DACL_PROTECTED) !== 0, 'IID DACL is not protected');
	var dacl = descriptor.DiscretionaryAcl;
	invariant(dacl && dacl.AceCount === 1, 'IID DACL must contain one ACE');
	var entries = enumeratorFactory ? enumeratorFactory(dacl) : new Enumerator(dacl);
	invariant(!entries.atEnd(), 'IID ACE is absent');
	var ace = entries.item();
	invariant(ace.AceType === ACCESS_ALLOWED_ACE_TYPE, 'IID ACE must allow access');
	invariant((ace.AccessMask >>> 0) === FILE_ALL_ACCESS, 'IID ACE is not full control');
	invariant(ace.AceFlags === expectedAceFlags, 'IID ACE flags are not exact');
	entries.moveNext();
	invariant(entries.atEnd(), 'IID DACL contains extra ACEs');
}

function rawDescriptor(utility, targetPath) {
	utility.SecurityMask = ADS_SECURITY_INFO_OWNER | ADS_SECURITY_INFO_DACL;
	return bytesFromSafeArray(utility.GetSecurityDescriptor(targetPath, ADS_PATH_FILE, ADS_SD_FORMAT_RAW));
}

function iidDescriptor(utility, targetPath) {
	utility.SecurityMask = ADS_SECURITY_INFO_OWNER | ADS_SECURITY_INFO_DACL;
	return utility.GetSecurityDescriptor(targetPath, ADS_PATH_FILE, ADS_SD_FORMAT_IID);
}

function ownerSid(bytes) {
	invariant(bytes && typeof bytes.length === 'number' && bytes.length >= 20, 'malformed security descriptor');
	invariant(bytes[0] === 1, 'unsupported security descriptor revision');
	invariant((u16(bytes, 2) & SE_SELF_RELATIVE) !== 0, 'security descriptor is not self-relative');
	return sidAt(bytes, u32(bytes, 4)).value;
}

function readTargets(environment, fso) {
	var countText = String(environment('FORGE_PRIVATE_ACL_COUNT'));
	invariant(/^[1-9][0-9]*$/.test(countText), 'invalid target count');
	var count = Number(countText);
	invariant(count <= MAX_TARGETS, 'too many ACL targets');
	var targets = [];
	for (var i = 0; i < count; i++) {
		var targetPath = String(environment('FORGE_PRIVATE_ACL_TARGET_' + i));
		invariant(targetPath.length > 0 && targetPath.indexOf('\0') === -1, 'invalid ACL target');
		var isDirectory = fso.FolderExists(targetPath);
		var isFile = fso.FileExists(targetPath);
		invariant(isDirectory !== isFile, 'ACL target does not exist');
		targets.push({ isDirectory: isDirectory, path: targetPath });
	}
	return targets;
}

function applyOwnerOnlyDacl(utility, target, currentSid, createObject, descriptor) {
	var dacl = createObject('AccessControlList');
	dacl.AclRevision = 2;
	var ace = createObject('AccessControlEntry');
	ace.Trustee = currentSid;
	ace.AccessMask = FILE_ALL_ACCESS;
	ace.AceType = ACCESS_ALLOWED_ACE_TYPE;
	ace.AceFlags = target.isDirectory ? (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) : 0;
	dacl.AddAce(ace);
	descriptor.Owner = currentSid;
	descriptor.DiscretionaryAcl = dacl;
	descriptor.Control = descriptor.Control | SE_DACL_PRESENT | SE_DACL_PROTECTED;
	utility.SecurityMask = ADS_SECURITY_INFO_OWNER | ADS_SECURITY_INFO_DACL | PROTECTED_DACL_SECURITY_INFORMATION;
	utility.SetSecurityDescriptor(target.path, ADS_PATH_FILE, descriptor, ADS_SD_FORMAT_IID);
}

function runWithDependencies(dependencies) {
	var environment = dependencies.environment;
	var fso = dependencies.fso;
	var utility = dependencies.utility;
	var createObject = dependencies.createObject;
	var enumeratorFactory = dependencies.enumeratorFactory;
	var currentSid = String(environment('FORGE_PRIVATE_ACL_SID'));
	invariant(/^S-1-[0-9]+(?:-[0-9]+)+$/.test(currentSid), 'invalid current SID');
	var targets = readTargets(environment, fso);
	var owners = [];
	var iidOwners = [];
	var i;

	// Prove every target and descriptor are readable before the first mutation.
	for (i = 0; i < targets.length; i++) {
		var beforeRaw = atStage(20, function () { return rawDescriptor(utility, targets[i].path); });
		var beforeIid = atStage(21, function () { return iidDescriptor(utility, targets[i].path); });
		owners.push(atStage(22, function () { return ownerSid(beforeRaw); }));
		iidOwners.push(atStage(23, function () {
			invariant(beforeIid && beforeIid.Owner, 'precheck IID owner is absent');
			return String(beforeIid.Owner);
		}));
	}

	for (i = 0; i < targets.length; i++) {
		// Recheck immediately before changing the owner and DACL together.
		var currentIid = atStage(30, function () {
			var isDirectory = fso.FolderExists(targets[i].path);
			var isFile = fso.FileExists(targets[i].path);
			invariant(isDirectory === targets[i].isDirectory && isFile !== isDirectory, 'target type changed before mutation');
			invariant(ownerSid(rawDescriptor(utility, targets[i].path)) === owners[i], 'owner changed before mutation');
			var descriptor = iidDescriptor(utility, targets[i].path);
			invariant(descriptor && descriptor.Owner, 'IID owner is absent before mutation');
			invariant(String(descriptor.Owner) === iidOwners[i], 'IID owner changed before mutation');
			return descriptor;
		});
		atStage(31, function () { applyOwnerOnlyDacl(utility, targets[i], currentSid, createObject, currentIid); });
		var expectedFlags = targets[i].isDirectory ? (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) : 0;
		atStage(32, function () {
			inspectDescriptor(rawDescriptor(utility, targets[i].path), currentSid, expectedFlags);
		});
		atStage(33, function () {
			inspectIidDescriptor(iidDescriptor(utility, targets[i].path), null, expectedFlags, enumeratorFactory);
		});
	}
	return true;
}

function main() {
	try {
		var shell = new ActiveXObject('WScript.Shell');
		runWithDependencies({
			createObject: function (name) { return new ActiveXObject(name); },
			environment: shell.Environment('PROCESS'),
			fso: new ActiveXObject('Scripting.FileSystemObject'),
			utility: new ActiveXObject('ADsSecurityUtility')
		});
		WScript.Quit(0);
	} catch (_error) {
		var exitCode = _error && typeof _error.forgeExitCode === 'number' ? _error.forgeExitCode : 1;
		WScript.Quit(exitCode);
	}
}

if (typeof module !== 'undefined' && module.exports) {
	module.exports = {
		FILE_ALL_ACCESS: FILE_ALL_ACCESS,
		inspectDescriptor: inspectDescriptor,
		inspectIidDescriptor: inspectIidDescriptor,
		runWithDependencies: runWithDependencies
	};
} else {
	main();
}
