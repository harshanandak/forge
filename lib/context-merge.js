/**
 * Semantic Merge for Context Files
 *
 * Intelligently merges existing CLAUDE.md/AGENTS.md files with Forge workflow templates
 * by understanding the semantic meaning of markdown sections.
 */

// Levenshtein distance for fuzzy string matching
function levenshteinDistance(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix = [];

  // Initialize matrix
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[len1][len2];
}

// Section category definitions
const SECTION_CATEGORIES = {
  preserve: [
    'Project Description',
    'Project Instructions',
    'Project Overview',
    'Project Background',
    'Domain Knowledge',
    'Domain Concepts',
    'Coding Standards',
    'Code Standards',
    'Architecture',
    'Tech Stack',
    'Technology Stack',
    'Build Commands',
    'Team Conventions',
    'Migration Strategy',
    'Setup',
    'Installation',
    'Quick Start',
    'Getting Started'
  ],

  replace: [
    'Workflow',
    'Development Workflow',
    'Our Workflow',
    'Workflow Process',
    'Development Process',
    'Process',
    'TDD',
    'Test-Driven Development',
    'TDD Approach',
    'Testing Approach',
    'Git Workflow',
    'Git Conventions',
    'Commit Conventions',
    'Git Strategy',
    'Forge Workflow',
    'Core Principles',
    'Development Principles'
  ],

  merge: [
    'Toolchain',
    'Tools',
    'MCP Servers',
    'Integrations',
    'Dependencies',
    'Libraries'
  ]
};

/**
 * Parse markdown content into semantic sections
 * @param {string} markdownContent - Raw markdown content
 * @returns {Array} Array of section objects with structure:
 *   { level, header, content, raw, startLine, endLine }
 */
function parseSemanticSections(markdownContent) {
  if (!markdownContent || typeof markdownContent !== 'string') {
    return [];
  }

  const lines = markdownContent.split('\n');
  const sections = [];
  let currentSection = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headerMatch) {
      // Save previous section if exists
      if (currentSection) {
        currentSection.endLine = i - 1;
        currentSection.content = currentSection.content.trim();
        sections.push(currentSection);
      }

      // Start new section
      currentSection = {
        level: headerMatch[1].length,
        header: headerMatch[2].trim(),
        content: '',
        raw: line,
        startLine: i
      };
    } else if (currentSection) {
      // Add content to current section
      currentSection.content += line + '\n';
      currentSection.raw += '\n' + line;
    } else {
      // Content before first header (preamble)
      if (line.trim() !== '') {
        sections.push({
          level: 0,
          header: null,
          content: line,
          raw: line,
          startLine: i,
          endLine: i
        });
      }
    }
  }

  // Save last section
  if (currentSection) {
    currentSection.endLine = lines.length - 1;
    currentSection.content = currentSection.content.trim();
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Detect the category of a section based on its header
 * @param {string} headerText - Section header text
 * @returns {Object} { category: 'preserve'|'replace'|'merge'|'unknown', confidence: 0-1 }
 */
function detectCategory(headerText) {
  if (!headerText || typeof headerText !== 'string') {
    return { category: 'unknown', confidence: 0 };
  }

  const normalized = headerText.toLowerCase().trim();
  let bestMatch = { category: 'unknown', confidence: 0 };

  // Check each category
  for (const [category, keywords] of Object.entries(SECTION_CATEGORIES)) {
    for (const keyword of keywords) {
      const keywordNorm = keyword.toLowerCase().trim();

      // Exact match = highest confidence
      if (normalized === keywordNorm) {
        return { category, confidence: 1.0 };
      }

      // Fuzzy match using Levenshtein distance
      const distance = levenshteinDistance(normalized, keywordNorm);
      const maxLen = Math.max(normalized.length, keywordNorm.length);
      const similarity = 1 - (distance / maxLen);

      // Update best match if this is better
      if (similarity > bestMatch.confidence) {
        bestMatch = { category, confidence: similarity };
      }

      // Also check if normalized contains the keyword
      if (normalized.includes(keywordNorm) || keywordNorm.includes(normalized)) {
        const containsSimilarity = Math.min(normalized.length, keywordNorm.length) / maxLen;
        if (containsSimilarity > bestMatch.confidence) {
          bestMatch = { category, confidence: containsSimilarity };
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Build merged document from categorized sections
 * @param {Array} existingSections - Sections from existing file
 * @param {Array} forgeSections - Sections from Forge template
 * @param {Object} options - Merge options
 * @returns {string} Merged markdown content
 */
function buildMergedDocument(existingSections, forgeSections, options = {}) {
  const result = [];
  const processedExisting = new Set();

  // Process forge sections first to establish structure
  forgeSections.forEach(forgeSection => {
    if (!forgeSection.header) {
      return; // Skip preamble from forge
    }

    const forgeCategory = detectCategory(forgeSection.header);

    if (forgeCategory.category === 'replace' && forgeCategory.confidence > 0.6) {
      // This is a workflow/TDD section - use forge version
      result.push(forgeSection.raw);

      // Mark any similar existing sections as processed
      existingSections.forEach((existingSection, idx) => {
        if (existingSection.header) {
          const existingCategory = detectCategory(existingSection.header);
          if (existingCategory.category === 'replace' && existingCategory.confidence > 0.6) {
            // Check if headers are similar enough
            const normalized1 = forgeSection.header.toLowerCase();
            const normalized2 = existingSection.header.toLowerCase();
            const distance = levenshteinDistance(normalized1, normalized2);
            const similarity = 1 - (distance / Math.max(normalized1.length, normalized2.length));

            if (similarity > 0.5) {
              processedExisting.add(idx);
            }
          }
        }
      });
    } else if (forgeCategory.category === 'merge' && forgeCategory.confidence > 0.6) {
      // Merge section - combine both
      result.push(forgeSection.raw);

      // Find and add corresponding existing section
      existingSections.forEach((existingSection, idx) => {
        if (existingSection.header) {
          const existingCategory = detectCategory(existingSection.header);
          if (existingCategory.category === 'merge' && existingCategory.confidence > 0.6) {
            const normalized1 = forgeSection.header.toLowerCase();
            const normalized2 = existingSection.header.toLowerCase();
            const distance = levenshteinDistance(normalized1, normalized2);
            const similarity = 1 - (distance / Math.max(normalized1.length, normalized2.length));

            if (similarity > 0.5) {
              // Add existing content under forge header
              result.push('\n' + existingSection.content);
              processedExisting.add(idx);
            }
          }
        }
      });
    }
  });

  // Add preserved sections from existing file
  existingSections.forEach((section, idx) => {
    if (processedExisting.has(idx)) {
      return; // Already processed
    }

    if (!section.header) {
      // Preserve preamble content
      if (section.content && section.content.trim() !== '') {
        result.unshift(section.raw); // Add to beginning
      }
      return;
    }

    const category = detectCategory(section.header);

    if (category.category === 'preserve' && category.confidence > 0.6) {
      result.push(section.raw);
    } else if (category.category === 'merge' && category.confidence > 0.6) {
      // Merge sections that exist in existing but not in forge
      result.push(section.raw);
    } else if (category.category === 'unknown' || category.confidence < 0.6) {
      // Unknown sections are preserved by default (safety first)
      result.push(section.raw);
    }
  });

  return result.join('\n\n');
}

/**
 * Semantic merge of existing and forge content
 * @param {string} existingContent - Existing file content
 * @param {string} forgeContent - Forge template content
 * @param {Object} options - { addMarkers: boolean }
 * @returns {string} Merged content
 */
function semanticMerge(existingContent, forgeContent, options = {}) {
  // Normalize line endings to LF for consistent parsing across platforms (Windows CRLF vs Unix LF)
  const normalizeLineEndings = (str) => str ? str.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : str;

  existingContent = normalizeLineEndings(existingContent);
  forgeContent = normalizeLineEndings(forgeContent);

  // Handle empty cases
  if (!existingContent || existingContent.trim() === '') {
    return forgeContent || '';
  }

  if (!forgeContent || forgeContent.trim() === '') {
    return existingContent;
  }

  // Parse both documents
  const existingSections = parseSemanticSections(existingContent);
  const forgeSections = parseSemanticSections(forgeContent);

  // Build merged document
  const merged = buildMergedDocument(existingSections, forgeSections, options);

  // Add markers if requested
  if (options.addMarkers) {
    // Separate preserved (user) and forge sections
    const userSections = existingSections.filter(s => {
      if (!s.header) return false;
      const category = detectCategory(s.header);
      return category.category === 'preserve' && category.confidence > 0.6;
    });

    const forgeSectionsFiltered = forgeSections.filter(s => {
      if (!s.header) return false;
      const category = detectCategory(s.header);
      return category.category === 'replace' && category.confidence > 0.6;
    });

    return wrapWithMarkers({
      user: userSections.map(s => s.raw).join('\n\n'),
      forge: forgeSectionsFiltered.map(s => s.raw).join('\n\n')
    });
  }

  return merged;
}

/**
 * Wrap content with USER and FORGE markers
 * @param {Object} content - { user: string, forge: string }
 * @returns {string} Content wrapped with markers
 */
function wrapWithMarkers(content) {
  const parts = [];

  if (content.forge && content.forge.trim() !== '') {
    parts.push('<!-- FORGE:START -->');
    parts.push(content.forge.trim());
    parts.push('<!-- FORGE:END -->');
  }

  if (content.user && content.user.trim() !== '') {
    parts.push('');
    parts.push('<!-- USER:START -->');
    parts.push(content.user.trim());
    parts.push('<!-- USER:END -->');
  }

  return parts.join('\n');
}

module.exports = {
  parseSemanticSections,
  detectCategory,
  semanticMerge,
  wrapWithMarkers,
  // Export for testing
  __internal: {
    levenshteinDistance,
    buildMergedDocument,
    SECTION_CATEGORIES
  }
};
