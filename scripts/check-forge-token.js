'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { _pushProof } = require('../lib/validation-receipt');
const { defaultGetProcessIdentity } = require('./process-tree');

const NONCE_ENV_VAR = 'FORGE_PUSH_NONCE';
const NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function git(projectRoot, args, deps = {}) {
  return (deps.execFileSync || execFileSync)('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function resolveProofPath(projectRoot, nonce, deps = {}) {
  if (!NONCE_PATTERN.test(nonce || '')) throw new Error('invalid push proof nonce');
  if (deps.resolvePushProofPath) return path.resolve(deps.resolvePushProofPath(projectRoot, nonce));
  const root = path.resolve(git(projectRoot, ['rev-parse', '--show-toplevel'], deps));
  return path.resolve(root, git(root, ['rev-parse', '--git-path', `forge/push-tokens/${nonce}.json`], deps));
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Write signed authority for one active `forge push` invocation.
 *
 * @param {string} projectRoot
 * @param {object} options
 * @returns {{nonce: string}}
 */
function write(projectRoot, options = {}) {
  const nonce = (options.randomUUID || crypto.randomUUID)();
  const ownerPid = options.processPid || process.pid;
  const getProcessIdentity = options.getProcessIdentity || defaultGetProcessIdentity;
  const ownerIdentity = getProcessIdentity(ownerPid);
  if (!ownerIdentity) throw new Error('push proof owner identity unavailable');
  const proof = _pushProof.create(projectRoot, options.snapshot, {
    nonce,
    mode: options.mode,
    gates: options.gates,
    owner: { pid: ownerPid, identity: ownerIdentity },
    receiptIdentity: options.receiptIdentity,
  }, options);
  writeAtomic(resolveProofPath(projectRoot, nonce, options), JSON.stringify(proof));
  return { nonce };
}

function validate(projectRoot, options = {}) {
  try {
    const env = options.env || process.env;
    const nonce = env[NONCE_ENV_VAR];
    if (!NONCE_PATTERN.test(nonce || '')) return { valid: false };
    const proof = JSON.parse(fs.readFileSync(resolveProofPath(projectRoot, nonce, options), 'utf8'));
    const verified = _pushProof.verify(projectRoot, proof, { nonce, env }, options);
    if (!verified.valid) return verified;
    const getProcessIdentity = options.getProcessIdentity || defaultGetProcessIdentity;
    const owner = verified.payload.owner;
    if (!owner || getProcessIdentity(owner.pid) !== owner.identity) {
      return { valid: false, reason: 'owner' };
    }
    return verified;
  } catch {
    return { valid: false };
  }
}

/**
 * Check signed authority without consuming it so all three hook predicates can read it.
 */
function isValid(projectRoot, options = {}) {
  return validate(projectRoot, options).valid === true;
}

/**
 * Revoke only the proof named by this invocation's nonce.
 */
function consume(projectRoot, options = {}) {
  try {
    const nonce = options.nonce || (options.env || process.env)[NONCE_ENV_VAR];
    fs.unlinkSync(resolveProofPath(projectRoot, nonce, options));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  write,
  isValid,
  consume,
  _internal: { NONCE_ENV_VAR, resolveProofPath, validate },
};

if (require.main === module) {
  const result = validate(process.cwd());
  if (result.valid) {
    console.log(`forge push ${result.payload.mode} authorization valid — skipping pre-push hooks`);
    process.exit(0);
  }
  process.exit(1);
}
