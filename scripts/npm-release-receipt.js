#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function requiredString(value, name) {
	if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) {
		throw new Error(`missing:${name}`);
	}
	return value;
}

function createReleaseSuiteReceipt(input) {
	const repository = requiredString(input?.repository, 'repository');
	const workflowRef = requiredString(input?.workflowRef, 'workflowRef');
	const runId = requiredString(input?.runId, 'runId');
	const runAttempt = requiredString(input?.runAttempt, 'runAttempt');
	const sha = requiredString(input?.sha, 'sha');
	const receiptSubject = [
		repository,
		workflowRef,
		runId,
		runAttempt,
		'build',
		sha,
		'release-full',
		'true',
	].join('|');
	const receipt = crypto.createHash('sha256').update(receiptSubject, 'utf8').digest('hex');
	return { receipt, receiptSubject };
}

function verifyReleaseSuiteReceipt(input) {
	const required = [
		'repository',
		'workflowRef',
		'runId',
		'runAttempt',
		'expectedSha',
		'verifiedSha',
		'checkoutSha',
		'receipt',
		'receiptSubject',
	];
	for (const field of required) {
		try {
			requiredString(input?.[field], field);
		} catch (_error) {
			return { allowed: false, reason: `missing:${field}` };
		}
	}

	if (input.expectedSha !== input.verifiedSha || input.expectedSha !== input.checkoutSha) {
		return { allowed: false, reason: 'sha_mismatch' };
	}
	const expected = createReleaseSuiteReceipt({
		repository: input.repository,
		workflowRef: input.workflowRef,
		runId: input.runId,
		runAttempt: input.runAttempt,
		sha: input.expectedSha,
	});
	if (input.receipt !== expected.receipt || input.receiptSubject !== expected.receiptSubject) {
		return { allowed: false, reason: 'receipt_mismatch' };
	}
	return { allowed: true, reason: null };
}

function resolveCheckoutSha() {
	return execFileSync('git', ['rev-parse', 'HEAD'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function attributionFromEnv(env) {
	return {
		repository: env.GITHUB_REPOSITORY,
		workflowRef: env.GITHUB_WORKFLOW_REF,
		runId: env.GITHUB_RUN_ID,
		runAttempt: env.GITHUB_RUN_ATTEMPT,
	};
}

function main(argv = process.argv.slice(2), env = process.env, options = {}) {
	const mode = argv[0];
	const checkoutSha = (options.resolveCheckoutSha || resolveCheckoutSha)();
	const attribution = attributionFromEnv(env);
	if (mode === 'emit') {
		const expectedSha = requiredString(env.EXPECTED_SHA, 'expectedSha');
		if (checkoutSha !== expectedSha) return { success: false, reason: 'sha_mismatch' };
		const outputPath = requiredString(env.GITHUB_OUTPUT, 'githubOutput');
		const evidence = createReleaseSuiteReceipt({ ...attribution, sha: checkoutSha });
		fs.appendFileSync(
			outputPath,
			`commitSha=${checkoutSha}\nreceipt=${evidence.receipt}\nreceiptSubject=${evidence.receiptSubject}\n`,
			'utf8',
		);
		return { success: true, ...evidence, commitSha: checkoutSha };
	}
	if (mode === 'verify') {
		const verification = verifyReleaseSuiteReceipt({
			...attribution,
			expectedSha: env.EXPECTED_SHA,
			verifiedSha: env.VERIFIED_SHA,
			checkoutSha,
			receipt: env.RECEIPT,
			receiptSubject: env.RECEIPT_SUBJECT,
		});
		return { success: verification.allowed, ...verification };
	}
	return { success: false, reason: 'mode_invalid' };
}

if (require.main === module) {
	try {
		const result = main();
		if (!result.success) {
			console.error(`Release suite receipt denied: ${result.reason}`);
			process.exitCode = 1;
		}
	} catch (error) {
		console.error(`Release suite receipt denied: ${error.message}`);
		process.exitCode = 1;
	}
}

module.exports = {
	createReleaseSuiteReceipt,
	verifyReleaseSuiteReceipt,
	main,
};
