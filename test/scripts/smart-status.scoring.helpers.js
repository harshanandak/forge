const {
  cleanupTmpDir,
  createMockBd,
  parseIssues,
  runSmartStatus,
} = require('./smart-status.helpers');

function withMockBd(mockData, callback) {
  const { tmpDir, mockScript } = createMockBd(mockData);
  try {
    return callback(mockScript);
  } finally {
    cleanupTmpDir(tmpDir);
  }
}

function runScoringJson(mockData, env = {}) {
  return withMockBd(mockData, (mockScript) => {
    const result = runSmartStatus(['--json'], { BD_CMD: mockScript, ...env });
    return {
      result,
      scored: result.status === 0 ? parseIssues(result.stdout) : [],
    };
  });
}

function runScoringText(mockData, env = {}) {
  return withMockBd(mockData, (mockScript) => runSmartStatus([], {
    BD_CMD: mockScript,
    ...env,
  }));
}

module.exports = {
  runScoringJson,
  runScoringText,
  withMockBd,
};
