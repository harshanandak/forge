const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeWorkflowState } = require('../../lib/workflow/state.js');

const {
  WORKFLOW_STATE_FILENAME,
  extractWorkflowStateFromComments,
  loadState,
  readWorkflowStateFromBeads,
  saveState,
  initializeState,
  transitionStage,
} = require('../../lib/workflow/state-manager.js');

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-state-mgr-'));
}

function cleanTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createWorkflowState(currentStage, classification) {
  return {
    schemaVersion: 2,
    currentStage,
    completedStages: [],
    skippedStages: [],
    workflowDecisions: {
      classification,
      reason: 'test',
      userOverride: false,
      overrides: [],
    },
    parallelTracks: [],
  };
}

function writeStateFile(dir, state) {
  const serialized = writeWorkflowState(state);
  fs.writeFileSync(path.join(dir, WORKFLOW_STATE_FILENAME), serialized, 'utf8');
}

describe('state-manager', () => {
  describe('WORKFLOW_STATE_FILENAME', () => {
    test('exports the state filename constant', () => {
      expect(WORKFLOW_STATE_FILENAME).toBe('.forge-state.json');
    });
  });

  describe('loadState', () => {
    test('reads valid .forge-state.json from project root', () => {
      const dir = createTmpDir();
      try {
        const state = createWorkflowState('dev', 'standard');
        writeStateFile(dir, state);

        const result = loadState(dir);
        expect(result.state).not.toBeNull();
        expect(result.state.currentStage).toBe('dev');
        expect(result.state.workflowDecisions.classification).toBe('standard');
        expect(result.source).toBe('file');
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('returns null state when file missing', () => {
      const dir = createTmpDir();
      try {
        const result = loadState(dir);
        expect(result.state).toBeNull();
        expect(result.source).toBeNull();
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('falls back to Beads comments when file missing and comments provided', () => {
      const dir = createTmpDir();
      try {
        const state = createWorkflowState('plan', 'standard');
        const compact = JSON.stringify(JSON.parse(writeWorkflowState(state)));
        const comments = `WorkflowState: ${compact}`;

        const result = loadState(dir, { comments });
        expect(result.state).not.toBeNull();
        expect(result.state.currentStage).toBe('plan');
        expect(result.source).toBe('beads');
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('file takes priority over Beads comments', () => {
      const dir = createTmpDir();
      try {
        const fileState = createWorkflowState('dev', 'standard');
        writeStateFile(dir, fileState);

        const beadsState = createWorkflowState('plan', 'standard');
        const compact = JSON.stringify(JSON.parse(writeWorkflowState(beadsState)));
        const comments = `WorkflowState: ${compact}`;

        const result = loadState(dir, { comments });
        expect(result.state.currentStage).toBe('dev');
        expect(result.source).toBe('file');
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('falls back to Beads when state file is malformed', () => {
      const dir = createTmpDir();
      try {
        fs.writeFileSync(path.join(dir, WORKFLOW_STATE_FILENAME), '{bad json', 'utf8');

        const state = createWorkflowState('dev', 'standard');
        const compact = JSON.stringify(JSON.parse(writeWorkflowState(state)));
        const comments = `WorkflowState: ${compact}`;

        const result = loadState(dir, { comments });
        expect(result.state).not.toBeNull();
        expect(result.state.currentStage).toBe('dev');
        expect(result.source).toBe('beads');
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('returns null when state file is malformed and no Beads fallback', () => {
      const dir = createTmpDir();
      try {
        fs.writeFileSync(path.join(dir, WORKFLOW_STATE_FILENAME), '{bad json', 'utf8');

        const result = loadState(dir);
        expect(result.state).toBeNull();
        expect(result.source).toBeNull();
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('returns null when projectRoot is null', () => {
      const result = loadState(null);
      expect(result.state).toBeNull();
      expect(result.source).toBeNull();
    });
  });

  describe('saveState', () => {
    test('throws when projectRoot is empty', () => {
      const state = createWorkflowState('dev', 'standard');
      expect(() => saveState('', state)).toThrow(/valid projectRoot/);
      expect(() => saveState(null, state)).toThrow(/valid projectRoot/);
    });

    test('saves valid state and re-reads matching result', () => {
      const dir = createTmpDir();
      try {
        const state = createWorkflowState('dev', 'standard');
        const saved = saveState(dir, state);

        expect(saved.currentStage).toBe('dev');
        expect(saved.workflowDecisions.classification).toBe('standard');

        const { state: loaded } = loadState(dir);
        expect(loaded.currentStage).toBe('dev');
        expect(loaded.workflowDecisions.classification).toBe('standard');
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('rejects invalid state missing currentStage', () => {
      const dir = createTmpDir();
      try {
        expect(() => saveState(dir, { workflowDecisions: { classification: 'standard' } })).toThrow();
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('rejects invalid classification', () => {
      const dir = createTmpDir();
      try {
        expect(() => saveState(dir, {
          currentStage: 'dev',
          workflowDecisions: { classification: 'bogus' },
        })).toThrow();
      } finally {
        cleanTmpDir(dir);
      }
    });
  });

  describe('initializeState', () => {
    test('creates valid state for standard — currentStage is plan', () => {
      const dir = createTmpDir();
      try {
        const state = initializeState(dir, 'standard');
        expect(state.currentStage).toBe('plan');
        expect(state.workflowDecisions.classification).toBe('standard');
        expect(state.completedStages).toEqual([]);
        expect(state.skippedStages).toEqual([]);
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('creates valid state for simple — currentStage is dev', () => {
      const dir = createTmpDir();
      try {
        const state = initializeState(dir, 'simple');
        expect(state.currentStage).toBe('dev');
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('creates valid state for docs — currentStage is verify', () => {
      const dir = createTmpDir();
      try {
        const state = initializeState(dir, 'docs');
        expect(state.currentStage).toBe('verify');
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('custom firstStage overrides default', () => {
      const dir = createTmpDir();
      try {
        const state = initializeState(dir, 'standard', 'dev');
        expect(state.currentStage).toBe('dev');
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('throws on invalid classification', () => {
      const dir = createTmpDir();
      try {
        expect(() => initializeState(dir, 'bogus')).toThrow();
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('file exists after call', () => {
      const dir = createTmpDir();
      try {
        initializeState(dir, 'standard');
        expect(fs.existsSync(path.join(dir, WORKFLOW_STATE_FILENAME))).toBe(true);
      } finally {
        cleanTmpDir(dir);
      }
    });
  });

  describe('transitionStage', () => {
    test('plan to dev for standard succeeds and completes plan', () => {
      const dir = createTmpDir();
      try {
        initializeState(dir, 'standard');
        const result = transitionStage(dir, 'dev');

        expect(result.transitioned).toBe(true);
        expect(result.previousState.currentStage).toBe('plan');
        expect(result.newState.currentStage).toBe('dev');
        expect(result.newState.completedStages).toContain('plan');
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('plan to ship without override throws', () => {
      const dir = createTmpDir();
      try {
        initializeState(dir, 'standard');
        expect(() => transitionStage(dir, 'ship')).toThrow(/not allowed/i);
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('plan to ship with valid override succeeds', () => {
      const dir = createTmpDir();
      try {
        initializeState(dir, 'standard');
        const result = transitionStage(dir, 'ship', {
          override: {
            type: 'manual',
            fromStage: 'plan',
            toStage: 'ship',
            reason: 'emergency skip',
            actor: 'test',
          },
        });

        expect(result.transitioned).toBe(true);
        expect(result.newState.currentStage).toBe('ship');
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('override always records actual fromStage and toStage', () => {
      const dir = createTmpDir();
      try {
        initializeState(dir, 'standard');
        const result = transitionStage(dir, 'ship', {
          override: {
            type: 'manual',
            fromStage: 'bogus',
            toStage: 'bogus',
            reason: 'test mismatch',
            actor: 'test',
          },
        });

        const override = result.newState.workflowDecisions.overrides.at(-1);
        expect(override.fromStage).toBe('plan');
        expect(override.toStage).toBe('ship');
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('previousState is a deep copy', () => {
      const dir = createTmpDir();
      try {
        initializeState(dir, 'standard');
        const result = transitionStage(dir, 'dev');

        result.newState.completedStages.push('fake');
        expect(result.previousState.completedStages).not.toContain('fake');
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('returns previousState and newState', () => {
      const dir = createTmpDir();
      try {
        initializeState(dir, 'standard');
        const result = transitionStage(dir, 'dev');

        expect(result.previousState).toBeDefined();
        expect(result.newState).toBeDefined();
        expect(result.previousState.currentStage).not.toBe(result.newState.currentStage);
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('throws when no state exists', () => {
      const dir = createTmpDir();
      try {
        expect(() => transitionStage(dir, 'dev')).toThrow(/no workflow state/i);
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('preserves legacy schemaVersion 1 for premerge to verify transition', () => {
      const dir = createTmpDir();
      try {
        // Legacy v1 standard workflow includes verify
        const legacyState = {
          schemaVersion: 1,
          currentStage: 'premerge',
          completedStages: ['plan', 'dev', 'validate', 'ship', 'review'],
          skippedStages: [],
          workflowDecisions: {
            classification: 'standard',
            reason: 'test',
            userOverride: false,
            overrides: [],
          },
          parallelTracks: [],
        };
        saveState(dir, legacyState);

        const result = transitionStage(dir, 'verify');
        expect(result.transitioned).toBe(true);
        expect(result.newState.currentStage).toBe('verify');
        expect(result.newState.schemaVersion).toBe(1);
      } finally {
        cleanTmpDir(dir);
      }
    });

    test('persists new state to file', () => {
      const dir = createTmpDir();
      try {
        initializeState(dir, 'standard');
        transitionStage(dir, 'dev');

        const { state } = loadState(dir);
        expect(state.currentStage).toBe('dev');
        expect(state.completedStages).toContain('plan');
      } finally {
        cleanTmpDir(dir);
      }
    });
  });

  describe('extractWorkflowStateFromComments', () => {
    test('parses WorkflowState from single-line comment', () => {
      const state = createWorkflowState('dev', 'standard');
      const compact = JSON.stringify(JSON.parse(writeWorkflowState(state)));
      const comments = `Some other comment\nWorkflowState: ${compact}\nAnother comment`;

      const result = extractWorkflowStateFromComments(comments);
      expect(result).not.toBeNull();
      expect(result.currentStage).toBe('dev');
    });

    test('returns latest when multiple WorkflowState comments exist', () => {
      const state1 = createWorkflowState('plan', 'standard');
      const state2 = createWorkflowState('dev', 'standard');
      const compact1 = JSON.stringify(JSON.parse(writeWorkflowState(state1)));
      const compact2 = JSON.stringify(JSON.parse(writeWorkflowState(state2)));
      const comments = `WorkflowState: ${compact1}\nWorkflowState: ${compact2}`;

      const result = extractWorkflowStateFromComments(comments);
      expect(result.currentStage).toBe('dev');
    });

    test('returns null when no WorkflowState comment found', () => {
      const result = extractWorkflowStateFromComments('just a regular comment');
      expect(result).toBeNull();
    });

    test('returns null for empty input', () => {
      expect(extractWorkflowStateFromComments('')).toBeNull();
      expect(extractWorkflowStateFromComments()).toBeNull();
    });
  });

  describe('readWorkflowStateFromBeads', () => {
    test('is exported as a function', () => {
      expect(typeof readWorkflowStateFromBeads).toBe('function');
    });

    test('returns null when issueId is falsy', () => {
      expect(readWorkflowStateFromBeads(null)).toBeNull();
      expect(readWorkflowStateFromBeads('')).toBeNull();
      expect(readWorkflowStateFromBeads(undefined)).toBeNull();
    });

    test('parses comments when provided via options', () => {
      const state = createWorkflowState('validate', 'standard');
      const compact = JSON.stringify(JSON.parse(writeWorkflowState(state)));
      const comments = `WorkflowState: ${compact}`;

      const result = readWorkflowStateFromBeads('forge-test', { comments });
      expect(result).not.toBeNull();
      expect(result.currentStage).toBe('validate');
    });
  });
});
