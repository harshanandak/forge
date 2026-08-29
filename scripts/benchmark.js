#!/usr/bin/env node

const { execFileSync, spawnSync: defaultSpawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { buildProfile, parseJUnitFiles, walk } = require('./test-profile');
const { stableStringify } = require('../lib/kernel/evaluators');
const { contentHash } = require('../lib/file-hash');

const rootDir = path.join(__dirname, '..');
const DEFAULT_OUTPUT = path.join(rootDir, 'test-results', 'benchmark-results.json');
const DEFAULT_PROFILE_DIR = path.join(rootDir, 'test-results', 'benchmark-profiles');
const DEFAULT_WARMUPS = 3;
const DEFAULT_SAMPLES = 30;
const LATENCY_CAP = 1.25;
const TOKENS_CAP = 1.20;
const MEMORY_RECALL_TEST_PATTERN = '^(?!(?:.*real locked SQLite prompt recall fails open below its deadline|.*assembled 1,000-row recall keeps 100-sample p95 within 250ms)$).*';
const BENCHMARK_CORPUS_PATHS = Object.freeze([
  'test/e2e/memory-recall-holdout.test.js',
  'test/kernel/broker-concurrency.test.js',
  'test/kernel/readiness-model.test.js',
  'test/memory-recall.test.js',
]);
const ALLOWED_UNTRACKED_ROOTS = Object.freeze(['.forge', '.pi', 'docs/work', 'test-results']);

const BENCHMARK_GROUPS = [
  {
    id: 'full-suite',
    label: 'Whole suite',
    command: ['bun', 'test'],
  },
  {
    id: 'pre-push-runner',
    label: 'Pre-push runner slice',
    command: ['bun', 'test', 'test/scripts/test-runner.test.js'],
  },
  {
    id: 'validation-core',
    label: 'Validation core slice',
    command: [
      'bun',
      'test',
      'test/scripts/test-profile.test.js',
      'test/scripts/test-ci-shard.test.js',
      'test/scripts/test-runner.test.js',
    ],
  },
  {
    id: 'hotspot-shell',
    label: 'Hotspot shell slice',
    command: [
      'bun',
      'test',
      'test/scripts/smart-status.conflicts.files.test.js',
      'test/scripts/smart-status.conflicts.merge-tree.test.js',
      'test/scripts/dep-guard.check-ripple.basic.test.js',
    ],
  },
  {
    id: 'validate',
    label: 'Validate command',
    command: ['bash', 'scripts/validate.sh'],
  },
  {
    id: 'kernel-core',
    label: 'Kernel core slice',
    command: [
      'bun',
      'test',
      'test/kernel/readiness-model.test.js',
      'test/kernel/broker-concurrency.test.js',
    ],
  },
  {
    id: 'memory-recall',
    label: 'Memory recall slice',
    command: [
      'bun',
      'test',
      'test/memory-recall.test.js',
      'test/e2e/memory-recall-holdout.test.js',
      '--test-name-pattern',
      MEMORY_RECALL_TEST_PATTERN,
    ],
  },
];

function parseArgs(argv) {
  const args = {
    groups: [],
    json: false,
    output: DEFAULT_OUTPUT,
    profileDir: DEFAULT_PROFILE_DIR,
    warmups: DEFAULT_WARMUPS,
    samples: DEFAULT_SAMPLES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--json') args.json = true;
    if (current === '--output') args.output = next;
    if (current === '--profile-dir') args.profileDir = next;
    if (current === '--warmups') {
      const warmups = Number.parseInt(next, 10);
      args.warmups = Number.isInteger(warmups) ? warmups : DEFAULT_WARMUPS;
    }
    if (current === '--samples') {
      const samples = Number.parseInt(next, 10);
      args.samples = Number.isInteger(samples) ? samples : DEFAULT_SAMPLES;
    }
    if (current === '--group') args.groups.push(next);
  }

  return args;
}

function resolveGroups(groupIds = []) {
  if (groupIds.length === 0) {
    return BENCHMARK_GROUPS.map((group) => ({ ...group, command: [...group.command] }));
  }

  const byId = new Map(BENCHMARK_GROUPS.map((group) => [group.id, group]));
  const resolved = [];
  for (const id of groupIds) {
    const match = byId.get(id);
    if (!match) {
      throw new Error(`Unknown benchmark group: ${id}`);
    }
    resolved.push({ ...match, command: [...match.command] });
  }
  return resolved;
}

function roundMs(value) {
  return Math.round(value);
}

function calculateMedian(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return roundMs((sorted[middle - 1] + sorted[middle]) / 2);
  }
  return sorted[middle];
}

function summarizeSamples(samplesMs) {
  if (samplesMs.length === 0) {
    return {
      coefficientOfVariation: 0,
      maxMs: 0,
      meanMs: 0,
      medianMs: 0,
      minMs: 0,
      p95Ms: 0,
      samplesMs: [],
    };
  }
  const total = samplesMs.reduce((sum, value) => sum + value, 0);
  const mean = total / samplesMs.length;
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const variance = samplesMs.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
    / samplesMs.length;
  return {
    coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / mean,
    maxMs: Math.max(...samplesMs),
    meanMs: roundMs(mean),
    medianMs: calculateMedian(samplesMs),
    minMs: Math.min(...samplesMs),
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samplesMs,
  };
}

function buildJUnitCommand(command, junitPath) {
  const [binary, subcommand, ...rest] = command;
  if (binary === 'bun' && subcommand === 'test') {
    return [
      binary,
      subcommand,
      ...rest,
      '--reporter=junit',
      '--reporter-outfile',
      junitPath,
    ];
  }
  return [...command];
}

function runCommand(command, options = {}, spawnSync = defaultSpawnSync) {
  const [binary, ...args] = command;
  const result = spawnSync(binary, args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || `Command failed: ${command.join(' ')}`);
  }

  return result;
}

function materializeJUnitFile(expectedPath, defaultJunitPath = null) {
  if (fs.existsSync(expectedPath)) {
    return expectedPath;
  }

  if (defaultJunitPath !== null && fs.existsSync(defaultJunitPath)) {
    fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
    fs.copyFileSync(defaultJunitPath, expectedPath);
    return expectedPath;
  }

  throw new Error(`Benchmark run did not produce JUnit output at ${expectedPath}`);
}

function removeMaterializedOutputs(expectedPath) {
	const directory = path.dirname(expectedPath);
	const extension = path.extname(expectedPath);
	const basename = path.basename(expectedPath, extension);

	if (!fs.existsSync(directory)) {
		return;
	}

	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(extension)) {
			continue;
		}

		if (entry.name === `${basename}${extension}` || entry.name.startsWith(`${basename}.`)) {
			fs.rmSync(path.join(directory, entry.name), { force: true });
		}
	}
}

function indexXmlFiles(directory) {
	return new Map(
		walk(directory, '.xml').map((filePath) => {
			const stats = fs.statSync(filePath);
			return [filePath, `${stats.size}:${stats.mtimeMs}`];
		}),
	);
}

function listChangedXmlFiles(directory, beforeIndex) {
	return walk(directory, '.xml')
		.filter((filePath) => {
			const stats = fs.statSync(filePath);
			const fingerprint = `${stats.size}:${stats.mtimeMs}`;
			return beforeIndex.get(filePath) !== fingerprint;
		})
		.sort((left, right) => left.localeCompare(right));
}

function materializeJUnitFiles(expectedPath, sourceFiles, defaultJunitPath = null) {
	const uniqueSources = [];
	const seen = new Set();

	for (const sourceFile of sourceFiles) {
		if (typeof sourceFile !== 'string' || seen.has(sourceFile) || !fs.existsSync(sourceFile)) {
			continue;
		}
		seen.add(sourceFile);
		uniqueSources.push(sourceFile);
	}

	if (uniqueSources.length === 0) {
		return [materializeJUnitFile(expectedPath, defaultJunitPath)];
	}

	return uniqueSources.map((sourceFile, index) => {
		const destination = index === 0
			? expectedPath
			: expectedPath.replace(/\.xml$/, `.${index + 1}.xml`);

		if (sourceFile === destination) {
			return destination;
		}

		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(sourceFile, destination);
		return destination;
	});
}

function buildGroupProfile(group, xmlFiles) {
  const metrics = parseJUnitFiles(xmlFiles);
  return buildProfile({
    integrationSkipped: true,
    label: `benchmark-${group.id}`,
  }, metrics);
}

function runBenchmarkGroup(group, options = {}) {
  const profileDir = path.resolve(rootDir, options.profileDir || DEFAULT_PROFILE_DIR);
  const warmups = options.warmups ?? 0;
  const samples = options.samples ?? DEFAULT_SAMPLES;
  const spawnSync = options.spawnSync || defaultSpawnSync;
  const defaultJunitPath = options.defaultJunitPath ?? null;

  fs.mkdirSync(profileDir, { recursive: true });

  const xmlFiles = [];
  const samplesMs = [];

  for (let warmupIndex = 0; warmupIndex < warmups; warmupIndex += 1) {
    const junitPath = path.join(profileDir, `${group.id}.warmup-${warmupIndex + 1}.xml`);
    removeMaterializedOutputs(junitPath);
    if (defaultJunitPath !== null) {
      fs.rmSync(defaultJunitPath, { force: true });
    }
    runCommand(buildJUnitCommand(group.command, junitPath), {}, spawnSync);
    removeMaterializedOutputs(junitPath);
    if (defaultJunitPath !== null) {
      fs.rmSync(defaultJunitPath, { force: true });
    }
  }

  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
    const junitPath = path.join(profileDir, `${group.id}.sample-${sampleIndex + 1}.xml`);
    removeMaterializedOutputs(junitPath);
    if (defaultJunitPath !== null) {
      fs.rmSync(defaultJunitPath, { force: true });
    }
    const beforeXmlFiles = indexXmlFiles(path.join(rootDir, 'test-results'));
    const command = buildJUnitCommand(group.command, junitPath);
    const start = performance.now();
    runCommand(command, {}, spawnSync);
    samplesMs.push(roundMs(performance.now() - start));
    const changedXmlFiles = listChangedXmlFiles(path.join(rootDir, 'test-results'), beforeXmlFiles);
    xmlFiles.push(...materializeJUnitFiles(junitPath, [
      fs.existsSync(junitPath) ? junitPath : null,
      ...changedXmlFiles,
    ], defaultJunitPath));
  }

  const summary = summarizeSamples(samplesMs);
  const profile = buildGroupProfile(group, xmlFiles);
  const profilePath = path.join(profileDir, `${group.id}.profile.json`);
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));

  return {
    command: group.command.join(' '),
    groupId: group.id,
    groupLabel: group.label,
    profilePath: path.relative(rootDir, profilePath).replace(/\\/g, '/'),
    warmups,
    samples,
    commandArgs: [...group.command],
    ...summary,
  };
}

function runFileCommand(binary, args, exec = execFileSync) {
  return String(exec(binary, args, { cwd: rootDir, encoding: 'utf8' })).trim();
}

function readSourceSha(exec = execFileSync) {
  const sourceSha = runFileCommand('git', ['rev-parse', '--verify', 'HEAD'], exec);
  if (!isSha(sourceSha, 40)) throw new Error('Benchmark HEAD did not resolve to a full source SHA');
  return sourceSha;
}

function readBunVersion(exec = execFileSync) {
  const version = runFileCommand('bun', ['--version'], exec);
  if (!version) throw new Error('Bun CLI version could not be resolved');
  return version;
}

function canonicalCorpusEvidence(corpus) {
  if (!corpus || corpus.version !== 1 || !Array.isArray(corpus.files)) {
    throw new Error('Benchmark corpus evidence is invalid');
  }

  const files = corpus.files.map((file) => {
    if (!file || typeof file.path !== 'string' || !isSha(file.blob, 40)) {
      throw new Error('Benchmark corpus evidence contains an invalid blob');
    }
    return { path: file.path, blob: file.blob.toLowerCase() };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error('Benchmark corpus evidence contains duplicate paths');
  }
  return { version: 1, files };
}

function readBenchmarkCorpus(exec = execFileSync) {
  const output = runFileCommand('git', ['ls-tree', '-r', 'HEAD', '--', ...BENCHMARK_CORPUS_PATHS], exec);
  const files = output ? output.split(/\r?\n/).map((line) => {
    const [metadata, filePath] = line.split('\t');
    const [, type, blob] = (metadata || '').split(/\s+/);
    if (type !== 'blob' || !filePath) throw new Error('Benchmark corpus contains an untracked or non-blob path');
    return { path: filePath, blob };
  }) : [];
  const corpus = canonicalCorpusEvidence({ version: 1, files });
  if (corpus.files.length !== BENCHMARK_CORPUS_PATHS.length
    || corpus.files.some((file, index) => file.path !== BENCHMARK_CORPUS_PATHS[index])) {
    throw new Error('Benchmark corpus is not fully tracked at HEAD');
  }
  return corpus;
}

function benchmarkCorpusContentHash(corpus) {
  return contentHash(stableStringify(canonicalCorpusEvidence(corpus)));
}

function isBenchmarkCorpus(corpus) {
  const canonical = canonicalCorpusEvidence(corpus);
  return canonical.files.length === BENCHMARK_CORPUS_PATHS.length
    && canonical.files.every((file, index) => file.path === BENCHMARK_CORPUS_PATHS[index]);
}

function buildBenchmarkConfig(groups, samples, warmups = DEFAULT_WARMUPS) {
  return {
    groups: groups.map((group) => ({ id: group.id, command: [...group.command] })),
    samples,
    warmups,
  };
}

function buildBenchmarkConfigHash(groupsOrConfig, samples, warmups = DEFAULT_WARMUPS) {
  const config = Array.isArray(groupsOrConfig)
    ? buildBenchmarkConfig(groupsOrConfig, samples, warmups)
    : groupsOrConfig;
  return contentHash(stableStringify(config));
}

function buildBenchmarkIdentity(overrides = {}) {
  const exec = overrides.execFileSync || execFileSync;
  const runtime = overrides.runtime || {
    node: process.versions.node,
    bun: readBunVersion(exec),
  };
  const platform = overrides.platform || {
    platform: process.platform,
    arch: process.arch,
  };
  const corpus = canonicalCorpusEvidence(overrides.corpus || readBenchmarkCorpus(exec));

  return {
    source_sha: overrides.source_sha || readSourceSha(exec),
    runtime: { ...runtime },
    platform: { ...platform },
    corpus,
    corpus_hash: benchmarkCorpusContentHash(corpus),
  };
}

function hashableBenchmarkResults(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== 'timestamp' && key !== 'content_hash'),
  );
}

function benchmarkResultContentHash(payload) {
  return contentHash(stableStringify(hashableBenchmarkResults(payload)));
}

function isIsoTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function canonicalBenchmarkConfig(config) {
  if (!config || !Array.isArray(config.groups)
    || !Number.isInteger(config.samples) || config.samples <= 0
    || !Number.isInteger(config.warmups) || config.warmups < 0) {
    return null;
  }
  const canonical = {
    groups: config.groups.map((group) => ({
      id: group.id,
      command: [...group.command],
    })),
    samples: config.samples,
    warmups: config.warmups,
  };
  if (canonical.groups.some((group) => typeof group.id !== 'string'
    || !Array.isArray(group.command) || group.command.some((token) => typeof token !== 'string'))
    || stableStringify(canonical) !== stableStringify(config)) {
    return null;
  }
  return canonical;
}

function isSha(value, length) {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value);
}

function verifyBenchmarkResult(payload) {
  try {
    const config = canonicalBenchmarkConfig(payload?.config);
    const corpus = canonicalCorpusEvidence(payload?.corpus);
    const results = payload?.groups;
    const expectedGroups = config?.groups || [];
    const expectedGroupIds = expectedGroups.map((group) => group.id);
    const allResultsHaveFiniteTokens = Array.isArray(results)
      && results.length > 0
      && results.every((result) => Number.isFinite(result.tokens));
    const noResultsHaveTokens = Array.isArray(results)
      && results.every((result) => result.tokens === undefined);
    const expectedSlowestResult = Array.isArray(results) && results.length > 0
      ? [...results]
        .sort((left, right) => right.medianMs - left.medianMs || left.groupId.localeCompare(right.groupId))[0]
      : null;
    const expectedSlowestGroup = expectedSlowestResult
      ? {
        groupId: expectedSlowestResult.groupId,
        groupLabel: expectedSlowestResult.groupLabel,
        medianMs: expectedSlowestResult.medianMs,
      }
      : null;
    const expectedTotalMedianMs = Array.isArray(results)
      ? results.reduce((sum, result) => sum + result.medianMs, 0)
      : NaN;
    const tokensMatch = allResultsHaveFiniteTokens
      ? Number.isFinite(payload.totalTokens)
        && payload.totalTokens === results.reduce((sum, result) => sum + result.tokens, 0)
      : noResultsHaveTokens && !Object.hasOwn(payload, 'totalTokens');
    return Boolean(payload && isIsoTimestamp(payload.timestamp) && isSha(payload.source_sha, 40)
      && payload.runtime && typeof payload.runtime.node === 'string'
      && typeof payload.runtime.bun === 'string'
      && payload.platform && typeof payload.platform.platform === 'string'
      && typeof payload.platform.arch === 'string'
      && payload.samples === config?.samples
      && payload.warmups === config?.warmups
      && Array.isArray(payload.requestedGroups)
      && stableStringify(payload.requestedGroups) === stableStringify(expectedGroupIds)
      && Array.isArray(results)
      && results.length === expectedGroups.length
      && results.every((result, index) => {
        const samplesMs = result?.samplesMs;
        const summary = Array.isArray(samplesMs)
          && samplesMs.length > 0
          && samplesMs.every((value) => Number.isFinite(value) && value >= 0)
          ? summarizeSamples(samplesMs)
          : null;
        return result
          && result.groupId === expectedGroups[index].id
          && result.command === expectedGroups[index].command.join(' ')
          && Array.isArray(result.commandArgs)
          && stableStringify(result.commandArgs) === stableStringify(expectedGroups[index].command)
          && result.warmups === config.warmups
          && result.samples === config.samples
          && summary
          && result.samples === summary.samplesMs.length
          && result.minMs === summary.minMs
          && result.maxMs === summary.maxMs
          && result.meanMs === summary.meanMs
          && result.p95Ms === summary.p95Ms
          && result.coefficientOfVariation === summary.coefficientOfVariation
          && result.medianMs === summary.medianMs;
      })
      && Number.isFinite(payload.totalMedianMs)
      && payload.totalMedianMs === expectedTotalMedianMs
      && stableStringify(payload.slowestGroup) === stableStringify(expectedSlowestGroup)
      && tokensMatch
      && config && isSha(payload.config_hash, 64)
      && payload.config_hash === buildBenchmarkConfigHash(config)
      && isBenchmarkCorpus(corpus) && isSha(payload.corpus_hash, 64)
      && payload.corpus_hash === benchmarkCorpusContentHash(corpus)
      && isSha(payload.content_hash, 64)
      && payload.content_hash === benchmarkResultContentHash(payload));
  } catch {
    return false;
  }
}

function benchmarkMetrics(payload) {
  if (!Array.isArray(payload.groups) || payload.groups.length === 0
    || !Number.isFinite(payload.totalMedianMs) || payload.totalMedianMs <= 0) {
    return null;
  }

  const medians = payload.groups.map((group) => group.medianMs);
  const tokens = payload.groups.map((group) => group.tokens);
  if (!medians.every((value) => Number.isFinite(value) && value > 0)
    || !tokens.every((value) => Number.isFinite(value) && value > 0)
    || !Number.isFinite(payload.totalTokens) || payload.totalTokens <= 0) {
    return null;
  }

  const totalMedianMs = medians.reduce((sum, value) => sum + value, 0);
  const totalTokens = tokens.reduce((sum, value) => sum + value, 0);
  if (payload.totalMedianMs !== totalMedianMs || payload.totalTokens !== totalTokens) {
    return null;
  }

  return { totalMedianMs, totalTokens };
}

function compareBenchmarkResults(base, candidate) {
  if (!verifyBenchmarkResult(base) || !verifyBenchmarkResult(candidate)) {
    return { status: 'INCOMPLETE', reason: 'invalid-content-or-identity-hash' };
  }
  if (stableStringify(base.runtime) !== stableStringify(candidate.runtime)
    || stableStringify(base.platform) !== stableStringify(candidate.platform)
    || base.config_hash !== candidate.config_hash
    || base.corpus_hash !== candidate.corpus_hash) {
    return { status: 'INCOMPLETE', reason: 'incomparable-runtime-platform-config-or-corpus' };
  }

  const baseMetrics = benchmarkMetrics(base);
  const candidateMetrics = benchmarkMetrics(candidate);
  if (!baseMetrics || !candidateMetrics) {
    return { status: 'INCOMPLETE', reason: 'missing-or-nonpositive-metrics-or-token-evidence' };
  }

  const latencyRatio = candidateMetrics.totalMedianMs / baseMetrics.totalMedianMs;
  const tokenRatio = candidateMetrics.totalTokens / baseMetrics.totalTokens;
  const latencyWithinCap = latencyRatio <= LATENCY_CAP;
  const tokensWithinCap = tokenRatio <= TOKENS_CAP;
  return {
    status: latencyWithinCap && tokensWithinCap ? 'PASS' : 'FAIL',
    latencyRatio,
    tokenRatio,
    caps: { latency: LATENCY_CAP, tokens: TOKENS_CAP },
    reasons: [
      ...(latencyWithinCap ? [] : ['latency_cap']),
      ...(tokensWithinCap ? [] : ['tokens_cap']),
    ],
  };
}

function buildBenchmarkResults(groups, results, timestamp = new Date().toISOString(), identity = {}) {
  const samples = results[0]?.samples ?? DEFAULT_SAMPLES;
  const warmups = results[0]?.warmups ?? DEFAULT_WARMUPS;
  const normalizedResults = results.map((result, index) => ({
    ...result,
    warmups: result.warmups ?? warmups,
    commandArgs: result.commandArgs ?? [...groups[index].command],
  }));
  const config = buildBenchmarkConfig(groups, samples, warmups);
  const totalMedianMs = normalizedResults.reduce((sum, result) => sum + result.medianMs, 0);
  const slowestGroup = [...normalizedResults]
    .sort((left, right) => right.medianMs - left.medianMs || left.groupId.localeCompare(right.groupId))[0] || null;

  const payload = {
    groups: normalizedResults,
    requestedGroups: groups.map((group) => group.id),
    samples,
    warmups,
    slowestGroup: slowestGroup
      ? { groupId: slowestGroup.groupId, groupLabel: slowestGroup.groupLabel, medianMs: slowestGroup.medianMs }
      : null,
    timestamp,
    totalMedianMs,
    config,
    config_hash: buildBenchmarkConfigHash(config),
    ...buildBenchmarkIdentity(identity),
  };

  if (normalizedResults.length > 0 && normalizedResults.every((result) => Number.isFinite(result.tokens))) {
    payload.totalTokens = normalizedResults.reduce((sum, result) => sum + result.tokens, 0);
  }
  payload.content_hash = benchmarkResultContentHash(payload);
  return payload;
}

function assertBenchmarkSourceReady(exec = execFileSync) {
  const sourceSha = readSourceSha(exec);
  const status = runFileCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], exec);
  const lines = status ? status.split(/\r?\n/).filter(Boolean) : [];
  const trackedChanges = lines.filter((line) => !line.startsWith('?? '));
  if (trackedChanges.length > 0) {
    throw new Error('Benchmark source is dirty; commit tracked changes before benchmarking');
  }
  const unsafeUntracked = lines
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim().replace(/\\/g, '/'))
    .filter((filePath) => {
      const allowedRoot = ALLOWED_UNTRACKED_ROOTS.some((root) => filePath === root || filePath.startsWith(`${root}/`));
      return !allowedRoot || /\.(?:[cm]?[jt]sx?)$/i.test(filePath);
    });
  if (unsafeUntracked.length > 0) {
    throw new Error(`Benchmark source has untracked code or test input: ${unsafeUntracked[0]}`);
  }
  const corpus = readBenchmarkCorpus(exec);
  return { source_sha: sourceSha, corpus };
}

function formatResultLine(result) {
  return `  ${result.groupLabel}: median ${result.medianMs}ms (min ${result.minMs}ms, max ${result.maxMs}ms)`;
}

function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const groups = resolveGroups(args.groups);
  const warmups = Math.max(DEFAULT_WARMUPS, args.warmups);
  const samples = Math.max(DEFAULT_SAMPLES, args.samples);
  const source = assertBenchmarkSourceReady(deps.gitExec || execFileSync);
  const results = groups.map((group) => runBenchmarkGroup(group, {
    defaultJunitPath: deps.defaultJunitPath,
    profileDir: args.profileDir,
    warmups,
    samples,
    spawnSync: deps.spawnSync,
  }));
  const sourceAfter = assertBenchmarkSourceReady(deps.gitExec || execFileSync);
  if (sourceAfter.source_sha !== source.source_sha
    || stableStringify(sourceAfter.corpus) !== stableStringify(source.corpus)) {
    throw new Error('Benchmark source snapshot changed during benchmark');
  }

  const payload = buildBenchmarkResults(groups, results, undefined, {
    ...source,
    ...(deps.identity || {}),
    source_sha: source.source_sha,
    corpus: source.corpus,
  });
  const outputPath = path.resolve(rootDir, args.output || DEFAULT_OUTPUT);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));

  if (args.json) {
    process.stdout.write(JSON.stringify(payload));
    return payload;
  }

  console.log('\n  Forge Test Benchmark Baselines');
  console.log('  =============================\n');
  for (const result of results) {
    console.log(formatResultLine(result));
  }
  console.log(`\n  Total median: ${payload.totalMedianMs}ms`);
  console.log(`  Results saved to: ${path.relative(rootDir, outputPath).replace(/\\/g, '/')}\n`);
  return payload;
}

if (require.main === module) {
  main();
}

module.exports = {
  BENCHMARK_GROUPS,
  DEFAULT_OUTPUT,
  DEFAULT_PROFILE_DIR,
  DEFAULT_WARMUPS,
  DEFAULT_SAMPLES,
  buildBenchmarkResults,
  buildBenchmarkConfigHash,
  benchmarkCorpusContentHash,
  benchmarkResultContentHash,
  buildGroupProfile,
  buildJUnitCommand,
  calculateMedian,
  compareBenchmarkResults,
  formatResultLine,
  main,
  parseArgs,
  resolveGroups,
  roundMs,
  materializeJUnitFile,
  materializeJUnitFiles,
  runBenchmarkGroup,
  runCommand,
  summarizeSamples,
};
