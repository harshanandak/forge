const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

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

      assert.ok(
        output.includes('parallel-web/parallel-agent-skills'),
        'output should include the CLI install command'
      );
      assert.ok(
        output.includes('harshanandak/forge'),
        'output should include the curl fallback install command'
      );
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

      assert.ok(
        output.includes('harshanandak/forge --skill sonarcloud-analysis'),
        'output should include the skill install command'
      );
    });
  });

  describe('basic formatting', () => {
    test('returns "No tools recommended" when list is empty', () => {
      const output = formatRecommendations({ recommended: [], skipped: [] });
      assert.ok(output.includes('No tools recommended'));
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
      assert.ok(output.includes('Research'), 'output should include Research stage header');
      assert.ok(output.includes('Check'), 'output should include Check stage header');
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
      assert.ok(output.includes('Free alternatives'), 'output should show free alternatives');
      assert.ok(output.includes('free-tool'), 'output should show the free alternative name');
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
      assert.ok(output.includes('Skipped'), 'output should show skipped section');
      assert.ok(output.includes('Paid Tool'), 'output should mention skipped paid tool');
    });
  });
});
