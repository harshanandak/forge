'use strict';

/**
 * Smart merge for AGENTS.md - preserves USER sections, updates FORGE sections.
 *
 * Handles four cases:
 * 1. No markers at all: Wrap existing content in USER markers, append FORGE section
 * 2. USER markers but no FORGE markers: Keep USER section, insert FORGE section
 * 3. Both markers present: Preserve USER section, update FORGE section (existing behavior)
 * 4. Empty existing content: Return only FORGE section (no empty USER block)
 *
 * @param {string} existingContent - The current AGENTS.md content
 * @param {string} newContent - The new template content containing FORGE section
 * @returns {string} Merged content, or empty string if merge not possible
 */
function smartMergeAgentsMd(existingContent, newContent) {
  // Extract FORGE section from new content (needed in all cases)
  const forgeStartMatch = (/(<!-- FORGE:START.*?-->[\s\S]*?<!-- FORGE:END -->)/).exec(newContent);
  const forgeSection = forgeStartMatch ? forgeStartMatch[0] : '';

  // Check if existing content has markers
  const hasUserMarkers = existingContent.includes('<!-- USER:START') && existingContent.includes('<!-- USER:END');

  let userSection;

  if (hasUserMarkers) {
    // Extract existing USER section (with markers)
    const userMatch = (/(<!-- USER:START.*?-->[\s\S]*?<!-- USER:END -->)/).exec(existingContent);
    userSection = userMatch ? userMatch[0] : '';
  } else if (existingContent.trim() === '') {
    // Empty existing content: no USER block at all
    userSection = null;
  } else {
    // No markers: wrap entire existing content in USER markers
    userSection = `<!-- USER:START -->\n${existingContent.trim()}\n<!-- USER:END -->`;
  }

  // Build merged content
  const setupInstructions = newContent.includes('<!-- FORGE:SETUP-INSTRUCTIONS')
    ? (/(<!-- FORGE:SETUP-INSTRUCTIONS[\s\S]*?-->)/).exec(newContent)?.[0] || ''
    : '';

  let merged = '# AGENTS.md\n\n';

  // Add setup instructions if this is first-time setup
  if (setupInstructions && !existingContent.includes('FORGE:SETUP-INSTRUCTIONS')) {
    merged += setupInstructions + '\n\n';
  }

  // Add USER section (skip if empty existing content — no empty USER block)
  if (userSection !== null) {
    merged += userSection + '\n\n';
  }

  // Add updated FORGE section
  merged += forgeSection + '\n\n';

  // Add footer
  merged += `---\n\n## Improving This Workflow\n\nEvery time you give the same instruction twice, add it to this file:\n1. User-specific rules: Add to USER:START section above\n2. Forge workflow improvements: Suggest to forge maintainers\n\n**Keep this file updated as you learn about the project.**\n\n---\n\nSee \`AGENTS.md\` for complete workflow guide.\nSee \`docs/TOOLCHAIN.md\` for comprehensive tool reference.\n`;

  return merged;
}

module.exports = { smartMergeAgentsMd };
