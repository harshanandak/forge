'use strict';

const { afterEach, beforeEach, describe, expect, mock, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const contracts = require('../../packages/memory-contracts');
mock.module('@forge/memory-contracts', () => contracts);
const { computeContentHash } = contracts;
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

const HEAD_SHA = 'a'.repeat(40);
const RISK_DIGEST = 'b'.repeat(64);
const MANIFEST_DIGEST = 'c'.repeat(64);
const GATE_ID = 'gate.merge';
const GATE_RECEIPT = 'gate.approved:issue-trace:gate.merge:maintainer';

function rehash(envelope) {
	const copy = structuredClone(envelope);
	copy.content_hash = computeContentHash(copy);
	return copy;
}

function workPacket(overrides = {}) {
	return rehash({
		schema_id: 'forge.memory.work-packet.v1',
		schema_version: 1,
		object_id: '10000000-0000-4000-8000-000000000001',
		created_at: '2026-08-11T00:00:00.000Z',
		producer: { product_id: 'forge-memory', product_version: '0.1.0', instance_id: 'memory-1' },
		capabilities_used: [],
		provenance: { source_kind: 'kernel', actor_class: 'system', actor_id: 'memory-1' },
		content_hash: '0'.repeat(64),
		payload: {
			issue_id: 'issue-trace',
			expected_issue_revision: 0,
			packet_id: 'packet-trace',
			packet_revision: 1,
			repository_id: 'owner/forge',
			target_head: HEAD_SHA,
			objective: 'record receipt-bound PR trace',
			authority: { kind: 'kernel', issue_revision: 0 },
			allowed_mutations: ['pr.opened', 'pr.merged'],
			workflow_config_revision: 'workflow-1',
			capability_manifest_digest: MANIFEST_DIGEST,
			risk_manifest_digest: RISK_DIGEST,
			receipt_requirements: { gate_ids: [GATE_ID] },
			...overrides,
		},
		extensions: {},
	});
}

function runReceipt(packet, overrides = {}, phase = 'opened') {
	return rehash({
		schema_id: 'forge.memory.run-receipt.v1',
		schema_version: 1,
		object_id: '10000000-0000-4000-8000-000000000002',
		created_at: '2026-08-11T00:05:00.000Z',
		producer: { product_id: 'forge-flow', product_version: '0.1.0', instance_id: 'flow-1' },
		capabilities_used: [],
		provenance: { source_kind: 'flow-boundary', actor_class: 'system', actor_id: 'flow-1' },
		content_hash: '0'.repeat(64),
		payload: {
			packet_hash: packet.content_hash,
			run_id: 'run-trace',
			attempt_id: 'attempt-trace',
			exact_head: packet.payload.target_head,
			packet_revision: packet.payload.packet_revision,
			manifest_digest: packet.payload.capability_manifest_digest,
			workflow_config_revision: packet.payload.workflow_config_revision,
			status: 'PASS',
			executor: { product_id: 'forge-flow', mode: 'test' },
			started_at: '2026-08-11T00:01:00.000Z',
			ended_at: '2026-08-11T00:05:00.000Z',
			evidence_refs: [{ kind: 'validation', id: 'validation-1' }],
			validation: { status: 'PASS' },
			cleanup: { status: 'PASS' },
			mutations_attempted: [`pr.${phase}`],
			mutations_authorized: [`pr.${phase}`],
			...overrides,
		},
		extensions: {},
	});
}

describe('Kernel receipt-bound PR trace', () => {
	let root;
	let driver;
	let broker;
	let config;
	let gitCommonDir;
	let branch;
	let workFolder;

	beforeEach(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-'));
		gitCommonDir = path.join(root, '.git');
		branch = 'codex/trace';
		workFolder = 'docs/work/2026-08-11-trace';
		fs.mkdirSync(gitCommonDir, { recursive: true });
		config = { databasePath: path.join(root, 'kernel.sqlite') };
		driver = createBuiltinSQLiteDriver({ databasePath: config.databasePath });
		broker = createLocalBroker({ projectRoot: root, gitCommonDir, databasePath: config.databasePath, driver });
		await broker.initialize();
		await driver.exec(
			"INSERT INTO kernel_issues (id, title, created_at, updated_at) VALUES ('issue-trace', 'Trace', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');",
			config,
		);
		driver.registerWorktree({
			id: 'worktree-trace',
			git_common_dir: gitCommonDir,
			path: path.join(root, '.worktrees', 'trace'),
			branch,
			issue_id: 'issue-trace',
			work_folder: workFolder,
			registered_at: '2026-08-11T00:00:00.000Z',
		}, config);
		for (const [filename, content] of [['plan.md', '# Plan\n'], ['tasks.md', '# Tasks\n'], ['decisions.md', '# Decisions\n']]) {
			const filenamePath = path.join(root, workFolder, filename);
			fs.mkdirSync(path.dirname(filenamePath), { recursive: true });
			fs.writeFileSync(filenamePath, content, 'utf8');
		}
		await driver.insertKernelEvent({
			entity_type: 'issue',
			entity_id: 'issue-trace',
			event_type: 'gate.approved',
			idempotency_key: GATE_RECEIPT,
			expected_revision: 0,
			actor: 'maintainer',
			origin: 'test',
			payload: { gate: GATE_ID, expires_at: null, generation: 0 },
			created_at: '2026-08-11T00:04:00.000Z',
		}, {}, config);
	});

	afterEach(() => {
		driver?.close();
		try {
			fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		} catch {
			// Bun can release a Windows SQLite handle just after close; cleanup is best effort.
		}
	});

	function linkage(phase = 'opened', packet = workPacket(), receipt = runReceipt(packet, {}, phase), overrides = {}) {
		return {
			phase,
			git_common_dir: gitCommonDir,
			repo: 'owner/forge',
			number: 514,
			url: 'https://github.com/owner/forge/pull/514',
			branch,
			work_packet: packet,
			run_receipt: receipt,
			occurred_at: phase === 'opened' ? '2026-08-11T00:06:00.000Z' : '2026-08-11T00:07:00.000Z',
			...overrides,
		};
	}

	test('derives every authority binding, replays exactly, and returns the joined trace', async () => {
		const packet = workPacket();
		const openedReceipt = runReceipt(packet);
		const mergedReceipt = runReceipt(packet, {}, 'merged');
		await broker.recordPrLinkage(linkage('opened', packet, openedReceipt));
		await broker.recordPrLinkage(linkage('opened', packet, openedReceipt));
		await broker.recordPrLinkage(linkage('merged', packet, mergedReceipt));
		await broker.recordPrLinkage(linkage('merged', packet, mergedReceipt));
		await broker.recordPrLinkage(linkage('opened', packet, openedReceipt));

		const trace = await broker.readTrace({ issue_id: 'issue-trace' });
		expect(trace).toMatchObject({
			schema_version: 'forge.trace.v1',
			target: { kind: 'issue', id: 'issue-trace' },
			work_folder: workFolder,
			gaps: [],
		});
		expect(trace.artifacts).toEqual({
			plan: { path: `${workFolder}/plan.md`, content: '# Plan\n' },
			tasks: { path: `${workFolder}/tasks.md`, content: '# Tasks\n' },
			decisions: { path: `${workFolder}/decisions.md`, content: '# Decisions\n' },
		});
		expect(trace.pull_requests).toHaveLength(1);
		expect(trace.pull_requests[0]).toMatchObject({ state: 'merged', head_sha: HEAD_SHA, issue_id: 'issue-trace', worktree_id: 'worktree-trace' });
		expect(trace.pull_requests[0].iterations.map(event => event.type)).toEqual(['pr.opened', 'pr.merged']);
		expect(trace.pull_requests[0].iterations[0]).toMatchObject({
			issue_revision: 0,
			head_sha: HEAD_SHA,
			work_packet_hash: packet.content_hash,
			run_receipt_hash: openedReceipt.content_hash,
			risk_manifest_digest: RISK_DIGEST,
			gate_receipts: [GATE_RECEIPT],
		});
		expect(await driver.queryAll("SELECT COUNT(*) AS n FROM kernel_events WHERE entity_type = 'pr';", config)).toEqual([{ n: 2 }]);
	});

	test('atomically rejects divergent opened evidence across independent brokers', async () => {
		const secondDriver = createBuiltinSQLiteDriver({ databasePath: config.databasePath });
		const secondBroker = createLocalBroker({ projectRoot: root, gitCommonDir, databasePath: config.databasePath, driver: secondDriver });
		await secondBroker.initialize();
		try {
			const firstPacket = workPacket();
			const secondPacket = rehash({ ...structuredClone(firstPacket), object_id: '10000000-0000-4000-8000-000000000099' });
			const first = linkage('opened', firstPacket, runReceipt(firstPacket));
			const second = linkage('opened', secondPacket, runReceipt(secondPacket), { number: 515, url: 'https://github.com/owner/forge/pull/515' });
			const results = await Promise.allSettled([broker.recordPrLinkage(first), secondBroker.recordPrLinkage(second)]);
			expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
			const rejected = results.find(result => result.status === 'rejected');
			expect(rejected.reason).toMatchObject({ code: 'FORGE_TRACE_EVIDENCE_CONFLICT' });
			const rows = await driver.queryAll("SELECT COUNT(*) AS n FROM kernel_events WHERE event_type = 'pr.opened';", config);
			expect(rows).toEqual([{ n: 1 }]);
		} finally {
			secondDriver.close();
		}
	});

	test('serializes same-driver linkage turns and releases the queue after failure', async () => {
		const invalidPacket = workPacket({ target_head: 'f'.repeat(40) });
		const invalid = linkage('opened', invalidPacket, runReceipt(invalidPacket, { exact_head: HEAD_SHA }));
		const first = broker.recordPrLinkage(invalid).then(() => null, error => error);
		const second = broker.recordPrLinkage(linkage());
		await expect(first).resolves.toBeInstanceOf(Error);
		await expect(second).resolves.toHaveProperty('iteration');
		await expect(broker.recordPrLinkage(linkage())).resolves.toHaveProperty('iteration');
	});

	test('fails closed before linkage work when isolation is unavailable', async () => {
		const originalFork = driver.forkConnection;
		let calls = 0;
		const originalResolve = driver.resolvePrLinkage;
		driver.resolvePrLinkage = async (...args) => { calls += 1; return originalResolve(...args); };
		driver.forkConnection = undefined;
		await expect(broker.recordPrLinkage(linkage())).rejects.toMatchObject({ code: 'FORGE_TRACE_UNAVAILABLE' });
		driver.forkConnection = () => { throw new Error('fork unavailable'); };
		await expect(broker.recordPrLinkage(linkage())).rejects.toMatchObject({ code: 'FORGE_TRACE_UNAVAILABLE' });
		expect(calls).toBe(0);
		driver.forkConnection = originalFork;
		driver.resolvePrLinkage = originalResolve;
	});

	test('always closes the isolated linkage connection on success and error', async () => {
		const originalFork = driver.forkConnection;
		let closes = 0;
		driver.forkConnection = () => {
			const fork = originalFork.call(driver);
			const close = fork.close;
			fork.close = () => { closes += 1; close.call(fork); };
			return fork;
		};
		await broker.recordPrLinkage(linkage());
		await expect(broker.recordOpenedPrLinkage(linkage(), { actor: 'agent-1', sessionId: 'session-1' }))
			.rejects.toBeInstanceOf(Error);
		expect(closes).toBe(2);
		driver.forkConnection = originalFork;
	});

	test('revalidates exact claim ownership inside opened linkage persistence', async () => {
		await driver.insertKernelClaim({ id: 'claim-1', issue_id: 'issue-trace', actor: 'agent-1', session_id: 'session-1',
			state: 'active', claimed_at: '2026-08-11T00:00:00.000Z', expires_at: '2026-08-11T01:00:00.000Z' }, {}, config);
		const context = { actor: 'agent-1', sessionId: 'session-1', now: '2026-08-11T00:10:00.000Z' };
		await expect(broker.recordOpenedPrLinkage(linkage(), context)).resolves.toHaveProperty('iteration');
		await driver.updateKernelClaimState('claim-1', 'released', {}, config);
		await expect(broker.recordOpenedPrLinkage(linkage(), context)).rejects.toMatchObject({ code: 'FORGE_TRACE_EVIDENCE_CONFLICT' });
		await driver.insertKernelClaim({ id: 'claim-2', issue_id: 'issue-trace', actor: 'agent-2', session_id: 'session-2',
			state: 'active', claimed_at: '2026-08-11T00:11:00.000Z', expires_at: '2026-08-11T00:12:00.000Z' }, {}, config);
		await expect(broker.recordOpenedPrLinkage(linkage(), context)).rejects.toMatchObject({ code: 'FORGE_TRACE_EVIDENCE_CONFLICT' });
		await expect(broker.recordOpenedPrLinkage(linkage(), { actor: 'agent-2', sessionId: 'session-2', now: '2026-08-11T00:13:00.000Z' }))
			.rejects.toMatchObject({ code: 'FORGE_TRACE_EVIDENCE_CONFLICT' });
	});

	test('rejects a foreign issue PR binding inside the linkage transaction', async () => {
		await driver.exec("INSERT INTO kernel_issues (id, title, created_at, updated_at) VALUES ('issue-other', 'Other', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');", config);
		await driver.upsertPr({ id: 'foreign-pr', git_common_dir: gitCommonDir, repo: 'owner/forge', number: 514,
			issue_id: 'issue-other', worktree_id: 'worktree-other', branch, head_sha: 'f'.repeat(40) }, {}, config);
		await expect(broker.recordPrLinkage(linkage())).rejects.toMatchObject({ code: 'FORGE_TRACE_EVIDENCE_CONFLICT' });
		const rows = await driver.queryAll('SELECT issue_id, head_sha FROM kernel_pr WHERE id = \'foreign-pr\';', config);
		expect(rows).toEqual([{ issue_id: 'issue-other', head_sha: 'f'.repeat(40) }]);
	});

	test('accepts producer-canonical hashes with mixed-case receipt keys', async () => {
		const packet = workPacket({ constraints: { Z: 'upper', a: 'lower' } });
		const receipt = runReceipt(packet);

		await broker.recordPrLinkage(linkage('opened', packet, receipt));

		const trace = await broker.readTrace({ issue_id: 'issue-trace' });
		expect(trace.pull_requests[0].iterations[0]).toMatchObject({
			work_packet_hash: packet.content_hash,
			run_receipt_hash: receipt.content_hash,
		});
	});

	test('fails closed on stale, non-PASS, mismatched, or inactive receipt authority before writes', async () => {
		const stale = workPacket({ expected_issue_revision: 1, authority: { kind: 'kernel', issue_revision: 1 } });
		await expect(broker.recordPrLinkage(linkage('opened', stale, runReceipt(stale)))).rejects.toMatchObject({ code: 'FORGE_TRACE_STALE_AUTHORITY' });

		const packet = workPacket();
		await expect(broker.recordPrLinkage(linkage('opened', packet, runReceipt(packet, { status: 'INCOMPLETE', validation: { status: 'INCOMPLETE' } }))))
			.rejects.toMatchObject({ code: 'FORGE_TRACE_INVALID_RECEIPT' });
		await expect(broker.recordPrLinkage(linkage('opened', packet, runReceipt(packet, { exact_head: 'd'.repeat(40) }))))
			.rejects.toMatchObject({ code: 'FORGE_TRACE_EVIDENCE_CONFLICT' });

		await driver.insertKernelEvent({
			entity_type: 'issue', entity_id: 'issue-trace', event_type: 'gate.rejected',
			idempotency_key: 'gate.rejected:issue-trace:gate.merge:maintainer', expected_revision: 0,
			actor: 'maintainer', origin: 'test', payload: { gate: GATE_ID, expires_at: null, generation: 1 },
			created_at: '2026-08-11T00:05:00.000Z',
		}, {}, config);
		await expect(broker.recordPrLinkage(linkage('opened', packet, runReceipt(packet))))
			.rejects.toMatchObject({ code: 'FORGE_TRACE_GATE_UNAVAILABLE' });
		expect(await driver.queryAll('SELECT * FROM kernel_pr;', config)).toEqual([]);
		expect(await driver.queryAll("SELECT * FROM kernel_events WHERE entity_type = 'pr';", config)).toEqual([]);
	});

	test('rejects omitted or invalid WorkPacket bindings before writes', async () => {
		function omitMatchingBinding(packetField, receiptField) {
			let packet = workPacket();
			delete packet.payload[packetField];
			packet = rehash(packet);
			let receipt = runReceipt(workPacket());
			receipt.payload.packet_hash = packet.content_hash;
			delete receipt.payload[receiptField];
			return { packet, receipt: rehash(receipt) };
		}

		const invalid = [
			(() => { const packet = workPacket({ packet_revision: -1 }); return { packet, receipt: runReceipt(packet) }; })(),
			(() => { const packet = workPacket({ packet_revision: Number.MAX_SAFE_INTEGER + 1 }); return { packet, receipt: runReceipt(packet) }; })(),
			(() => { const packet = workPacket({ capability_manifest_digest: 'not-a-sha256' }); return { packet, receipt: runReceipt(packet) }; })(),
			(() => { const packet = workPacket({ workflow_config_revision: '' }); return { packet, receipt: runReceipt(packet) }; })(),
			omitMatchingBinding('packet_revision', 'packet_revision'),
			omitMatchingBinding('capability_manifest_digest', 'manifest_digest'),
			omitMatchingBinding('workflow_config_revision', 'workflow_config_revision'),
		];

		for (const { packet, receipt } of invalid) {
			await expect(broker.recordPrLinkage(linkage('opened', packet, receipt)))
				.rejects.toMatchObject({ code: 'FORGE_TRACE_INVALID_RECEIPT' });
		}
		expect(await driver.queryAll('SELECT * FROM kernel_pr;', config)).toEqual([]);
		expect(await driver.queryAll("SELECT * FROM kernel_events WHERE entity_type = 'pr';", config)).toEqual([]);
	});

	test('rejects missing or non-string packet identity before writes', async () => {
		for (const packetId of [undefined, { forged: true }]) {
			let packet = workPacket();
			if (packetId === undefined) delete packet.payload.packet_id;
			else packet.payload.packet_id = packetId;
			packet = rehash(packet);
			await expect(broker.recordPrLinkage(linkage('opened', packet, runReceipt(packet))))
				.rejects.toMatchObject({ code: 'FORGE_TRACE_INVALID_RECEIPT' });
		}
		expect(await driver.queryAll('SELECT * FROM kernel_pr;', config)).toEqual([]);
	});

	test('rejects a hash-valid zero packet revision before writes', async () => {
		const packet = workPacket({ packet_revision: 0 });

		await expect(broker.recordPrLinkage(linkage('opened', packet, runReceipt(packet))))
			.rejects.toMatchObject({ code: 'FORGE_TRACE_INVALID_RECEIPT' });
		expect(await driver.queryAll('SELECT * FROM kernel_pr;', config)).toEqual([]);
		expect(await driver.queryAll("SELECT * FROM kernel_events WHERE entity_type = 'pr';", config)).toEqual([]);
	});

	test('binds hash-valid WorkPacket repository authority to the normalized linkage repository', async () => {
		const crossRepoPacket = workPacket({ repository_id: 'owner/repository-a' });
		await expect(broker.recordPrLinkage(linkage('opened', crossRepoPacket, runReceipt(crossRepoPacket), {
			repo: 'owner/repository-b',
		}))).rejects.toMatchObject({ code: 'FORGE_TRACE_EVIDENCE_CONFLICT' });
		expect(await driver.queryAll('SELECT * FROM kernel_pr;', config)).toEqual([]);
		expect(await driver.queryAll("SELECT * FROM kernel_events WHERE entity_type = 'pr';", config)).toEqual([]);

		const packet = workPacket();
		await broker.recordPrLinkage(linkage('opened', packet, runReceipt(packet), {
			repo: ' Owner/Forge ',
		}));
		expect(await driver.queryAll('SELECT repo FROM kernel_pr;', config)).toEqual([{ repo: 'owner/forge' }]);
	});

	test('resolves gate authority historically at the linkage occurrence time', async () => {
		await driver.insertKernelEvent({
			entity_type: 'issue', entity_id: 'issue-trace', event_type: 'gate.rejected',
			idempotency_key: 'gate.rejected:issue-trace:gate.merge:future', expected_revision: 0,
			actor: 'maintainer', origin: 'test', payload: { gate: GATE_ID, expires_at: null, generation: 1 },
			created_at: '2026-08-11T00:08:00.000Z',
		}, {}, config);

		await broker.recordPrLinkage(linkage());

		const trace = await broker.readTrace({ issue_id: 'issue-trace' });
		expect(trace.pull_requests[0].iterations[0].gate_receipts).toEqual([GATE_RECEIPT]);
	});

	test('selects the newest eligible gate event independent of returned row order', async () => {
		const renewedReceipt = 'gate.approved:issue-trace:gate.merge:newest';
		await driver.insertKernelEvent({
			entity_type: 'issue', entity_id: 'issue-trace', event_type: 'gate.rejected',
			idempotency_key: 'gate.rejected:issue-trace:gate.merge:older', expected_revision: 0,
			actor: 'maintainer', origin: 'test', payload: { gate: GATE_ID, expires_at: null, generation: 1 },
			created_at: '2026-08-11T00:05:00.000Z',
		}, {}, config);
		await driver.insertKernelEvent({
			entity_type: 'issue', entity_id: 'issue-trace', event_type: 'gate.approved',
			idempotency_key: renewedReceipt, expected_revision: 0,
			actor: 'maintainer', origin: 'test', payload: { gate: GATE_ID, expires_at: null, generation: 2 },
			created_at: '2026-08-11T00:05:30.000Z',
		}, {}, config);
		const listKernelEvents = driver.listKernelEvents.bind(driver);
		driver.listKernelEvents = async (...args) => (await listKernelEvents(...args)).reverse();

		await broker.recordPrLinkage(linkage());

		const trace = await broker.readTrace({ issue_id: 'issue-trace' });
		expect(trace.pull_requests[0].iterations[0].gate_receipts).toEqual([renewedReceipt]);
	});

	test('uses stable driver order to break equal-time gate event ties', async () => {
		const renewedReceipt = 'gate.approved:issue-trace:gate.merge:equal-time';
		await driver.insertKernelEvent({
			entity_type: 'issue', entity_id: 'issue-trace', event_type: 'gate.rejected',
			idempotency_key: 'gate.rejected:issue-trace:gate.merge:equal-time', expected_revision: 0,
			actor: 'maintainer', origin: 'test', payload: { gate: GATE_ID, expires_at: null, generation: 1 },
			created_at: '2026-08-11T00:05:00.000Z',
		}, {}, config);
		await driver.insertKernelEvent({
			entity_type: 'issue', entity_id: 'issue-trace', event_type: 'gate.approved',
			idempotency_key: renewedReceipt, expected_revision: 0,
			actor: 'maintainer', origin: 'test', payload: { gate: GATE_ID, expires_at: null, generation: 2 },
			created_at: '2026-08-11T00:05:00.000Z',
		}, {}, config);

		await broker.recordPrLinkage(linkage());

		const trace = await broker.readTrace({ issue_id: 'issue-trace' });
		expect(trace.pull_requests[0].iterations[0].gate_receipts).toEqual([renewedReceipt]);
	});

	test('keeps an exact T1 replay idempotent after T2 rejection and renewed approval', async () => {
		const packet = workPacket();
		const opened = linkage('opened', packet, runReceipt(packet));
		await broker.recordPrLinkage(opened);

		await driver.insertKernelEvent({
			entity_type: 'issue', entity_id: 'issue-trace', event_type: 'gate.rejected',
			idempotency_key: 'gate.rejected:issue-trace:gate.merge:t2', expected_revision: 0,
			actor: 'maintainer', origin: 'test', payload: { gate: GATE_ID, expires_at: null, generation: 1 },
			created_at: '2026-08-11T00:10:00.000Z',
		}, {}, config);
		await broker.recordPrLinkage(opened);

		const renewedReceipt = 'gate.approved:issue-trace:gate.merge:renewed';
		await driver.insertKernelEvent({
			entity_type: 'issue', entity_id: 'issue-trace', event_type: 'gate.approved',
			idempotency_key: renewedReceipt, expected_revision: 0,
			actor: 'maintainer', origin: 'test', payload: { gate: GATE_ID, expires_at: null, generation: 2 },
			created_at: '2026-08-11T00:10:01.000Z',
		}, {}, config);
		await broker.recordPrLinkage(opened);
		await broker.recordPrLinkage(linkage('merged', packet, runReceipt(packet, {}, 'merged'), {
			occurred_at: '2026-08-11T00:10:02.000Z',
		}));

		const trace = await broker.readTrace({ issue_id: 'issue-trace' });
		expect(trace.pull_requests[0].iterations.map(iteration => iteration.gate_receipts)).toEqual([
			[GATE_RECEIPT],
			[renewedReceipt],
		]);
		expect(await driver.queryAll("SELECT COUNT(*) AS n FROM kernel_events WHERE entity_type = 'pr';", config)).toEqual([{ n: 2 }]);
	});

	test('snapshots caller input before the first asynchronous driver boundary', async () => {
		const input = linkage();
		const resolvePrLinkage = driver.resolvePrLinkage;
		driver.resolvePrLinkage = async (...args) => {
			const result = await resolvePrLinkage(...args);
			input.branch = 'codex/mutated-after-validation';
			return result;
		};

		await broker.recordPrLinkage(input);

		expect(await driver.queryAll('SELECT branch FROM kernel_pr;', config)).toEqual([{ branch }]);
	});

	test('requires the RunReceipt to attempt and authorize the exact linkage phase', async () => {
		const packet = workPacket();
		await expect(broker.recordPrLinkage(linkage('opened', packet, runReceipt(packet, {
			mutations_attempted: ['pr.merged'],
			mutations_authorized: ['pr.merged'],
		})))).rejects.toMatchObject({ code: 'FORGE_TRACE_INVALID_RECEIPT' });
		await expect(broker.recordPrLinkage(linkage('opened', packet, runReceipt(packet, {
			mutations_attempted: [],
		})))).rejects.toMatchObject({ code: 'FORGE_TRACE_INVALID_RECEIPT' });
		await expect(broker.recordPrLinkage(linkage('opened', packet, runReceipt(packet, {
			mutations_authorized: [],
		})))).rejects.toMatchObject({ code: 'FORGE_TRACE_INVALID_RECEIPT' });
		expect(await driver.queryAll('SELECT * FROM kernel_pr;', config)).toEqual([]);
		expect(await driver.queryAll("SELECT * FROM kernel_events WHERE entity_type = 'pr';", config)).toEqual([]);
	});

	test('rejects missing, inactive, or mismatched explicit worktree bindings before persistence', async () => {
		const packet = workPacket();
		await expect(broker.recordPrLinkage(linkage('opened', packet, runReceipt(packet), {
			worktree_id: 'worktree-missing',
		}))).rejects.toMatchObject({ code: 'FORGE_TRACE_EVIDENCE_CONFLICT' });

		driver.registerWorktree({
			id: 'worktree-mismatch',
			git_common_dir: path.join(root, '.git-other'),
			path: path.join(root, '.worktrees', 'other'),
			branch: 'codex/other',
			issue_id: 'issue-trace',
			registered_at: '2026-08-11T00:01:00.000Z',
		}, config);
		await expect(broker.recordPrLinkage(linkage('opened', packet, runReceipt(packet), {
			worktree_id: 'worktree-mismatch',
		}))).rejects.toMatchObject({ code: 'FORGE_TRACE_EVIDENCE_CONFLICT' });

		await driver.exec(
			"INSERT INTO kernel_issues (id, title, created_at, updated_at) VALUES ('issue-other', 'Other', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');",
			config,
		);
		driver.registerWorktree({
			id: 'worktree-other-issue',
			git_common_dir: gitCommonDir,
			path: path.join(root, '.worktrees', 'other-issue'),
			branch,
			issue_id: 'issue-other',
			registered_at: '2026-08-11T00:02:00.000Z',
		}, config);
		await expect(broker.recordPrLinkage(linkage('opened', packet, runReceipt(packet))))
			.rejects.toMatchObject({ code: 'FORGE_TRACE_EVIDENCE_CONFLICT' });
		await expect(broker.recordPrLinkage(linkage('opened', packet, runReceipt(packet), {
			worktree_id: 'worktree-trace',
		}))).rejects.toMatchObject({ code: 'FORGE_TRACE_EVIDENCE_CONFLICT' });
		expect(await driver.queryAll('SELECT * FROM kernel_pr;', config)).toEqual([]);
	});

	test('preserves terminal linkage on exact replay and rejects changed evidence or head', async () => {
		const packet = workPacket();
		const openedReceipt = runReceipt(packet);
		const mergedReceipt = runReceipt(packet, {}, 'merged');
		await broker.recordPrLinkage(linkage('opened', packet, openedReceipt));
		await broker.recordPrLinkage(linkage('merged', packet, mergedReceipt));
		await broker.updatePrVerdict({ git_common_dir: gitCommonDir, repo: 'owner/forge', number: 514 }, {
			verdict: 'CLEAN-MERGEABLE', verdict_source: 'local', verdict_at: '2026-08-11T00:08:00.000Z', head_sha: HEAD_SHA,
		});
		const before = (await driver.queryAll('SELECT * FROM kernel_pr;', config))[0];
		await broker.recordPrLinkage(linkage('merged', packet, mergedReceipt));
		expect((await driver.queryAll('SELECT * FROM kernel_pr;', config))[0]).toEqual(before);

		const changedPacket = workPacket({ risk_manifest_digest: 'e'.repeat(64) });
		await expect(broker.recordPrLinkage(linkage('merged', changedPacket, runReceipt(changedPacket, {}, 'merged'))))
			.rejects.toMatchObject({ code: 'FORGE_TRACE_EVIDENCE_CONFLICT' });
		const changedHeadPacket = workPacket({ target_head: 'f'.repeat(40) });
		await expect(broker.recordPrLinkage(linkage('merged', changedHeadPacket, runReceipt(changedHeadPacket, {}, 'merged'))))
			.rejects.toMatchObject({ code: 'FORGE_TRACE_TERMINAL_CONFLICT' });
		expect((await driver.queryAll('SELECT * FROM kernel_pr;', config))[0]).toEqual(before);
	});

	test('reports explicit gaps for partial historical authority', async () => {
		await driver.exec(
			"INSERT INTO kernel_issues (id, title, created_at, updated_at) VALUES ('issue-gaps', 'Gaps', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');",
			config,
		);
		const trace = await broker.readTrace({ issue_id: 'issue-gaps' });
		expect(trace).toMatchObject({
			issue: { id: 'issue-gaps' },
			worktree: null,
			work_folder: null,
			artifacts: { plan: null, tasks: null, decisions: null },
			pull_requests: [],
			gaps: ['worktree', 'work_folder', 'plan', 'tasks', 'decisions', 'pull_requests'],
		});
	});

	test('preserves issue PRs when a selected PR is unlinked and reports the gap', async () => {
		const otherWorkFolder = 'docs/work/2026-08-11-other';
		await driver.exec(
			"INSERT INTO kernel_issues (id, title, created_at, updated_at) VALUES ('issue-other', 'Other', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');",
			config,
		);
		driver.registerWorktree({
			id: 'worktree-other', git_common_dir: gitCommonDir, path: path.join(root, '.worktrees', 'other'),
			branch: 'codex/other', issue_id: 'issue-other', work_folder: otherWorkFolder,
			registered_at: '2026-08-11T00:01:00.000Z',
		}, config);
		for (const filename of ['plan.md', 'tasks.md', 'decisions.md']) {
			const filenamePath = path.join(root, otherWorkFolder, filename);
			fs.mkdirSync(path.dirname(filenamePath), { recursive: true });
			fs.writeFileSync(filenamePath, `# Other ${filename}\n`, 'utf8');
		}
		await driver.upsertPr({
			id: 'pr-linked', git_common_dir: gitCommonDir, repo: 'owner/forge', number: 600,
			issue_id: 'issue-trace', worktree_id: 'worktree-trace', branch, head_sha: HEAD_SHA,
		}, {}, config);
		await driver.upsertPr({
			id: 'pr-unlinked', git_common_dir: gitCommonDir, repo: 'owner/forge', number: 601,
			issue_id: 'issue-other', worktree_id: 'worktree-other', branch: 'codex/other', head_sha: HEAD_SHA,
		}, {}, config);

		const trace = await broker.readTrace({
			issue_id: 'issue-trace', pr_number: 601, repo: 'owner/forge', git_common_dir: gitCommonDir,
		});
		expect(trace.pull_requests.map(pr => pr.id)).toEqual(['pr-linked', 'pr-unlinked']);
		expect(trace.gaps).toContain('pull_requests:pr-unlinked:unlinked_issue');
		expect(trace.worktree.id).toBe('worktree-trace');
		expect(trace.artifacts).toEqual({
			plan: { path: `${workFolder}/plan.md`, content: '# Plan\n' },
			tasks: { path: `${workFolder}/tasks.md`, content: '# Tasks\n' },
			decisions: { path: `${workFolder}/decisions.md`, content: '# Decisions\n' },
		});
	});

	test('fails immediately when an upsert read-back finds no persisted PR row', async () => {
		await driver.exec(`CREATE TRIGGER remove_pr_after_insert AFTER INSERT ON kernel_pr
			BEGIN DELETE FROM kernel_pr WHERE id = NEW.id; END;`, config);

		await expect(driver.upsertPr({
			id: 'pr-removed', git_common_dir: gitCommonDir, repo: 'owner/forge', number: 602,
			issue_id: 'issue-trace', worktree_id: 'worktree-trace', branch, head_sha: HEAD_SHA,
		}, {}, config)).rejects.toThrow('no kernel_pr row after upsert for owner/forge#602');
	});

	test('reports interrupted PR upserts and incomplete iterations as explicit trace gaps', async () => {
		const partial = await driver.upsertPr({
			id: 'pr-partial',
			git_common_dir: gitCommonDir,
			repo: 'owner/forge',
			number: 515,
			issue_id: 'issue-trace',
			worktree_id: 'worktree-trace',
			branch,
			head_sha: HEAD_SHA,
			registered_at: '2026-08-11T00:06:00.000Z',
		}, {}, config);
		let trace = await broker.readTrace({ issue_id: 'issue-trace' });
		expect(trace.gaps).toContain(`iterations:${partial.id}:missing`);

		await driver.insertKernelEvent({
			entity_type: 'pr',
			entity_id: partial.id,
			event_type: 'pr.opened',
			idempotency_key: `pr.opened:${partial.id}:${HEAD_SHA}`,
			expected_revision: 0,
			actor: 'test',
			origin: 'test',
			payload: { issue_id: 'issue-trace', head_sha: HEAD_SHA },
			created_at: '2026-08-11T00:06:01.000Z',
		}, {}, config);
		trace = await broker.readTrace({ issue_id: 'issue-trace' });
		expect(trace.gaps).not.toContain(`iterations:${partial.id}:missing`);
		expect(trace.gaps).toContain(`iterations:${partial.id}:incomplete`);
	});
});
