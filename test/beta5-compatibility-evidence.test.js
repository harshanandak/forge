const { describe, expect, test } = require('bun:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BETA5_CORPUS_ROOT,
  buildStateTreeManifest,
  buildPrivacySafeInventory,
  proveBackupRestore,
  runBeta5MigrationDryRun,
  verifyBeta5Corpus,
} = require('../lib/beta5-compatibility-evidence');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function materializeKernelState(root) {
  const { Database } = require('bun:sqlite');
  const databasePath = path.join(root, '.forge', 'kernel.sqlite');
  const sql = fs.readFileSync(path.join(BETA5_CORPUS_ROOT, 'state', 'kernel.sql'), 'utf8');
  const database = new Database(databasePath, { create: true });
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
  return databasePath;
}

function makeBeta5State(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-state-'));
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture-project',
    devDependencies: { 'forge-workflow': '0.1.0-beta.5' },
  }, null, 2));
  fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), 'workflow:\n  profile: default\n');
  fs.writeFileSync(path.join(root, '.forge', 'issues.jsonl'), [
    JSON.stringify({ id: 'synthetic-1', title: 'Private title is never inventoried', status: 'open' }),
    JSON.stringify({ id: 'synthetic-2', title: 'Another private title', status: 'done' }),
  ].join('\n') + '\n');
  if (options.kernel) materializeKernelState(root);
  return root;
}

describe('beta.5 compatibility evidence', () => {
  test('verifies the immutable, versioned corpus and its content hashes', () => {
    const result = verifyBeta5Corpus();

    expect(result.status).toBe('PASS');
    expect(result.version).toBe('0.1.0-beta.5');
    expect(result.releaseCommit).toBe('ebeb4e5b31fc2dacdf23c5936c02fb2656990f49');
    expect(result.fileCount).toBeGreaterThanOrEqual(5);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceBlobCount).toBe(4);
  });

  test('rejects unmanifested corpus files instead of silently extending immutable evidence', () => {
    const copied = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-corpus-extra-'));
    fs.cpSync(BETA5_CORPUS_ROOT, copied, { recursive: true });
    fs.writeFileSync(path.join(copied, 'extra.json'), '{}');

    const result = verifyBeta5Corpus(copied);

    expect(result.status).toBe('FAIL');
    expect(result.reasons).toContain('unmanifested_file');
    expect(JSON.stringify(result)).not.toContain('extra.json');
  });

  test('fails closed when a corpus member does not match its manifest hash', () => {
    const copied = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-corpus-'));
    fs.cpSync(BETA5_CORPUS_ROOT, copied, { recursive: true });
    fs.appendFileSync(path.join(copied, 'contract', 'package-contract.json'), '\ncorrupt');

    const result = verifyBeta5Corpus(copied);

    expect(result.status).toBe('FAIL');
    expect(result.reasons).toContain('corpus_hash_mismatch');
    expect(JSON.stringify(result)).not.toContain('package-contract.json');
  });

  test('sanitizes caller-controlled corpus entry names and returns INCOMPLETE at corpus bounds', () => {
    const copied = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-corpus-bounds-'));
    fs.cpSync(BETA5_CORPUS_ROOT, copied, { recursive: true });
    const manifestPath = path.join(copied, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const privateName = 'customer-acme-private-contract.json';
    manifest.files.push({ path: privateName, sha256: '0'.repeat(64) });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(copied, privateName), '{}');
    const deep = path.join(copied, 'one', 'two', 'three');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'bounded.json'), '{}');

    const sanitized = verifyBeta5Corpus(copied);
    const manifestBytes = verifyBeta5Corpus(copied, { limits: { maxManifestBytes: 8 } });
    const manifestEntries = verifyBeta5Corpus(copied, { limits: { maxManifestEntries: 1 } });
    const depth = verifyBeta5Corpus(copied, { limits: { maxDepth: 2 } });
    const files = verifyBeta5Corpus(copied, { limits: { maxFiles: 2 } });
    const bytes = verifyBeta5Corpus(copied, { limits: { maxBytes: 8 } });
    const fileSize = verifyBeta5Corpus(copied, { limits: { maxFileBytes: 8 } });

    expect(JSON.stringify(sanitized)).not.toContain(privateName);
    expect(manifestBytes).toMatchObject({ status: 'INCOMPLETE', reasons: ['corpus_manifest_byte_limit'] });
    expect(manifestEntries).toMatchObject({ status: 'INCOMPLETE', reasons: ['corpus_manifest_entry_limit'] });
    expect(depth).toMatchObject({ status: 'INCOMPLETE', reasons: ['corpus_depth_limit'] });
    expect(files).toMatchObject({ status: 'INCOMPLETE', reasons: ['corpus_file_limit'] });
    expect(bytes).toMatchObject({ status: 'INCOMPLETE', reasons: ['corpus_byte_limit'] });
    expect(fileSize).toMatchObject({ status: 'INCOMPLETE', reasons: ['corpus_file_size_limit'] });
  });

  test('inventories only privacy-safe state shape and records explicit unknowns', () => {
    const root = makeBeta5State();
    fs.writeFileSync(path.join(root, '.forge', 'kernel.sqlite'), 'not-a-real-database');

    const inventory = buildPrivacySafeInventory(root);
    const serialized = JSON.stringify(inventory);

    expect(inventory.status).toBe('INCOMPLETE');
    expect(inventory.surfaces.issues).toMatchObject({ status: 'PASS', records: 2 });
    expect(inventory.surfaces.kernel).toMatchObject({ status: 'INCOMPLETE', reason: 'unrecognized_database' });
    expect(inventory.unknowns).toContain('kernel_schema');
    expect(serialized).not.toContain('Private title');
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(os.hostname());
  });

  test('inventories recognized Kernel schema and representative state through read-only SQLite', () => {
    const root = makeBeta5State({ kernel: true });
    const before = sha256File(path.join(root, '.forge', 'kernel.sqlite'));

    const inventory = buildPrivacySafeInventory(root);

    expect(inventory.status).toBe('PASS');
    expect(inventory.surfaces.kernel).toMatchObject({
      status: 'PASS',
      schemaVersion: '001_initial_kernel_schema',
      migrationCount: 1,
      counts: {
        issues: 1,
        comments: 1,
        dependencies: 1,
        claims: 1,
        runs: 1,
        projections: 1,
        worktrees: 1,
      },
      unknowns: [],
    });
    expect(sha256File(path.join(root, '.forge', 'kernel.sqlite'))).toBe(before);
    expect(JSON.stringify(inventory)).not.toContain('Synthetic issue');
  });

  test('proves backup and restore in an isolated destination without changing source bytes', async () => {
    const root = makeBeta5State();
    const before = sha256File(path.join(root, '.forge', 'issues.jsonl'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-proof-'));

    const proof = await proveBackupRestore(root, workspace);

    expect(proof.status).toBe('PASS');
    expect(proof.fileCount).toBe(3);
    expect(proof.categories).toEqual({ config: 1, issueProjection: 1, package: 1 });
    expect(proof.backupHash).toBe(proof.restoreHash);
    expect(sha256File(path.join(root, '.forge', 'issues.jsonl'))).toBe(before);
    expect(fs.existsSync(path.join(workspace, 'backup', '.forge', 'issues.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'restore', '.forge', 'issues.jsonl'))).toBe(true);
  });

  test('refuses non-temporary destinations and proves a Kernel backup semantically', async () => {
    const root = makeBeta5State({ kernel: true });
    const nonTemporary = await proveBackupRestore(root, process.cwd());
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-sqlite-proof-'));
    const sqlite = await proveBackupRestore(root, workspace);

    expect(nonTemporary).toMatchObject({ status: 'FAIL', reason: 'proof_root_not_temporary' });
    expect(sqlite).toMatchObject({
      status: 'PASS',
      fileBytesMatched: true,
      kernel: {
        integrity: 'ok',
        schemaHashMatched: true,
        contentHashMatched: true,
        countsMatched: true,
      },
    });
    expect(fs.existsSync(path.join(workspace, 'restore', '.forge', 'kernel.sqlite'))).toBe(true);
  });

  test('snapshots the complete supported state tree and refuses links or junctions', () => {
    const root = makeBeta5State({ kernel: true });
    for (const relativePath of [
      '.forge/comments.jsonl',
      '.forge/dependencies.jsonl',
      '.forge/runs/run.json',
      '.forge/projections/issues.jsonl',
      '.forge/worktrees.jsonl',
    ]) {
      const filePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '{}\n');
    }

    const clean = buildStateTreeManifest(root);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-external-'));
    fs.symlinkSync(external, path.join(root, '.forge', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = buildStateTreeManifest(root);

    expect(clean.status).toBe('PASS');
    expect(clean.fileCount).toBeGreaterThanOrEqual(9);
    expect(clean.categories).toMatchObject({
      commentProjection: 1,
      dependencyProjection: 1,
      kernel: 1,
      projection: 1,
      runEvidence: 1,
      worktreeProjection: 1,
    });
    expect(clean.files).toBeUndefined();
    expect(linked).toMatchObject({ status: 'INCOMPLETE', reasons: ['state_tree_contains_link'] });
  });

  test('never emits arbitrary source filenames in backup or dry-run evidence', async () => {
    const root = makeBeta5State({ kernel: true });
    const secretName = 'customer-acme-private-token.json';
    fs.writeFileSync(path.join(root, '.forge', secretName), '{"secret":"not evidence"}');
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-private-backup-'));
    const dryRunRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-private-dryrun-'));

    const backup = await proveBackupRestore(root, backupRoot);
    const dryRun = await runBeta5MigrationDryRun(root, { proofRoot: dryRunRoot });
    const evidence = JSON.stringify({ backup, dryRun });

    expect(backup.status).toBe('PASS');
    expect(dryRun.status).toBe('PASS');
    expect(evidence).not.toContain(secretName);
    expect(evidence).not.toContain('not evidence');
    expect(evidence).not.toContain(root);
  });

  test('returns INCOMPLETE at deterministic tree, file, byte, JSONL, and SQLite row bounds', () => {
    const root = makeBeta5State({ kernel: true });
    const deep = path.join(root, '.forge', 'one', 'two', 'three');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'deep.json'), '{}');
    fs.writeFileSync(path.join(root, '.forge', 'large.bin'), Buffer.alloc(128));

    const depth = buildStateTreeManifest(root, { limits: { maxDepth: 2 } });
    const fileSize = buildStateTreeManifest(root, { limits: { maxFileBytes: 64 } });
    const totalBytes = buildStateTreeManifest(root, { limits: { maxBytes: 64 } });
    const fileCount = buildStateTreeManifest(root, { limits: { maxFiles: 2 } });
    const jsonl = buildPrivacySafeInventory(root, { limits: { maxJsonlRows: 1 } });
    const sqlite = buildPrivacySafeInventory(root, { limits: { maxSqliteRows: 0 } });

    expect(depth).toMatchObject({ status: 'INCOMPLETE', reasons: ['state_tree_depth_limit'] });
    expect(fileSize).toMatchObject({ status: 'INCOMPLETE', reasons: ['state_tree_file_size_limit'] });
    expect(totalBytes).toMatchObject({ status: 'INCOMPLETE', reasons: ['state_tree_byte_limit'] });
    expect(fileCount).toMatchObject({ status: 'INCOMPLETE', reasons: ['state_tree_file_limit'] });
    expect(jsonl.status).toBe('INCOMPLETE');
    expect(jsonl.unknowns).toContain('issue_row_limit');
    expect(sqlite.status).toBe('INCOMPLETE');
    expect(sqlite.unknowns).toContain('kernel_row_limit');
  });

  test('rejects a source swapped to a link between scan and copy without following it', async () => {
    const root = makeBeta5State();
    const proofRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-swap-proof-'));
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-swap-external-'));
    const external = path.join(externalRoot, 'external.jsonl');
    fs.writeFileSync(external, '{"private":"outside"}\n');
    let swapped = false;

    const proof = await proveBackupRestore(root, proofRoot, {
      testHooks: {
        beforeSourceOpen({ sourcePath }) {
          if (swapped || path.basename(sourcePath) !== 'issues.jsonl') return;
          swapped = true;
          fs.rmSync(sourcePath);
          fs.symlinkSync(
            process.platform === 'win32' ? externalRoot : external,
            sourcePath,
            process.platform === 'win32' ? 'junction' : 'file',
          );
        },
      },
    });

    expect(swapped).toBe(true);
    expect(proof).toMatchObject({ status: 'FAIL', reason: 'source_link_refused' });
    expect(JSON.stringify(proof)).not.toContain('issues.jsonl');
    expect(JSON.stringify(proof)).not.toContain(external);
  });

  test('rejects proof-root identity and reparse swaps before destination writes', async () => {
    const root = makeBeta5State({ kernel: true });
    const proofRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-root-swap-'));
    const displacedRoot = `${proofRoot}-displaced`;
    const alternateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-root-alternate-'));
    let swapped = false;

    const proof = await proveBackupRestore(root, proofRoot, {
      testHooks: {
        beforeDestinationOpen() {
          if (swapped) return;
          swapped = true;
          fs.renameSync(proofRoot, displacedRoot);
          fs.symlinkSync(alternateRoot, proofRoot, process.platform === 'win32' ? 'junction' : 'dir');
        },
      },
    });

    expect(swapped).toBe(true);
    expect(proof).toMatchObject({ status: 'FAIL', reason: 'proof_root_changed' });
    expect(fs.readdirSync(alternateRoot)).toEqual([]);
    expect(JSON.stringify(proof)).not.toContain(proofRoot);

    const kernelProofRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-kernel-root-swap-'));
    const displacedKernelRoot = `${kernelProofRoot}-displaced`;
    const alternateKernelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-kernel-root-alternate-'));
    const kernelProof = await proveBackupRestore(root, kernelProofRoot, {
      testHooks: {
        beforeKernelBackupWrite() {
          fs.renameSync(kernelProofRoot, displacedKernelRoot);
          fs.symlinkSync(
            alternateKernelRoot,
            kernelProofRoot,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        },
      },
    });

    expect(kernelProof).toMatchObject({ status: 'FAIL', reason: 'proof_root_changed' });
    expect(fs.readdirSync(alternateKernelRoot)).toEqual([]);
  });

  test('returns deterministic PASS and proves the dry-run never mutates its full source tree', async () => {
    const root = makeBeta5State({ kernel: true });
    const proofRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-dry-run-'));
    const before = sha256File(path.join(root, '.forge', 'issues.jsonl'));

    const first = await runBeta5MigrationDryRun(root, { proofRoot });
    fs.rmSync(proofRoot, { recursive: true, force: true });
    fs.mkdirSync(proofRoot, { recursive: true });
    const second = await runBeta5MigrationDryRun(root, { proofRoot });

    expect(first.status).toBe('PASS');
    expect(first).toEqual(second);
    expect(first.sourceMutated).toBe(false);
    expect(first.sourceTree.before).toEqual(first.sourceTree.after);
    expect(first.sourceTree.before.fileCount).toBeGreaterThanOrEqual(4);
    expect(sha256File(path.join(root, '.forge', 'issues.jsonl'))).toBe(before);
  });

  test('returns deterministic FAIL when the immutable corpus cannot be trusted', async () => {
    const root = makeBeta5State();
    const copied = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-bad-corpus-'));
    fs.cpSync(BETA5_CORPUS_ROOT, copied, { recursive: true });
    fs.appendFileSync(path.join(copied, 'state', 'issues.jsonl'), '{}\n');
    const proofRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-fail-proof-'));

    const result = await runBeta5MigrationDryRun(root, { corpusRoot: copied, proofRoot });

    expect(result.status).toBe('FAIL');
    expect(result.reasons).toContain('corpus_integrity_failed');
    expect(result.sourceMutated).toBe(false);
  });

  test('returns INCOMPLETE for unknown state instead of inventing compatibility evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-beta5-unknown-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{broken');

    const result = await runBeta5MigrationDryRun(root);

    expect(result.status).toBe('INCOMPLETE');
    expect(result.reasons).toContain('inventory_incomplete');
    expect(result.sourceMutated).toBe(false);
  });

  test('does not call an unrelated package a beta.5-compatible state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-not-beta5-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'other-project' }));

    const inventory = buildPrivacySafeInventory(root);

    expect(inventory.status).toBe('INCOMPLETE');
    expect(inventory.unknowns).toContain('beta5_install_contract');
  });
});
