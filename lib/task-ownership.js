'use strict';

/**
 * Parse a task list markdown file and validate file ownership.
 * Within each wave, no two tasks may own the same file.
 * Cross-wave ownership is allowed (sequential execution prevents conflicts).
 *
 * @param {string} content - task list markdown content
 * @returns {{ valid: boolean, violations: Array<{wave: number, task1: number, task2: number, file: string}> }}
 */
function validateOwnership(content) {
  const lines = content.split('\n');
  const violations = [];

  const wavePattern = /^## Wave (\d+)/;
  const taskPattern = /^### Task (\d+)/;
  const ownsPattern = /\*\*OWNS\*\*:\s*(.+)/;

  let currentWave = null;
  let currentTask = null;
  // Map: wave number -> Map of file -> first task number that owns it
  const waveOwnership = new Map();

  for (const line of lines) {
    const parsed = parseWaveAndTask(line, wavePattern, taskPattern, currentWave, currentTask, waveOwnership);
    if (parsed.matched) {
      currentWave = parsed.currentWave;
      currentTask = parsed.currentTask;
      continue;
    }

    if (currentWave !== null && currentTask !== null) {
      const ownedFiles = extractOwnedFiles(line, ownsPattern);
      if (ownedFiles) {
        checkOwnership(ownedFiles, waveOwnership.get(currentWave), currentWave, currentTask, violations);
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Parse a line for wave or task headers and update state accordingly.
 * @param {string} line - Current line of markdown
 * @param {RegExp} wavePattern - Pattern to match wave headers
 * @param {RegExp} taskPattern - Pattern to match task headers
 * @param {number|null} currentWave - Current wave number
 * @param {number|null} currentTask - Current task number
 * @param {Map} waveOwnership - Wave ownership map to initialize new waves
 * @returns {{ matched: boolean, currentWave: number|null, currentTask: number|null }}
 */
function parseWaveAndTask(line, wavePattern, taskPattern, currentWave, currentTask, waveOwnership) {
  const waveMatch = wavePattern.exec(line);
  if (waveMatch) {
    const wave = Number.parseInt(waveMatch[1], 10);
    if (!waveOwnership.has(wave)) {
      waveOwnership.set(wave, new Map());
    }
    return { matched: true, currentWave: wave, currentTask: null };
  }

  const taskMatch = taskPattern.exec(line);
  if (taskMatch) {
    return { matched: true, currentWave, currentTask: Number.parseInt(taskMatch[1], 10) };
  }

  return { matched: false, currentWave, currentTask };
}

/**
 * Extract owned file paths from an OWNS line.
 * @param {string} line - Current line of markdown
 * @param {RegExp} ownsPattern - Pattern to match OWNS declarations
 * @returns {string[]|null} Array of file paths, or null if line is not an OWNS line
 */
function extractOwnedFiles(line, ownsPattern) {
  const ownsMatch = ownsPattern.exec(line);
  if (!ownsMatch) return null;

  const filesRaw = ownsMatch[1];
  const fileMatches = filesRaw.match(/`([^`]+)`/g);
  if (!fileMatches) return null;

  return fileMatches.map((f) => f.replaceAll('`', ''));
}

/**
 * Check for ownership violations and record them.
 * @param {string[]} files - Files declared as owned
 * @param {Map<string, number>} ownership - File-to-task ownership map for the current wave
 * @param {number} currentWave - Current wave number
 * @param {number} currentTask - Current task number
 * @param {Array} violations - Array to push violations into
 */
function checkOwnership(files, ownership, currentWave, currentTask, violations) {
  for (const file of files) {
    if (ownership.has(file)) {
      const firstTask = ownership.get(file);
      if (firstTask !== currentTask) {
        violations.push({
          wave: currentWave,
          task1: firstTask,
          task2: currentTask,
          file,
        });
      }
    } else {
      ownership.set(file, currentTask);
    }
  }
}

module.exports = { validateOwnership };
