#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function readAnalysis() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) {
    throw new Error('Expected JSON analysis payload on stdin');
  }
  return JSON.parse(raw);
}

function renderPhase3Review(analysis) {
  const detectorCategories = Object.entries(analysis.scores ?? {})
    .filter(([name, score]) => name !== 'rubric' && Number(score) > 0)
    .map(([name]) => name);

  const lines = [
    '',
    `Structured dependency review for ${analysis.currentIssue.id}...`,
    '',
  ];

  if (!Array.isArray(analysis.issues) || analysis.issues.length === 0) {
    lines.push('No conflicts detected');
    return `${lines.join('\n')}\n`;
  }

  const seenPairs = new Set();
  for (const finding of analysis.issues) {
    const key = `${analysis.currentIssue.id}->${finding.targetIssueId}`;
    if (seenPairs.has(key)) {
      continue;
    }
    seenPairs.add(key);
    lines.push(`Issue pair: ${analysis.currentIssue.id} -> ${finding.targetIssueId}`);
  }

  lines.push(`Rubric score: ${analysis.scores?.rubric ?? 0}`);
  lines.push(
    `Confidence: ${(analysis.confidence?.score ?? 0).toFixed(2)}${
      analysis.confidence?.belowThreshold ? ' (below 70% threshold)' : ''
    }`,
  );
  lines.push(`Detector categories: ${detectorCategories.join(', ') || 'none'}`);
  lines.push(`Needs user decision: ${analysis.needsUserDecision ? 'yes' : 'no'}`);

  if (Array.isArray(analysis.detectorConflicts) && analysis.detectorConflicts.length > 0) {
    lines.push('Conflicts:');
    for (const conflict of analysis.detectorConflicts) {
      lines.push(`  - ${conflict}`);
    }
  }

  if (Array.isArray(analysis.proposals) && analysis.proposals.length > 0) {
    lines.push('');
    lines.push('Proposed dependency updates:');
    for (const proposal of analysis.proposals) {
      lines.push(`  - ${proposal.dependentIssueId} depends on ${proposal.dependsOnIssueId}`);
      if (Array.isArray(proposal.pros) && proposal.pros.length > 0) {
        lines.push(`    Pros: ${proposal.pros.join('; ')}`);
      }
      if (Array.isArray(proposal.cons) && proposal.cons.length > 0) {
        lines.push(`    Cons: ${proposal.cons.join('; ')}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  process.stdout.write(renderPhase3Review(readAnalysis()));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

module.exports = {
  renderPhase3Review,
};
