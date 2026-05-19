const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('@babel/parser');

/**
 * Allowlist mapping topic names to filenames in docs/.
 * Security: Only these exact keys are accepted — prevents path traversal.
 */
const TOPICS = {
  toolchain: 'TOOLCHAIN.md',
  validation: 'VALIDATION.md',
  setup: 'SETUP.md',
  examples: 'EXAMPLES.md',
  roadmap: 'ROADMAP.md',
};

const TOPIC_DIRS = {
  setup: ['guides', 'reference', ''],
};

/**
 * List all available topic names.
 * @returns {string[]}
 */
function listTopics() {
  return Object.keys(TOPICS);
}

/**
 * Get the content of a documentation topic.
 * Uses an allowlist to prevent path traversal attacks.
 *
 * @param {string} topic - Topic name (must be in TOPICS allowlist)
 * @param {string} packageDir - Forge package root directory
 * @returns {{ content?: string, error?: string }}
 */
function getTopicContent(topic, packageDir) {
  const availableList = listTopics().join(', ');

  // Validate against allowlist (rejects any path traversal attempt)
  const filename = TOPICS[topic];
  if (!filename) {
    return { error: `Unknown topic: "${topic}". Available topics: ${availableList}` };
  }

  const searchDirs = TOPIC_DIRS[topic] || ['reference', 'guides', ''];

  for (const dir of searchDirs) {
    const filePath = path.join(packageDir, 'docs', dir, filename);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { content };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // Try the next allowed documentation directory.
        continue;
      }
      return { error: `Failed to read documentation file "${filePath}": ${error.message}` };
    }
  }

  const searchedPaths = searchDirs
    .map((dir) => path.join(packageDir, 'docs', dir, filename))
    .join(', ');
  return { error: `Documentation file "${filename}" not found at ${searchedPaths}` };
}

function walkFiles(rootDir, predicate, results = []) {
  if (!fs.existsSync(rootDir)) {
    return results;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'coverage', 'test-results', 'dist', 'build', '.next', 'out'].includes(entry.name)) {
        continue;
      }
      walkFiles(fullPath, predicate, results);
    } else if (predicate(fullPath)) {
      results.push(fullPath);
    }
  }

  return results;
}

function getMarkdownFiles(packageDir) {
  const rootDocs = ['README.md', 'CHANGELOG.md', 'AGENTS.md', 'CLAUDE.md']
    .map((file) => path.join(packageDir, file))
    .filter((file) => fs.existsSync(file));
  const docsFiles = walkFiles(path.join(packageDir, 'docs'), (file) => file.endsWith('.md'));
  return [...rootDocs, ...docsFiles].sort((a, b) => a.localeCompare(b));
}

function isExternalLink(target) {
  const trimmed = target.trim();
  return trimmed.startsWith('//') || /^(https?:|mailto:|tel:|ftp:|data:|app:\/\/|plugin:\/\/)/i.test(trimmed);
}

function stripLinkDecorators(target) {
  return target
    .trim()
    .replaceAll(/^<|>$/g, '')
    .split(/[?#]/)[0];
}

function slugHeading(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replaceAll(/[`*_~[\](){}:;'"!?,./\\|+=<>@#$%^&]/g, '')
    .replaceAll(/\s+/g, '-');
}

function collectAnchors(content) {
  const anchors = new Set();
  const seen = new Map();
  let inFence = false;
  let previousTextLine = null;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      previousTextLine = null;
      continue;
    }

    if (inFence) {
      previousTextLine = null;
      continue;
    }

    const heading = getMarkdownHeadingText(line);
    if (heading) {
      addAnchor(anchors, seen, heading);
      previousTextLine = null;
      continue;
    }

    if (previousTextLine && isSetextHeadingUnderline(line)) {
      addAnchor(anchors, seen, previousTextLine);
      previousTextLine = null;
      continue;
    }

    previousTextLine = line.trim() ? line.trim() : null;
  }
  return anchors;
}

function addAnchor(anchors, seen, heading) {
  const slug = slugHeading(heading);
  const count = seen.get(slug) || 0;
  anchors.add(count === 0 ? slug : `${slug}-${count}`);
  seen.set(slug, count + 1);
}

function isSetextHeadingUnderline(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  const marker = trimmed[0];
  if (marker !== '=' && marker !== '-') {
    return false;
  }

  for (const char of trimmed) {
    if (char !== marker) {
      return false;
    }
  }
  return true;
}

function getMarkdownHeadingText(line) {
  const trimmed = line.trimStart();
  let level = 0;
  while (trimmed[level] === '#' && level < 6) {
    level++;
  }

  if (level === 0 || trimmed[level] !== ' ') {
    return null;
  }

  return trimClosingHeadingHashes(trimmed.slice(level + 1).trim());
}

function trimClosingHeadingHashes(text) {
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') {
    end--;
  }

  return text.slice(0, end).trimEnd();
}

function findMarkdownLinks(content) {
  const links = [];
  let offset = 0;
  let inFence = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      offset += line.length + 1;
      continue;
    }

    if (!inFence) {
      links.push(...findMarkdownLinksInLine(line, offset));
    }
    offset += line.length + 1;
  }
  return links;
}

function findMarkdownLinksInLine(line, offset) {
  const links = [];
  const referenceTarget = getReferenceLinkTarget(line);
  if (referenceTarget) {
    links.push({ target: referenceTarget, index: offset });
  }

  let cursor = 0;
  while (cursor < line.length) {
    const start = line.indexOf('](', cursor);
    if (start === -1) {
      break;
    }

    const end = findMarkdownDestinationEnd(line, start + 2);
    if (end === -1) {
      break;
    }

    const target = line.slice(start + 2, end).trim().split(/\s+/)[0];
    if (target) {
      links.push({ target, index: offset + start });
    }
    cursor = end + 1;
  }
  return links;
}

function findMarkdownDestinationEnd(line, start) {
  let depth = 0;
  for (let index = start; index < line.length; index++) {
    const char = line[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      if (depth === 0) {
        return index;
      }
      depth--;
    }
  }
  return -1;
}

function getReferenceLinkTarget(line) {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('[')) {
    return null;
  }

  const labelEnd = trimmed.indexOf(']:');
  if (labelEnd <= 1) {
    return null;
  }

  const target = trimmed.slice(labelEnd + 2).trim().split(/\s+/)[0];
  return target || null;
}

function lineForIndex(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function formatLinkTargetForReport(rawTarget) {
  const normalized = rawTarget.trim().replaceAll('\\', '/');
  if (!path.isAbsolute(normalized) && !/^[A-Za-z]:\//.test(normalized)) {
    return rawTarget;
  }

  const worktreeIndex = normalized.indexOf('/.worktrees/');
  if (worktreeIndex >= 0) {
    return `<repo>${normalized.slice(worktreeIndex)}`;
  }

  const repoIndex = normalized.toLowerCase().lastIndexOf('/forge/');
  if (repoIndex >= 0) {
    return `<repo>/${normalized.slice(repoIndex + '/forge/'.length)}`;
  }

  return `<absolute-path>/${path.posix.basename(normalized)}`;
}

function isWithinRoot(rootDir, candidatePath) {
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveMarkdownLink(packageDir, file, rawTarget) {
  const [filePart, anchorPart] = rawTarget.replaceAll(/^<|>$/g, '').split('#');
  if (!filePart) {
    return { anchorPart, resolved: file };
  }

  const targetPath = stripLinkDecorators(filePart);
  const resolved = targetPath.startsWith('/') && !targetPath.startsWith('//')
    ? path.resolve(packageDir, targetPath.slice(1))
    : path.resolve(path.dirname(file), targetPath);
  return { anchorPart, resolved };
}

function checkResolvedLink(packageDir, file, relFile, line, rawTarget) {
  const { anchorPart, resolved } = resolveMarkdownLink(packageDir, file, rawTarget);
  const target = formatLinkTargetForReport(rawTarget);
  if (!isWithinRoot(packageDir, resolved)) {
    return { file: relFile, line, target, reason: 'Link escapes project root' };
  }

  if (!fs.existsSync(resolved)) {
    return { file: relFile, line, target, reason: 'Target file does not exist' };
  }

  if (anchorPart && resolved.endsWith('.md')) {
    const targetContent = fs.readFileSync(resolved, 'utf8');
    const anchors = collectAnchors(targetContent);
    if (!anchors.has(slugHeading(anchorPart))) {
      return { file: relFile, line, target, reason: 'Target anchor does not exist' };
    }
  }

  return null;
}

function checkMarkdownFileLinks(packageDir, file) {
  const brokenLinks = [];
  let linksChecked = 0;
  const content = fs.readFileSync(file, 'utf8');
  const relFile = path.relative(packageDir, file).replaceAll('\\', '/');
  for (const link of findMarkdownLinks(content)) {
    const rawTarget = link.target.trim();
    if (!rawTarget || isExternalLink(rawTarget)) {
      continue;
    }

    linksChecked++;
    const line = lineForIndex(content, link.index);
    const brokenLink = checkResolvedLink(packageDir, file, relFile, line, rawTarget);
    if (brokenLink) {
      brokenLinks.push(brokenLink);
    }
  }

  return { linksChecked, brokenLinks };
}

function checkMarkdownLinks(packageDir) {
  const files = getMarkdownFiles(packageDir);
  const totals = { filesChecked: files.length, linksChecked: 0, brokenLinks: [] };
  for (const file of files) {
    const result = checkMarkdownFileLinks(packageDir, file);
    totals.linksChecked += result.linksChecked;
    totals.brokenLinks.push(...result.brokenLinks);
  }
  return totals;
}

function getSourceFiles(packageDir) {
  const sourceRoots = ['lib', 'bin', 'scripts', 'src', 'apps', 'packages'];
  const files = new Set();
  for (const dir of sourceRoots) {
    for (const file of walkFiles(path.join(packageDir, dir), isJavaScriptSourceFile)) {
      files.add(file);
    }
  }

  return Array.from(files)
    .sort((a, b) => a.localeCompare(b));
}

function isJavaScriptSourceFile(file) {
  if (!['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(path.extname(file))) {
    return false;
  }
  return !/(?:^|[.-])(test|spec)\.[cm]?[jt]sx?$/.test(path.basename(file));
}

function hasLeadingJsDoc(source, comments, node) {
  const previous = comments
    .filter((comment) => comment.end <= node.start)
    .sort((a, b) => b.end - a.end)[0];

  if (previous?.type !== 'CommentBlock' || !previous.value.trim().startsWith('*')) {
    return false;
  }

  return source.slice(previous.end, node.start).trim() === '';
}

function getPublicDocTargets(source, ast) {
  const targets = [];
  for (const node of ast.program.body) {
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
      addDocTargetsFromDeclaration(targets, node.declaration, node);
    } else if (node.type === 'ExpressionStatement') {
      addDocTargetFromCommonJsExport(targets, node);
    } else {
      addDocTargetsFromDeclaration(targets, node);
    }
  }
  return targets.filter((target) => !target.name.startsWith('_'));
}

function addDocTargetsFromDeclaration(targets, node, reportNode = node) {
  if (!node) {
    return;
  }

  if (node.type === 'FunctionDeclaration' && node.id?.name) {
    targets.push({ name: node.id.name, node: reportNode });
  } else if (node.type === 'ClassDeclaration' && node.id?.name) {
    targets.push({ name: node.id.name, node: reportNode });
  } else if (node.type === 'VariableDeclaration') {
    for (const declaration of node.declarations) {
      const initType = declaration.init?.type;
      if (
        declaration.id?.type === 'Identifier' &&
        ['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression'].includes(initType)
      ) {
        targets.push({ name: declaration.id.name, node: reportNode });
      }
    }
  }
}

function addDocTargetFromCommonJsExport(targets, node) {
  const expression = node.expression;
  if (expression?.type !== 'AssignmentExpression') {
    return;
  }

  const initType = expression.right?.type;
  if (!['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression'].includes(initType)) {
    return;
  }

  const name = getCommonJsExportName(expression.left);
  if (name) {
    targets.push({ name, node });
  }
}

function getCommonJsExportName(node) {
  if (node?.type !== 'MemberExpression') {
    return null;
  }

  if (node.object?.type === 'Identifier' && node.object.name === 'exports') {
    return getMemberPropertyName(node);
  }

  if (
    node.object?.type === 'MemberExpression' &&
    node.object.object?.type === 'Identifier' &&
    node.object.object.name === 'module' &&
    getMemberPropertyName(node.object) === 'exports'
  ) {
    return getMemberPropertyName(node);
  }

  if (node.object?.type === 'Identifier' && node.object.name === 'module' && getMemberPropertyName(node) === 'exports') {
    return 'module.exports';
  }

  return null;
}

function getMemberPropertyName(node) {
  if (node.computed) {
    return node.property?.type === 'StringLiteral' ? node.property.value : null;
  }
  return node.property?.type === 'Identifier' ? node.property.name : null;
}

function checkDocstringCoverage(packageDir) {
  const missing = [];
  let total = 0;
  let documented = 0;
  const files = getSourceFiles(packageDir);

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = parse(source, {
        sourceType: 'unambiguous',
        plugins: ['topLevelAwait', 'typescript', 'jsx'],
        attachComment: true,
        locations: true,
        ranges: false,
      });
    } catch (error) {
      total++;
      missing.push({
        file: path.relative(packageDir, file).replaceAll('\\', '/'),
        name: '<parse-error>',
        line: 1,
        reason: error.message,
      });
      continue;
    }

    for (const target of getPublicDocTargets(source, ast)) {
      total++;
      if (hasLeadingJsDoc(source, ast.comments || [], target.node)) {
        documented++;
      } else {
        missing.push({
          file: path.relative(packageDir, file).replaceAll('\\', '/'),
          name: target.name,
          line: target.node.loc?.start?.line || 1,
          reason: 'Missing leading JSDoc block',
        });
      }
    }
  }

  const percent = total === 0 ? 100 : Math.round((documented / total) * 10000) / 100;
  return { filesChecked: files.length, total, documented, percent, missing };
}

function brokenLinkKey(item) {
  return `${item.file}\0${item.line}\0${item.target}\0${item.reason}`;
}

function loadDocsBaseline(packageDir, baselinePath) {
  if (!baselinePath) {
    return new Set();
  }

  const resolved = path.resolve(packageDir, baselinePath);
  if (!fs.existsSync(resolved)) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return new Set((parsed.brokenLinks || []).map(brokenLinkKey));
  } catch (error) {
    throw new Error(`Invalid docs baseline JSON at "${resolved}": ${error.message}`);
  }
}

function writeDocsBaseline(packageDir, baselinePath, result) {
  const resolved = path.resolve(packageDir, baselinePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(
    resolved,
    `${JSON.stringify({
      generatedBy: 'forge docs verify --write-baseline',
      brokenLinks: result.links.allBrokenLinks || result.links.brokenLinks,
    }, null, 2)}\n`,
    'utf8'
  );
}

function validateDocs(packageDir, options = {}) {
  const minDocstringCoverage = Number.isFinite(options.minDocstringCoverage)
    ? options.minDocstringCoverage
    : 0;
  const links = checkMarkdownLinks(packageDir);
  const baseline = loadDocsBaseline(packageDir, options.baselinePath);
  const allBrokenLinks = links.brokenLinks;
  const newBrokenLinks = allBrokenLinks.filter((item) => !baseline.has(brokenLinkKey(item)));
  links.allBrokenLinks = allBrokenLinks;
  links.knownBrokenLinks = allBrokenLinks.length - newBrokenLinks.length;
  links.brokenLinks = newBrokenLinks;
  const docstrings = checkDocstringCoverage(packageDir);
  const failures = [
    ...links.brokenLinks.map((item) => ({ type: 'broken-link', ...item })),
    ...(docstrings.percent < minDocstringCoverage
      ? [{
          type: 'docstring-coverage',
          reason: `Docstring coverage ${docstrings.percent}% is below ${minDocstringCoverage}%`,
        }]
      : []),
  ];

  return {
    ok: failures.length === 0,
    links,
    docstrings,
    failures,
  };
}

function formatDocsValidation(result) {
  const lines = [
    'Forge docs validation',
    '',
    `Markdown files checked: ${result.links.filesChecked}`,
    `Markdown links checked: ${result.links.linksChecked}`,
    `Broken links: ${result.links.brokenLinks.length}`,
    `Known broken links in baseline: ${result.links.knownBrokenLinks || 0}`,
    `Source files checked: ${result.docstrings.filesChecked}`,
    `Docstring coverage: ${result.docstrings.documented}/${result.docstrings.total} (${result.docstrings.percent}%)`,
  ];

  if (result.links.brokenLinks.length > 0) {
    lines.push('', 'Broken links:');
    for (const item of result.links.brokenLinks) {
      lines.push(`  - ${item.file}:${item.line} ${item.target} (${item.reason})`);
    }
  }

  if (result.docstrings.missing.length > 0) {
    lines.push('', 'Missing docstrings:');
    for (const item of result.docstrings.missing.slice(0, 50)) {
      lines.push(`  - ${item.file}:${item.line} ${item.name} (${item.reason})`);
    }
    if (result.docstrings.missing.length > 50) {
      lines.push(`  ... ${result.docstrings.missing.length - 50} more`);
    }
  }

  lines.push('', result.ok ? 'Docs validation passed.' : 'Docs validation failed.');
  return lines.join('\n');
}

module.exports = {
  listTopics,
  getTopicContent,
  validateDocs,
  formatDocsValidation,
  writeDocsBaseline,
  TOPICS,
};
