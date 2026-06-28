const {
  cleanupTmpDir,
  createMockForge,
  parseIssues,
  runSmartStatus,
} = require('./smart-status.helpers');

function withMockForge(mockData, callback) {
  const { tmpDir, forgeScript } = createMockForge(mockData);
  try {
    return callback(forgeScript);
  } finally {
    cleanupTmpDir(tmpDir);
  }
}

function runScoringJson(mockData, env = {}) {
  return withMockForge(mockData, (forgeScript) => {
    const result = runSmartStatus(['--json'], { FORGE_CMD: forgeScript, ...env });
    return {
      result,
      scored: result.status === 0 ? parseIssues(result.stdout) : [],
    };
  });
}

function runScoringText(mockData, env = {}) {
  return withMockForge(mockData, (forgeScript) => runSmartStatus([], {
    FORGE_CMD: forgeScript,
    ...env,
  }));
}

module.exports = {
  runScoringJson,
  runScoringText,
  withMockForge,
};
