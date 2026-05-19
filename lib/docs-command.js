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
  return trimmed.startsWith('//') || (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed));
}

function stripLinkDecorators(target) {
  return target
    .trim()
    .replaceAll(/^<|>$/g, '')
    .split(/[?#]/)[0];
}

function slugHeading(heading) {
  return stripMarkdownLinkDestinations(heading)
    .trim()
    .toLowerCase()
    .replaceAll(/[`*_~[\](){}:;'"!?,./\\|+=<>@#$%^&]/g, '')
    .replaceAll(/\s+/g, '-');
}

function stripMarkdownLinkDestinations(text) {
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    const marker = text.indexOf('](', cursor);
    if (marker === -1) {
      result += text.slice(cursor);
      break;
    }

    const labelStart = text.lastIndexOf('[', marker);
    if (labelStart < cursor) {
      result += text.slice(cursor, marker + 2);
      cursor = marker + 2;
      continue;
    }

    const destinationEnd = findMarkdownDestinationEnd(text, marker + 2);
    if (destinationEnd === -1) {
      result += text.slice(cursor);
      break;
    }

    const replacementStart = labelStart > 0 && text[labelStart - 1] === '!' ? labelStart - 1 : labelStart;
    result += text.slice(cursor, replacementStart);
    result += text.slice(labelStart + 1, marker);
    cursor = destinationEnd + 1;
  }

  return result;
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
  const referenceDefinitions = _collectReferenceDefinitions(content);
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
      links.push(...findMarkdownLinksInLine(line, offset, referenceDefinitions));
    }
    offset += line.length + 1;
  }
  return links;
}

function _collectReferenceDefinitions(content) {
  const definitions = new Map();
  let inFence = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    const definition = _getReferenceLinkDefinition(line);
    if (definition) {
      definitions.set(_normalizeReferenceLabel(definition.label), definition.target);
    }
  }
  return definitions;
}

function findMarkdownLinksInLine(line, offset, referenceDefinitions = new Map()) {
  const links = [];
  const referenceDefinition = _getReferenceLinkDefinition(line);
  if (referenceDefinition) {
    links.push({ target: referenceDefinition.target, index: offset });
  }

  let cursor = 0;
  while (cursor < line.length) {
    const start = line.indexOf('](', cursor);
    if (start === -1) {
      break;
    }

    if (isInsideInlineCode(line, start)) {
      cursor = start + 2;
      continue;
    }

    const end = findMarkdownDestinationEnd(line, start + 2);
    if (end === -1) {
      break;
    }

    const target = getMarkdownLinkTarget(line.slice(start + 2, end));
    if (target) {
      links.push({ target, index: offset + start });
    }
    cursor = end + 1;
  }
  links.push(..._findReferenceLinkUsagesInLine(line, offset, referenceDefinitions));
  return links;
}

function _findReferenceLinkUsagesInLine(line, offset, referenceDefinitions) {
  const links = [];
  let cursor = 0;
  while (cursor < line.length) {
    const labelStart = line.indexOf('[', cursor);
    if (labelStart === -1) {
      break;
    }
    if ((labelStart > 0 && line[labelStart - 1] === '!') || isInsideInlineCode(line, labelStart)) {
      cursor = labelStart + 1;
      continue;
    }

    const labelEnd = line.indexOf(']', labelStart + 1);
    if (labelEnd === -1) {
      break;
    }
    if (line[labelEnd + 1] !== '[') {
      cursor = labelEnd + 1;
      continue;
    }

    const referenceEnd = line.indexOf(']', labelEnd + 2);
    if (referenceEnd === -1) {
      break;
    }
    const rawLabel = line.slice(labelEnd + 2, referenceEnd) || line.slice(labelStart + 1, labelEnd);
    const label = _normalizeReferenceLabel(rawLabel);
    const target = referenceDefinitions.get(label);
    if (target) {
      links.push({ target, index: offset + labelStart });
    } else {
      links.push({ missingReference: rawLabel.trim(), index: offset + labelStart });
    }
    cursor = referenceEnd + 1;
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

function isInsideInlineCode(line, index) {
  let cursor = 0;
  while (cursor < index) {
    if (line[cursor] !== '`') {
      cursor++;
      continue;
    }
    if (cursor > 0 && line[cursor - 1] === '\\') {
      cursor++;
      continue;
    }

    const start = cursor;
    while (cursor < line.length && line[cursor] === '`') {
      cursor++;
    }

    const marker = line.slice(start, cursor);
    const end = line.indexOf(marker, cursor);
    if (end === -1) {
      return false;
    }
    if (index > cursor && index < end) {
      return true;
    }
    cursor = end + marker.length;
  }
  return false;
}

function getMarkdownLinkTarget(rawDestination) {
  const trimmed = rawDestination.trim();
  if (trimmed.startsWith('<')) {
    const end = trimmed.indexOf('>');
    return end > 1 ? trimmed.slice(0, end + 1) : trimmed;
  }

  const titleStart = _findUnescapedWhitespaceIndex(trimmed);
  const target = titleStart === -1 ? trimmed : trimmed.slice(0, titleStart);
  return target.replace(/\\([ \t])/g, '$1');
}

function _findUnescapedWhitespaceIndex(text) {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') {
      index++;
      continue;
    }
    if (/\s/.test(text[index])) {
      return index;
    }
  }
  return -1;
}

function _getReferenceLinkDefinition(line) {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('[')) {
    return null;
  }

  const labelEnd = trimmed.indexOf(']:');
  if (labelEnd <= 1) {
    return null;
  }
  if (trimmed.slice(1, labelEnd).startsWith('^')) {
    return null;
  }

  const target = getMarkdownLinkTarget(trimmed.slice(labelEnd + 2));
  return target ? { label: trimmed.slice(1, labelEnd), target } : null;
}

function _normalizeReferenceLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function lineForIndex(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function formatLinkTargetForReport(rawTarget) {
  const normalized = rawTarget.trim().replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    (!path.isAbsolute(normalized) && !/^[A-Za-z]:\//.test(normalized))
  ) {
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

  const targetPath = decodeLocalMarkdownPath(stripLinkDecorators(filePart));
  const resolved = targetPath.startsWith('/') && !targetPath.startsWith('//')
    ? path.resolve(packageDir, targetPath.slice(1))
    : path.resolve(path.dirname(file), targetPath);
  return { anchorPart, resolved };
}

function decodeLocalMarkdownPath(targetPath) {
  try {
    return decodeURI(targetPath);
  } catch {
    return targetPath;
  }
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
    const line = lineForIndex(content, link.index);
    if (link.missingReference) {
      brokenLinks.push({
        file: relFile,
        line,
        target: link.missingReference,
        reason: 'Reference link definition does not exist',
      });
      linksChecked++;
      continue;
    }

    const rawTarget = link.target.trim();
    if (!rawTarget || isExternalLink(rawTarget)) {
      continue;
    }

    linksChecked++;
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
  for (const file of _getRootSourceEntryFiles(packageDir)) {
    files.add(file);
  }
  for (const dir of sourceRoots) {
    for (const file of walkFiles(path.join(packageDir, dir), isJavaScriptSourceFile)) {
      files.add(file);
    }
  }

  return Array.from(files)
    .sort((a, b) => a.localeCompare(b));
}

function _getRootSourceEntryFiles(packageDir) {
  const candidates = new Set([
    'index.js',
    'index.jsx',
    'index.mjs',
    'index.cjs',
    'index.ts',
    'index.tsx',
    'index.mts',
    'index.cts',
  ]);
  for (const entry of _getPackageJsonSourceEntries(packageDir)) {
    candidates.add(entry);
  }

  return Array.from(candidates)
    .map((file) => path.resolve(packageDir, file))
    .filter((file) => isWithinRoot(packageDir, file) && fs.existsSync(file) && isJavaScriptSourceFile(file));
}

function _getPackageJsonSourceEntries(packageDir) {
  const packageJsonPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return [];
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return _collectPackageEntryValues([manifest.main, manifest.module, manifest.browser, manifest.exports]);
  } catch {
    return [];
  }
}

function _collectPackageEntryValues(values) {
  const entries = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    if (typeof value === 'string') {
      entries.push(value);
    } else if (value && typeof value === 'object') {
      entries.push(..._collectPackageEntryValues(Object.values(value)));
    }
  }
  return entries;
}

function isJavaScriptSourceFile(file) {
  if (!['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(path.extname(file))) {
    return false;
  }
  if (hasTestPathSegment(file)) {
    return false;
  }
  return !/(?:^|[.-])(test|spec)\.[cm]?[jt]sx?$/.test(path.basename(file));
}

function hasTestPathSegment(file) {
  return file
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => ['test', 'tests', '__tests__', 'spec', 'specs', '__specs__'].includes(segment));
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

function getPublicDocTargets(_source, ast) {
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

  if (
    reportNode?.type === 'ExportDefaultDeclaration' &&
    [
      'ArrowFunctionExpression',
      'FunctionExpression',
      'ClassExpression',
      'FunctionDeclaration',
      'ClassDeclaration',
    ].includes(node.type)
  ) {
    targets.push({ name: 'default', node: reportNode });
  } else if (node.type === 'FunctionDeclaration' && node.id?.name) {
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
  const name = getCommonJsExportName(expression.left);
  if (!name) {
    return;
  }

  if (['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression'].includes(initType)) {
    targets.push({ name, node });
  } else if (name === 'module.exports' && initType === 'ObjectExpression') {
    addDocTargetsFromObjectExport(targets, expression.right);
  }
}

function addDocTargetsFromObjectExport(targets, node) {
  for (const property of node.properties || []) {
    const hasExportedFunction = property.type === 'ObjectMethod' || (
      property.type === 'ObjectProperty' &&
      ['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression'].includes(property.value?.type)
    );
    if (hasExportedFunction) {
      const name = getObjectPropertyName(property);
      if (name) {
        targets.push({ name: `module.exports.${name}`, node: property });
      }
    }
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

function getObjectPropertyName(node) {
  if (node.computed) {
    return node.key?.type === 'StringLiteral' ? node.key.value : null;
  }
  if (node.key?.type === 'Identifier') {
    return node.key.name;
  }
  return node.key?.type === 'StringLiteral' ? node.key.value : null;
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
        plugins: getParserPlugins(file),
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

function getParserPlugins(file) {
  const ext = path.extname(file).toLowerCase();
  const plugins = ['topLevelAwait'];
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) {
    plugins.push('typescript', ['decorators', { decoratorsBeforeExport: true }]);
  }
  if (['.js', '.mjs', '.jsx', '.tsx'].includes(ext)) {
    plugins.push('jsx');
  }
  return plugins;
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
