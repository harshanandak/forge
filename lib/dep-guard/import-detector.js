const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('@babel/parser');

const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx']);

function toPosixPath(filePath) {
	return filePath.split(path.sep).join('/');
}

function normalizeRepoPath(filePath) {
	return toPosixPath(path.normalize(filePath));
}

function listSourceFiles(rootDir) {
	const results = [];
	const queue = [rootDir];

	while (queue.length > 0) {
		const current = queue.pop();
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.worktrees') {
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
		const matches = task.whatToImplement.match(/[A-Za-z_][A-Za-z0-9_]*\(\)/g) ?? [];
		for (const match of matches) {
			symbols.add(match.slice(0, -2));
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

function walkNode(node, visitor) {
	if (!node || typeof node !== 'object') {
		return;
	}

	visitor(node);

	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				walkNode(item, visitor);
			}
			continue;
		}

		walkNode(value, visitor);
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

	walkNode(ast, (node) => {
		if (node.type === 'ImportDeclaration') {
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

		if (
			node.type === 'VariableDeclarator'
			&& node.init?.type === 'CallExpression'
			&& node.init.callee?.type === 'Identifier'
			&& node.init.callee.name === 'require'
			&& node.init.arguments?.[0]?.type === 'StringLiteral'
		) {
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
			} else if (node.id.type === 'Identifier') {
				defaultImports.set(node.id.name, {
					sourceFile: resolvedSource,
				});
			}
		}

		if (node.type === 'CallExpression') {
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
	});

	return {
		file: relativeFile,
		directImports,
		defaultImports,
		namespaceImports,
		directCalls,
		memberCalls,
	};
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

async function scoreImportDependencies(normalizedInput) {
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

	for (const absoluteFile of listSourceFiles(normalizedInput.repositoryRoot)) {
		const analysis = collectFileAnalysis(absoluteFile, normalizedInput.repositoryRoot);
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
			if (!targetFiles.has(importMeta.sourceFile) || !targetSymbols.has(localName)) {
				continue;
			}

			fileEvidence.push({
				type: 'import',
				consumerFile: analysis.file,
				sourceFile: analysis.file,
				scoreContribution: 1,
				targetFile: importMeta.sourceFile,
				symbol: localName,
			});

			if (analysis.directCalls.has(localName)) {
				fileEvidence.push({
					type: 'call',
					consumerFile: analysis.file,
					sourceFile: analysis.file,
					scoreContribution: 1,
					targetFile: importMeta.sourceFile,
					symbol: localName,
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
	scoreImportDependencies,
};
