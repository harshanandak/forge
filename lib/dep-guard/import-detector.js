const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('@babel/parser');
const { normalizeRepoPath } = require('./path-utils.js');
const { extractSymbols } = require('./task-parser.js');

const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx']);
const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
	'.git',
	'.worktrees',
	'coverage',
	'dist',
	'build',
	'docs',
	'fixtures',
	'node_modules',
	'test',
	'test-env',
]);

function isIdentifierStart(character) {
	return /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character) {
	return /[A-Za-z0-9_]/.test(character);
}

function listSourceFiles(rootDir) {
	const results = [];
	const queue = [rootDir];

	while (queue.length > 0) {
		const current = queue.pop();
		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch (_error) {
			continue;
		}

		for (const entry of entries) {
			if (entry.isDirectory() && DEFAULT_EXCLUDED_DIRECTORIES.has(entry.name)) {
				continue;
			}

			const absolutePath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(absolutePath);
				continue;
			}

			if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
				results.push(absolutePath);
			}
		}
	}

	return results;
}

function extractTargetSymbols(taskContext) {
	const symbols = new Set();

	for (const task of taskContext.tasks) {
		for (const symbol of extractSymbols(task.whatToImplement ?? '')) {
			if (symbol && isIdentifierStart(symbol[0]) && Array.from(symbol).every(isIdentifierPart)) {
				symbols.add(symbol);
			}
		}
	}

	return symbols;
}

function extractTargetFiles(taskContext) {
	const files = new Set();

	for (const task of taskContext.tasks) {
		for (const file of task.files) {
			files.add(normalizeRepoPath(file));
		}
	}

	return files;
}

function resolveImportSource(sourceFile, specifier, repositoryRoot) {
	if (!specifier || typeof specifier !== 'string' || !specifier.startsWith('.')) {
		return null;
	}

	const basePath = path.resolve(path.dirname(sourceFile), specifier);
	const candidates = [
		basePath,
		`${basePath}.js`,
		`${basePath}.cjs`,
		`${basePath}.mjs`,
		`${basePath}.jsx`,
		`${basePath}.ts`,
		`${basePath}.tsx`,
		path.join(basePath, 'index.js'),
		path.join(basePath, 'index.cjs'),
		path.join(basePath, 'index.mjs'),
	];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return normalizeRepoPath(path.relative(repositoryRoot, candidate));
		}
	}

	return null;
}

function isAstNode(value) {
	return Boolean(value) && typeof value === 'object' && typeof value.type === 'string';
}

function walkNode(node, visitor) {
	if (!isAstNode(node)) {
		return;
	}

	visitor(node);

	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				if (isAstNode(item)) {
					walkNode(item, visitor);
				}
			}
			continue;
		}

		if (isAstNode(value)) {
			walkNode(value, visitor);
		}
	}
}

function collectFileAnalysis(filePath, repositoryRoot) {
	const relativeFile = normalizeRepoPath(path.relative(repositoryRoot, filePath));
	const content = fs.readFileSync(filePath, 'utf8');
	const ast = parse(content, {
		sourceType: 'unambiguous',
		errorRecovery: true,
		plugins: ['jsx', 'typescript'],
	});

	const directImports = new Map();
	const defaultImports = new Map();
	const namespaceImports = new Map();
	const directCalls = new Set();
	const memberCalls = [];
	const defaultExportSymbols = new Set();

	walkNode(ast, (node) => {
		recordImportDeclaration(node, filePath, repositoryRoot, directImports, defaultImports, namespaceImports);
		recordRequireDeclarator(node, filePath, repositoryRoot, directImports, defaultImports, namespaceImports);
		recordCallExpression(node, directCalls, memberCalls);
		recordDefaultExport(node, defaultExportSymbols);
	});

	return {
		file: relativeFile,
		directImports,
		defaultImports,
		namespaceImports,
		directCalls,
		memberCalls,
		defaultExportSymbols,
	};
}

function recordImportDeclaration(node, filePath, repositoryRoot, directImports, defaultImports, namespaceImports) {
	if (node.type !== 'ImportDeclaration') {
		return;
	}

	const resolvedSource = resolveImportSource(filePath, node.source?.value, repositoryRoot);
	if (!resolvedSource) {
		return;
	}

	for (const specifier of node.specifiers ?? []) {
		if (specifier.type === 'ImportSpecifier') {
			directImports.set(specifier.local.name, {
				sourceFile: resolvedSource,
				importedName: specifier.imported.name,
			});
		} else if (specifier.type === 'ImportDefaultSpecifier' && specifier.local?.name) {
			defaultImports.set(specifier.local.name, {
				sourceFile: resolvedSource,
			});
		} else if (specifier.local?.name) {
			namespaceImports.set(specifier.local.name, {
				sourceFile: resolvedSource,
			});
		}
	}
}

function recordRequireDeclarator(node, filePath, repositoryRoot, directImports, defaultImports, namespaceImports) {
	if (
		node.type !== 'VariableDeclarator'
		|| node.init?.type !== 'CallExpression'
		|| node.init.callee?.type !== 'Identifier'
		|| node.init.callee.name !== 'require'
		|| node.init.arguments?.[0]?.type !== 'StringLiteral'
	) {
		return;
	}

	const resolvedSource = resolveImportSource(
		filePath,
		node.init.arguments[0].value,
		repositoryRoot,
	);
	if (!resolvedSource) {
		return;
	}

	if (node.id.type === 'ObjectPattern') {
		for (const property of node.id.properties ?? []) {
			if (property.type !== 'ObjectProperty' || property.value?.type !== 'Identifier') {
				continue;
			}

			const importedName = property.key?.name ?? property.key?.value;
			if (!importedName) {
				continue;
			}

			directImports.set(property.value.name, {
				sourceFile: resolvedSource,
				importedName,
			});
		}
		return;
	}

	if (node.id.type === 'Identifier') {
		defaultImports.set(node.id.name, {
			sourceFile: resolvedSource,
		});
		namespaceImports.set(node.id.name, {
			sourceFile: resolvedSource,
		});
	}
}

function recordCallExpression(node, directCalls, memberCalls) {
	if (node.type !== 'CallExpression') {
		return;
	}

	if (node.callee?.type === 'Identifier') {
		directCalls.add(node.callee.name);
		return;
	}

	if (
		node.callee?.type === 'MemberExpression'
		&& node.callee.object?.type === 'Identifier'
		&& !node.callee.computed
		&& node.callee.property?.type === 'Identifier'
	) {
		memberCalls.push({
			objectName: node.callee.object.name,
			propertyName: node.callee.property.name,
		});
	}
}

function recordDefaultExport(node, defaultExportSymbols) {
	if (node.type === 'ExportDefaultDeclaration') {
		if (node.declaration?.type === 'Identifier') {
			defaultExportSymbols.add(node.declaration.name);
			return;
		}

		if (
			(node.declaration?.type === 'FunctionDeclaration' || node.declaration?.type === 'ClassDeclaration')
			&& node.declaration.id?.name
		) {
			defaultExportSymbols.add(node.declaration.id.name);
		}
		return;
	}

	if (
		node.type === 'AssignmentExpression'
		&& node.operator === '='
		&& node.left?.type === 'MemberExpression'
		&& node.left.object?.type === 'Identifier'
		&& node.left.object.name === 'module'
		&& !node.left.computed
		&& node.left.property?.type === 'Identifier'
		&& node.left.property.name === 'exports'
	) {
		if (node.right?.type === 'Identifier') {
			defaultExportSymbols.add(node.right.name);
			return;
		}

		if (
			(node.right?.type === 'FunctionExpression' || node.right?.type === 'ClassExpression')
			&& node.right.id?.name
		) {
			defaultExportSymbols.add(node.right.id.name);
		}
	}
}

function issueTouchesFile(issue, filePath) {
	if (issue.files.includes(filePath)) {
		return true;
	}

	return issue.contracts.some((contract) => typeof contract === 'string' && contract.startsWith(`${filePath}:`));
}

function mergeEvidence(evidence) {
	const seen = new Set();
	return evidence.filter((item) => {
		const key = `${item.type}:${item.consumerFile}:${item.targetFile}:${item.symbol}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function scoreImportDependencies(normalizedInput) {
	const targetSymbols = extractTargetSymbols(normalizedInput.taskContext);
	const targetFiles = extractTargetFiles(normalizedInput.taskContext);

	if (targetSymbols.size === 0 || targetFiles.size === 0) {
		return {
			score: 0,
			findings: [],
			evidence: [],
		};
	}

	const findings = [];
	const evidence = [];
	const analyses = [];

	for (const absoluteFile of listSourceFiles(normalizedInput.repositoryRoot)) {
		let analysis;
		try {
			analysis = collectFileAnalysis(absoluteFile, normalizedInput.repositoryRoot);
		} catch (_error) {
			continue;
		}
		analyses.push(analysis);
	}

	const defaultExportSymbolsByFile = new Map(
		analyses.map((analysis) => [analysis.file, analysis.defaultExportSymbols]),
	);

	for (const analysis of analyses) {
		const fileEvidence = [];

		for (const [localName, importMeta] of analysis.directImports.entries()) {
			if (!targetFiles.has(importMeta.sourceFile) || !targetSymbols.has(importMeta.importedName)) {
				continue;
			}

			fileEvidence.push({
				type: 'import',
				consumerFile: analysis.file,
				sourceFile: analysis.file,
				scoreContribution: 1,
				targetFile: importMeta.sourceFile,
				symbol: importMeta.importedName,
			});

			if (analysis.directCalls.has(localName)) {
				fileEvidence.push({
					type: 'call',
					consumerFile: analysis.file,
					sourceFile: analysis.file,
					scoreContribution: 1,
					targetFile: importMeta.sourceFile,
					symbol: importMeta.importedName,
				});
			}
		}

		for (const [localName, importMeta] of analysis.defaultImports.entries()) {
			if (!targetFiles.has(importMeta.sourceFile)) {
				continue;
			}

			const defaultExportSymbols = defaultExportSymbolsByFile.get(importMeta.sourceFile) ?? new Set();
			const matchedSymbol = targetSymbols.has(localName)
				? localName
				: Array.from(defaultExportSymbols).find((symbol) => targetSymbols.has(symbol));

			if (!matchedSymbol) {
				continue;
			}

			fileEvidence.push({
				type: 'import',
				consumerFile: analysis.file,
				sourceFile: analysis.file,
				scoreContribution: 1,
				targetFile: importMeta.sourceFile,
				symbol: matchedSymbol,
			});

			if (analysis.directCalls.has(localName)) {
				fileEvidence.push({
					type: 'call',
					consumerFile: analysis.file,
					sourceFile: analysis.file,
					scoreContribution: 1,
					targetFile: importMeta.sourceFile,
					symbol: matchedSymbol,
				});
			}
		}

		for (const memberCall of analysis.memberCalls) {
			const namespaceImport = analysis.namespaceImports.get(memberCall.objectName);
			if (!namespaceImport) {
				continue;
			}

			if (!targetFiles.has(namespaceImport.sourceFile) || !targetSymbols.has(memberCall.propertyName)) {
				continue;
			}

			fileEvidence.push({
				type: 'call',
				consumerFile: analysis.file,
				sourceFile: analysis.file,
				scoreContribution: 1,
				targetFile: namespaceImport.sourceFile,
				symbol: memberCall.propertyName,
			});
		}

		if (fileEvidence.length === 0) {
			continue;
		}

		const touchedIssues = normalizedInput.openIssues.filter((issue) => issueTouchesFile(issue, analysis.file));
		for (const issue of touchedIssues) {
			const issueEvidence = mergeEvidence(fileEvidence);
			const score = issueEvidence.length;

			findings.push({
				sourceIssueId: normalizedInput.currentIssue.id,
				targetIssueId: issue.id,
				score,
				evidence: issueEvidence,
			});
			evidence.push(...issueEvidence);
		}
	}

	return {
		score: findings.reduce((total, finding) => total + finding.score, 0),
		findings,
		evidence: mergeEvidence(evidence),
	};
}

module.exports = {
	normalizeRepoPath,
	scoreImportDependencies,
};
