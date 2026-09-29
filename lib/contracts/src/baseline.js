"use strict";

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const PACKAGE_ROOT = join(__dirname, "..");

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifyContractBaseline() {
  const baseline = JSON.parse(readFileSync(join(PACKAGE_ROOT, "contract-baseline.v1.json"), "utf8"));
  const mismatches = [];
  for (const entry of baseline.artifacts) {
    const actual = sha256File(join(PACKAGE_ROOT, ...entry.path.split("/")));
    if (actual !== entry.sha256) mismatches.push({ path: entry.path, expected: entry.sha256, actual });
  }
  return { ok: mismatches.length === 0, mismatches };
}

module.exports = { verifyContractBaseline };
