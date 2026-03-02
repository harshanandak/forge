const { describe, test, expect } = require('bun:test');

const { formatRecommendations } = require('../lib/commands/recommend');

describe('formatRecommendations', () => {
  describe('dual install paths for parallel tools', () => {
    test('tool with install.cmdCurl shows both CLI and curl install options', () => {
      const recommendations = {
        recommended: [
          {
            name: 'Parallel Web Search',
            type: 'skill',
            tier: 'free',
            stage: 'research',
            description: 'Web search via Parallel AI',
            install: {
              method: 'skills',
              cmd: 'bunx skills add parallel-web/parallel-agent-skills --skill parallel-web-search',
              cmdCurl: 'bunx skills add harshanandak/forge --skill parallel-web-search',
            },
            prerequisites: ['parallel-cli'],
            detectWhen: [],
          },
        ],
        skipped: [],
      };

      const output = formatRecommendations(recommendations);

      expect(output.includes('parallel-web/parallel-agent-skills')).toBeTruthy();
      expect(output.includes('harshanandak/forge')).toBeTruthy();
    });

    test('tool without install.cmdCurl shows only single install command', () => {
      const recommendations = {
        recommended: [
          {
            name: 'SonarCloud Analysis',
            type: 'skill',
            tier: 'free-public',
            stage: 'check',
            description: 'Code quality analysis',
            install: {
              method: 'skills',
              cmd: 'bunx skills add harshanandak/forge --skill sonarcloud-analysis',
            },
            detectWhen: [],
            alternatives: [{ tool: 'eslint', tier: 'free', tradeoff: 'Less comprehensive' }],
          },
        ],
        skipped: [],
      };

      const output = formatRecommendations(recommendations);

      expect(output.includes('harshanandak/forge --skill sonarcloud-analysis')).toBeTruthy();
    });
  });

  describe('basic formatting', () => {
    test('returns "No tools recommended" when list is empty', () => {
      const output = formatRecommendations({ recommended: [], skipped: [] });
      expect(output.includes('No tools recommended')).toBeTruthy();
    });

    test('groups tools by workflow stage', () => {
      const recommendations = {
        recommended: [
          {
            name: 'Tool A',
            type: 'cli',
            tier: 'free',
            stage: 'research',
            install: { method: 'npm', cmd: 'bun add tool-a' },
            detectWhen: [],
          },
          {
            name: 'Tool B',
            type: 'cli',
            tier: 'free',
            stage: 'check',
            install: { method: 'npm', cmd: 'bun add tool-b' },
            detectWhen: [],
          },
        ],
        skipped: [],
      };

      const output = formatRecommendations(recommendations);
      expect(output.includes('Research')).toBeTruthy();
      expect(output.includes('Check')).toBeTruthy();
    });

    test('shows free alternatives for tools that have them', () => {
      const recommendations = {
        recommended: [
          {
            name: 'Premium Tool',
            type: 'cli',
            tier: 'free-limited',
            stage: 'dev',
            install: { method: 'npm', cmd: 'bun add premium-tool' },
            detectWhen: [],
            alternatives: [{ tool: 'free-tool', tier: 'free', tradeoff: 'Fewer features' }],
          },
        ],
        skipped: [],
      };

      const output = formatRecommendations(recommendations);
      expect(output.includes('Free alternatives')).toBeTruthy();
      expect(output.includes('free-tool')).toBeTruthy();
    });

    test('skipped tools section shows when budget excludes some tools', () => {
      const recommendations = {
        recommended: [
          {
            name: 'Free Tool',
            type: 'cli',
            tier: 'free',
            stage: 'plan',
            install: { method: 'npm', cmd: 'bun add free-tool' },
            detectWhen: [],
          },
        ],
        skipped: [{ name: 'Paid Tool', reason: 'requires paid tier' }],
      };

      const output = formatRecommendations(recommendations);
      expect(output.includes('Skipped')).toBeTruthy();
      expect(output.includes('Paid Tool')).toBeTruthy();
    });
  });
});
