#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('yaml');
const { stableStringify } = require('../lib/kernel/evaluators');
const { hashManifest, validateManifest } = require('../lib/validation/risk-manifest');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'validation', 'risk-manifest.source.yaml');
const OUTPUT_PATH = path.join(ROOT, 'validation', 'risk-manifest.v1.json');

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortById(entries) {
  return [...entries].sort((left, right) => compareText(left.id, right.id));
}

function normalizeSource(source) {
  const canonicalSource = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const parsed = parse(canonicalSource);
  const manifest = {
    schema_id: parsed.schema_id,
    revision: parsed.revision,
    source_hash: sha256(canonicalSource),
    generator_version: 'forge-risk-manifest-generator.v1',
    risks: sortById(parsed.risks).map((risk) => ({
      ...risk,
      gate_ids: [...risk.gate_ids].sort(),
    })),
    owners: sortById(parsed.owners).map((owner) => ({
      ...owner,
      risk_ids: [...owner.risk_ids].sort(),
      canonical_test_ids: [...owner.canonical_test_ids].sort(),
      dependent_routes: [...owner.dependent_routes].sort(),
      platform_runtime_additions: [...owner.platform_runtime_additions].sort(),
      lanes: [...owner.lanes].sort(),
      package_roots: [...owner.package_roots].sort(),
      selectors: [...owner.selectors].sort((left, right) => compareText(left.kind, right.kind)
        || compareText(left.prefix, right.prefix)),
    })),
    unknown_owner_fallback: {
      ...parsed.unknown_owner_fallback,
      required_gates: [...parsed.unknown_owner_fallback.required_gates].sort(),
    },
  };
  manifest.manifest_hash = hashManifest(manifest);
  validateManifest(manifest);
  return JSON.parse(stableStringify(manifest));
}

function generateRiskManifest(source) {
  return `${JSON.stringify(normalizeSource(source), null, 2)}\n`;
}

function main(args = process.argv.slice(2)) {
  const generated = generateRiskManifest(fs.readFileSync(SOURCE_PATH, 'utf8'));
  if (args.includes('--check')) {
    if (!fs.existsSync(OUTPUT_PATH) || fs.readFileSync(OUTPUT_PATH, 'utf8') !== generated) {
      console.error('Risk manifest is stale. Run: node scripts/generate-risk-manifest.js');
      process.exitCode = 1;
    }
    return;
  }
  fs.writeFileSync(OUTPUT_PATH, generated, 'utf8');
}

if (require.main === module) main();

module.exports = { generateRiskManifest, normalizeSource };
