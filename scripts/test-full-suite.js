#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');
const { stripVTControlCharacters } = require('node:util');

const {
  createDurationMap,
  getShardPlan,
  getUnitTestRoots,
  normalizePath,
  readNewestProfile,
  walkTests,
} = require('./test-ci-shard');
const {
  buildProfile,
  parseJUnitFiles,
  parseJUnitTestcases,
  walk: walkProfileFiles,
} = require('./test-profile');
const {
  PARTITION_OSES,
  assertExactShardAssignment,
  assertSuite,
  describePartitionViolation,
  parseCrossRunnerShard,
  partitionFiles,
  resolvePartitionOs,
  selectSuite,
  verifyPartition,
} = require('./lib/ci-shard-partition');
const { createProcessTree, signalExitCode } = require('./process-tree');
const { stripGitHookEnv } = require('./test');
const { redact } = require('../lib/audit-evidence');

const rootDir = path.join(__dirname, '..');
const reportDir = path.join(rootDir, 'test-results');
const DEFAULT_WEIGHTS_PATH = path.join(__dirname, 'test-weights.json');
const RESOURCE_LANES = new Set(['unit', 'subprocess', 'exclusive']);
const RESOURCE_LANE_RANK = new Map([
  ['unit', 0],
  ['subprocess', 1],
  ['exclusive', 2],
]);
const DEFAULT_SHARD_TIMEOUT_MS = 30000;
const STDERR_TAIL_LIMIT = 4096;
const STDERR_OMITTED_LINE = '[stderr line omitted]\n';
const JS_FAMILY_EXTENSIONS = ['.js', '.cjs', '.mjs', '.jsx', '.ts', '.cts', '.mts', '.tsx'];
const FORGE_COORDINATION_ENV = new Set([
  'FORGE_ACTOR',
  'FORGE_SESSION_ID',
  'FORGE_WORKTREE_ID',
  'FORGE_LEASE_TTL_MS',
]);

function stripFullSuiteChildEnv(env) {
  const childEnv = stripGitHookEnv(env);
  for (const key of Object.keys(childEnv)) {
    if (FORGE_COORDINATION_ENV.has(key.toUpperCase())) delete childEnv[key];
  }
  return childEnv;
}

function parseArgs(argv) {
  const args = {
    labelPrefix: 'local-full',
    shardIndex: null,
    shardTotal: null,
    shards: null,
    suite: 'all',
    timeoutMs: DEFAULT_SHARD_TIMEOUT_MS,
    verifyPartition: false,
  };
  let rawShardIndex = null;
  let rawShardTotal = null;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--label-prefix') args.labelPrefix = next;
    // --shards is the per-runner worker budget; --shard-index/--shard-total
    // pick this runner's slice of the cross-runner partition.
    if (current === '--shards') args.shards = parseResourceBudget(next);
    if (current === '--shard-index') rawShardIndex = next ?? '';
    if (current === '--shard-total') rawShardTotal = next ?? '';
    if (current === '--suite') args.suite = assertSuite(next);
    if (current === '--timeout') args.timeoutMs = parseTimeoutMs(next);
    if (current === '--verify-partition') args.verifyPartition = true;
  }

  if (args.verifyPartition) {
    if (rawShardIndex !== null) throw new Error('--verify-partition takes --shard-total only; it checks every shard');
    if (rawShardTotal !== null) args.shardTotal = parseCrossRunnerShard({ shardIndex: '0', shardTotal: rawShardTotal }).total;
    return args;
  }
  const shard = parseCrossRunnerShard({ shardIndex: rawShardIndex, shardTotal: rawShardTotal });
  if (shard) {
    args.shardIndex = shard.index;
    args.shardTotal = shard.total;
  }
  return args;
}

function parseResourceBudget(value) {
  if (!/^[1-9]\d*$/.test(String(value ?? ''))) {
    throw new Error('--shards must be a positive integer resource budget');
  }
  const budget = Number(value);
  if (!Number.isSafeInteger(budget)) {
    throw new Error('--shards must be a positive integer resource budget');
  }
  return budget;
}

function parseTimeoutMs(value) {
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout must be a positive integer');
  }
  return timeoutMs;
}

function detectCpuCount() {
  return typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
}

// The default budget is denominated in the units laneWorkerCost charges. Off
// Windows every worker costs one unit, so keep a core free for the runner. On
// Windows heavy workers are charged per OS process (2 units), so the budget is
// the real core count: 2 heavy workers on 4 vCPU is 4 processes, never the 6+
// that #547 measured flaking. Cap at what the heavy lane can use (3 x 2).
function getDefaultShardCount(cpuCount = detectCpuCount(), platform = process.platform) {
  if (!Number.isInteger(cpuCount) || cpuCount <= 1) return 1;
  if (platform === 'win32') return Math.min(6, cpuCount);
  return Math.max(2, Math.min(4, cpuCount - 1));
}

function listAllFullSuiteTests() {
  const roots = [
    ...getUnitTestRoots(),
    path.join(rootDir, 'test-env'),
    path.join(rootDir, 'scripts'),
  ].filter((dir, index, array) => fs.existsSync(dir) && array.indexOf(dir) === index);

  const files = [];
  for (const root of roots) {
    if (root === path.join(rootDir, 'test')) {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const absolute = path.join(root, entry.name);
        if (entry.isDirectory()) {
          files.push(...walkAllTests(absolute));
          continue;
        }
        if (entry.name.endsWith('.test.js') || entry.name.endsWith('.spec.js')) {
          files.push(path.relative(rootDir, absolute).replace(/\\/g, '/'));
        }
      }
      continue;
    }
    files.push(...walkTests(root));
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function walkAllTests(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkAllTests(absolute));
      continue;
    }
    if (!entry.name.endsWith('.test.js') && !entry.name.endsWith('.spec.js')) continue;
    results.push(path.relative(rootDir, absolute).replace(/\\/g, '/'));
  }
  return results;
}

function loadTestWeights(weightsPath = DEFAULT_WEIGHTS_PATH) {
  const table = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
  if (table?.version !== 1 || typeof table.files !== 'object' || table.files === null) {
    throw new Error(`${path.relative(rootDir, weightsPath)} is not a version 1 test weight table`);
  }
  return table.files;
}

// Cross-runner selection. With neither shard flags nor a suite, returns the
// discovered list itself so a plain local run is unchanged.
function resolveRunFiles(allTests, args = {}, deps = {}) {
  const suite = assertSuite(args.suite ?? 'all');
  const shard = parseCrossRunnerShard(args);
  if (!shard) return selectSuite(allTests, suite);
  const partitionOs = resolvePartitionOs(deps.platform || process.platform);
  const suiteFiles = selectSuite(allTests, suite);
  const shards = (deps.partitionFiles || partitionFiles)({
    files: suiteFiles,
    os: partitionOs,
    shardTotal: shard.total,
    weights: deps.weights || loadTestWeights(),
  });
  assertExactShardAssignment(suiteFiles, shards);
  const selected = shards[shard.index];
  console.log(`Cross-runner shard: suite=${suite} os=${partitionOs} index=${shard.index} total=${shard.total} files=${selected.files.length}/${suiteFiles.length} estimatedMs=${selected.totalMs}`);
  return selected.files;
}

// Stage-0 proof: for every OS, the requested suite's shards (core and
// expensive separately when suite=all) cover the inventory exactly.
function verifyPartitionCommand(args = {}, deps = {}) {
  const allTests = deps.allTests || listAllFullSuiteTests();
  const weights = deps.weights || loadTestWeights();
  const partition = deps.partitionFiles || partitionFiles;
  const shardTotal = args.shardTotal ?? 1;
  const suite = args.suite ?? 'all';
  const inventory = selectSuite(allTests, suite);
  const suites = suite === 'all' ? ['core', 'expensive'] : [suite];
  let ok = true;
  for (const partitionOs of PARTITION_OSES) {
    const shards = suites.flatMap((name) => partition({
      files: selectSuite(allTests, name),
      os: partitionOs,
      shardTotal,
      weights,
    }));
    const result = verifyPartition(inventory, shards);
    const heaviestMs = Math.max(0, ...shards.map((shard) => shard.totalMs || 0));
    const violation = result.ok ? '' : ` ${describePartitionViolation(result)}`;
    console.log(`Partition ${partitionOs}: suite=${suite} shards=${shards.length} files=${inventory.length} heaviestMs=${heaviestMs} status=${result.ok ? 'OK' : 'FAIL'}${violation}`);
    ok = ok && result.ok;
  }
  console.log(`Partition verification: ${ok ? 'PASS' : 'FAIL'}`);
  return ok ? 0 : 1;
}

function buildShardSpecs(allTests, shardTotal, durationMap = new Map()) {
  const specs = [];
  for (let shardIndex = 0; shardIndex < shardTotal; shardIndex += 1) {
    const plan = getShardPlan({
      label: `local-full-${shardIndex}`,
      mode: 'shard',
      shardIndex,
      shardTotal,
    }, {
      allUnitTests: allTests,
      durationMap,
    });
    if (plan.files.length === 0) continue;
    specs.push({
      files: plan.files,
      index: shardIndex,
      source: plan.source,
    });
  }
  assertExactShardAssignment(allTests, specs);
  return specs;
}

function strongestResourceLane(left, right) {
  return RESOURCE_LANE_RANK.get(left) >= RESOURCE_LANE_RANK.get(right) ? left : right;
}

const WHITESPACE_RUN = /\s+/y;
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/y;

// Reads a quoted literal starting after its opening quote. A backslash drops
// itself and keeps the next character verbatim. Values are built from slices
// rather than per-character concatenation: this runs over ~10 MB of suite
// sources at every full-suite start (issue 6c09647c).
function readQuotedLiteral(source, start, quote, detectInterpolation) {
  let value = '';
  let chunkStart = start;
  let dynamic = false;
  let index = start;
  while (index < source.length && source[index] !== quote) {
    const current = source[index];
    if (current === '\\' && index + 1 < source.length) {
      value += source.slice(chunkStart, index);
      index += 1;
      chunkStart = index;
    } else if (detectInterpolation && current === '$' && source[index + 1] === '{') {
      dynamic = true;
    }
    index += 1;
  }
  value += source.slice(chunkStart, index);
  return { dynamic, end: index + 1, value };
}

function tokenizeResourceSyntax(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const code = source.charCodeAt(index);
    // Every \s code point is <= 0x20, 0xA0, or >= 0x1680; skip the regex call otherwise.
    if (code <= 0x20 || code === 0xa0 || code >= 0x1680) {
      WHITESPACE_RUN.lastIndex = index;
      if (WHITESPACE_RUN.test(source)) {
        index = WHITESPACE_RUN.lastIndex;
        continue;
      }
    }
    if (current === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index === -1) break;
      continue;
    }
    if (current === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      const literal = readQuotedLiteral(source, index + 1, current, current === '`');
      index = literal.end;
      tokens.push({ type: literal.dynamic ? 'dynamic-string' : 'string', value: literal.value });
      continue;
    }
    const lower = code | 0x20;
    if ((lower >= 0x61 && lower <= 0x7a) || code === 0x5f || code === 0x24) {
      IDENTIFIER.lastIndex = index;
      IDENTIFIER.test(source);
      tokens.push({ type: 'identifier', value: source.slice(index, IDENTIFIER.lastIndex) });
      index = IDENTIFIER.lastIndex;
      continue;
    }
    tokens.push({ type: 'punctuator', value: current });
    index += 1;
  }
  return tokens;
}

function inspectTestResourceSource(source, file, classifySource) {
  const marker = source.match(/^\s*\/\/\s*forge-test-resource:\s*([^\s]+)\s*$/m);
  let resource = 'unit';
  if (marker) {
    if (!RESOURCE_LANES.has(marker[1])) {
      throw new Error(`Unknown full-suite resource lane ${marker[1]} in ${file}`);
    }
    resource = marker[1];
  }
  if (classifySource) {
    const classified = classifySource(source, file);
    if (!RESOURCE_LANES.has(classified)) {
      throw new Error(`Unknown full-suite resource lane ${classified} in ${file}`);
    }
    resource = strongestResourceLane(resource, classified);
  }

  const imports = [];
  const recordImport = (specifier) => {
    if (specifier === 'child_process' || specifier === 'node:child_process') {
      resource = strongestResourceLane(resource, 'subprocess');
    } else if (specifier.startsWith('.')) {
      imports.push(specifier);
    }
  };
  const tokens = tokenizeResourceSyntax(source);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (token.value === 'Bun'
      && next?.value === '.'
      && (tokens[index + 2]?.value === 'spawn' || tokens[index + 2]?.value === 'spawnSync')
      && tokens[index + 3]?.value === '(') {
      resource = strongestResourceLane(resource, 'subprocess');
      continue;
    }
    if ((token.value === 'require' || token.value === 'import')
      && previous?.value !== '.'
      && next?.value === '(') {
      const argument = tokens[index + 2];
      if (argument?.type === 'string' && tokens[index + 3]?.value === ')') {
        recordImport(argument.value);
      } else {
        resource = strongestResourceLane(resource, 'subprocess');
      }
      continue;
    }
    if (token.value !== 'import' && token.value !== 'export') continue;
    if (next?.type === 'string') {
      recordImport(next.value);
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length && tokens[cursor].value !== ';'; cursor += 1) {
      if (tokens[cursor].value === 'from' && tokens[cursor + 1]?.type === 'string') {
        recordImport(tokens[cursor + 1].value);
        break;
      }
    }
  }
  return { imports, resource };
}

function isWithinRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function createTestResourceClassifier(options = {}) {
  const root = path.resolve(options.root || rootDir);
  const realRoot = fs.realpathSync(root);
  const readFile = options.readFile || ((target) => fs.readFileSync(target, 'utf8'));
  const moduleCache = new Map();
  const resolutionCache = new Map();
  const resultCache = new Map();
  // Many importers resolve to the same helper; realpath is the costliest
  // resolution step on Windows, so resolve each candidate once.
  const realpathCache = new Map();
  const cachedRealpath = (candidate) => {
    if (!realpathCache.has(candidate)) realpathCache.set(candidate, fs.realpathSync(candidate));
    return realpathCache.get(candidate);
  };

  const resolveLocalImport = (fromFile, specifier) => {
    const cacheKey = `${fromFile}\0${specifier}`;
    if (resolutionCache.has(cacheKey)) return resolutionCache.get(cacheKey);
    const base = path.resolve(path.dirname(fromFile), specifier);
    if (!isWithinRoot(realRoot, base)) {
      resolutionCache.set(cacheKey, null);
      return null;
    }
    const candidates = [
      base,
      ...JS_FAMILY_EXTENSIONS.map((extension) => base + extension),
      ...JS_FAMILY_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
    ];
    for (const candidate of candidates) {
      let stats;
      try {
        stats = fs.statSync(candidate);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      const resolved = cachedRealpath(candidate);
      if (!isWithinRoot(realRoot, resolved)) {
        resolutionCache.set(cacheKey, null);
        return null;
      }
      resolutionCache.set(cacheKey, resolved);
      return resolved;
    }
    resolutionCache.set(cacheKey, null);
    return null;
  };

  const inspectModule = (absoluteFile, preloadedSource) => {
    if (moduleCache.has(absoluteFile)) return moduleCache.get(absoluteFile);
    let inspected;
    try {
      const source = preloadedSource === undefined ? readFile(absoluteFile) : preloadedSource;
      if (typeof source !== 'string') throw new TypeError('resource source reader must return a string');
      inspected = inspectTestResourceSource(source, path.relative(root, absoluteFile), options.classifySource);
    } catch (error) {
      if (error && /Unknown full-suite resource lane/.test(error.message)) throw error;
      inspected = { imports: [], resource: 'subprocess' };
    }
    moduleCache.set(absoluteFile, inspected);
    return inspected;
  };

  const classifyModule = (absoluteFile, visiting) => {
    if (resultCache.has(absoluteFile)) {
      return { complete: true, resource: resultCache.get(absoluteFile) };
    }
    if (visiting.has(absoluteFile)) return { complete: false, resource: 'unit' };

    visiting.add(absoluteFile);
    const inspected = inspectModule(absoluteFile);
    let resource = inspected.resource;
    let complete = true;
    if (resource !== 'exclusive') {
      for (const specifier of inspected.imports) {
        const resolved = resolveLocalImport(absoluteFile, specifier);
        if (!resolved) {
          resource = strongestResourceLane(resource, 'subprocess');
          continue;
        }
        const dependency = classifyModule(resolved, visiting);
        resource = strongestResourceLane(resource, dependency.resource);
        complete = complete && dependency.complete;
        if (resource === 'exclusive') {
          complete = true;
          break;
        }
      }
    }
    visiting.delete(absoluteFile);
    if (complete) resultCache.set(absoluteFile, resource);
    return { complete, resource };
  };

  const resolveTestFile = (file) => {
    const absoluteFile = path.resolve(root, file);
    if (!isWithinRoot(root, absoluteFile)) return null;
    let realFile;
    try {
      realFile = fs.realpathSync(absoluteFile);
    } catch {
      return null;
    }
    return isWithinRoot(realRoot, realFile) ? realFile : null;
  };

  const classify = (file) => {
    const realFile = resolveTestFile(file);
    if (!realFile) return 'subprocess';
    return classifyModule(realFile, new Set()).resource;
  };

  // Reads the test files and their transitive local imports with a bounded
  // pool and seeds the module cache, so the synchronous classification pass
  // below does no I/O for them. Anything that fails here (read error, unknown
  // lane marker) is left unseeded; the synchronous pass then re-reads it and
  // applies its usual policy, so preloading never changes a classification.
  classify.preload = async (files, readFileAsync, concurrency) => {
    const queue = [];
    const queued = new Set();
    const enqueue = (absoluteFile) => {
      if (queued.has(absoluteFile) || moduleCache.has(absoluteFile)) return;
      queued.add(absoluteFile);
      queue.push(absoluteFile);
    };
    for (const file of files) {
      const realFile = resolveTestFile(file);
      if (realFile) enqueue(realFile);
    }
    let active = 0;
    await new Promise((resolve, reject) => {
      const pump = () => {
        if (queue.length === 0 && active === 0) {
          resolve();
          return;
        }
        while (active < concurrency && queue.length > 0) {
          const absoluteFile = queue.shift();
          active += 1;
          Promise.resolve()
            .then(() => readFileAsync(absoluteFile))
            .then((raw) => {
              // Match the sync reader's utf8 contract: decode Buffers, and leave
              // any other non-string for the sync pass instead of caching it.
              const source = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
              if (typeof source !== 'string') return;
              let inspected;
              try {
                inspected = inspectModule(absoluteFile, source);
              } catch {
                return;
              }
              if (inspected.resource === 'exclusive') return;
              for (const specifier of inspected.imports) {
                const resolved = resolveLocalImport(absoluteFile, specifier);
                if (resolved) enqueue(resolved);
              }
            }, () => {})
            .then(() => {
              active -= 1;
              pump();
            })
            .catch(reject);
        }
      };
      pump();
    });
  };

  return classify;
}

function classifyTestResource(file, options = {}) {
  return createTestResourceClassifier(options)(file);
}

// Bounded read parallelism for resource preloading. Sequential reads of the
// ~960 suite sources cost 0.7-3.1 s on a loaded Windows host; 16 concurrent
// reads cost 0.2-0.45 s (measured for issue 6c09647c).
const RESOURCE_READ_CONCURRENCY = 16;

async function loadTestResourceMap(allTests, options = {}) {
  const classify = createTestResourceClassifier(options);
  const uniqueFiles = [...new Set(allTests)];
  // An injected synchronous reader is a test double: keep it authoritative
  // unless an async reader is injected alongside it.
  const readFileAsync = options.readFileAsync
    || (options.readFile ? null : (target) => fs.promises.readFile(target, 'utf8'));
  if (readFileAsync) {
    await classify.preload(uniqueFiles, readFileAsync, options.readConcurrency || RESOURCE_READ_CONCURRENCY);
  }
  const entries = uniqueFiles.map((file) => [file, classify(file)]);
  return new Map(entries);
}

function buildResourceLanePlan(allTests, shardTotal, durationMap = new Map(), options = {}) {
  const classify = options.classify || ((file) => classifyTestResource(file, options));
  const subprocessShardTotal = Number.isInteger(options.subprocessShardTotal)
    && options.subprocessShardTotal > 0
    ? options.subprocessShardTotal
    : shardTotal;
  const buckets = {
    exclusive: [],
    subprocess: [],
    unit: [],
  };
  for (const file of allTests) {
    const resource = classify(file);
    if (!RESOURCE_LANES.has(resource)) {
      throw new Error(`Unknown full-suite resource lane ${resource} for ${file}`);
    }
    buckets[resource].push(file);
  }

  const lanes = [];
  const addShardedLane = (name, shardCap, concurrencyCap = shardCap) => {
    if (buckets[name].length === 0) return;
    const shardCount = Math.min(shardCap, shardTotal, buckets[name].length);
    lanes.push({
      concurrency: Math.min(concurrencyCap, shardCount),
      name,
      shards: buildShardSpecs(buckets[name], shardCount, durationMap),
    });
  };
  addShardedLane('unit', 4);
  if (buckets.subprocess.length > 0) {
    const shardCount = Math.min(subprocessShardTotal, buckets.subprocess.length);
    lanes.push({
      concurrency: Math.min(3, shardCount),
      name: 'subprocess',
      // Extra shards improve tail balancing without increasing the worker budget.
      shards: buildShardSpecs(buckets.subprocess, shardCount, durationMap),
    });
  }
  if (buckets.exclusive.length > 0) {
    lanes.push({
      concurrency: 1,
      name: 'exclusive',
      shards: buckets.exclusive.map((file) => ({ files: [file], source: 'exclusive' })),
    });
  }

  let nextIndex = 0;
  for (const lane of lanes) {
    for (const shard of lane.shards) {
      shard.index = nextIndex;
      nextIndex += 1;
    }
  }
  assertExactShardAssignment(allTests, lanes.flatMap((lane) => lane.shards));
  return lanes;
}

// A subprocess-lane worker owns two OS processes on Windows: the shard's own bun
// runtime plus the bun.exe grandchild its tests spawn. Counting such a worker as
// one budget unit oversubscribes small runners (3 workers is ~6 processes on 4
// vCPU), so weight the grant by the declared worker cost instead of worker count.
function laneWorkerCost(laneName, platform = process.platform) {
  if (platform !== 'win32') return 1;
  return laneName === 'unit' ? 1 : 2;
}

function minimumResourceBudget(lanes, platform = process.platform) {
  return lanes
    .filter((lane) => lane.shards.length > 0)
    .reduce(
      (minimum, lane) => Math.max(minimum, laneWorkerCost(lane.name, platform)),
      0,
    );
}

function computeLaneGrants(lanes, options = {}) {
  const platform = options.platform || process.platform;
  const workerBudget = Number.isInteger(options.workerBudget) && options.workerBudget > 0
    ? options.workerBudget
    : null;
  const sharedLanes = lanes.filter((lane) => lane.name !== 'exclusive');
  const overlapsSubprocess = sharedLanes.some((lane) => lane.name === 'subprocess');
  const deferWindowsUnitLane = platform === 'win32' && overlapsSubprocess;
  const grants = new Map();
  for (const lane of lanes) {
    grants.set(lane, {
      cost: laneWorkerCost(lane.name, platform),
      deferred: false,
      granted: lane.concurrency,
      workerBudget,
    });
  }
  if (workerBudget === null) {
    for (const lane of sharedLanes) {
      const entry = grants.get(lane);
      if (deferWindowsUnitLane && lane.name === 'unit') {
        entry.granted = 0;
        entry.deferred = true;
        entry.deferredConcurrency = lane.concurrency;
      } else {
        entry.granted = overlapsSubprocess && lane.name === 'unit' ? 1 : lane.concurrency;
      }
    }
    return grants;
  }
  const minimumBudget = minimumResourceBudget(lanes, platform);
  if (workerBudget < minimumBudget) {
    throw new Error(
      `Full suite resource budget: requested=${workerBudget} minimum=${minimumBudget} outcome=rejected`,
    );
  }
  for (const lane of lanes.filter((candidate) => candidate.name === 'exclusive')) {
    const entry = grants.get(lane);
    entry.granted = Math.min(lane.concurrency, Math.floor(workerBudget / entry.cost));
  }
  // An explicit shard count is an operator-imposed weighted worker budget;
  // reserve it for heavier subprocess workers first and
  // defer leftover lanes until capacity frees instead of exceeding it.
  const ordered = [...sharedLanes].sort(
    (left, right) => (left.name === 'subprocess' ? 0 : 1) - (right.name === 'subprocess' ? 0 : 1),
  );
  let reservedCost = 0;
  for (const [position, lane] of ordered.entries()) {
    const entry = grants.get(lane);
    const want = overlapsSubprocess && lane.name === 'unit'
      ? (deferWindowsUnitLane ? 0 : 1)
      : lane.concurrency;
    const affordable = Math.floor(Math.max(0, workerBudget - reservedCost) / entry.cost);
    // The strongest lane always keeps one worker so the suite can never stall at zero.
    const granted = position === 0
      ? Math.max(1, Math.min(want, affordable))
      : Math.min(want, affordable);
    entry.granted = granted;
    entry.deferred = granted === 0;
    if (entry.deferred) {
      entry.deferredConcurrency = Math.max(
        1,
        Math.min(lane.concurrency, Math.floor(workerBudget / entry.cost)),
      );
    }
    reservedCost += granted * entry.cost;
  }
  return grants;
}

async function runLaneSchedule(lanes, execute, cancel = () => {}, options = {}) {
  const runLane = async (lane, concurrency = lane.concurrency, schedule = { stopped: false }) => {
    const laneResults = new Array(lane.shards.length);
    let nextIndex = 0;
    let stopped = false;
    const worker = async () => {
      while (!stopped && !schedule.stopped) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= lane.shards.length) return;
        try {
          laneResults[index] = await execute(lane.shards[index], lane);
        } catch (error) {
          stopped = true;
          if (!schedule.stopped) {
            schedule.stopped = true;
            cancel(error);
          }
          throw error;
        }
      }
    };
    const workers = Array.from(
      { length: Math.min(concurrency, lane.shards.length) },
      () => worker(),
    );
    const settled = await Promise.allSettled(workers);
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    return laneResults;
  };

  const resultsByLane = new Map();
  const sharedLanes = lanes.filter((lane) => lane.name !== 'exclusive');
  const sharedSchedule = { stopped: false };
  const grants = options.grants || computeLaneGrants(lanes, options);
  const deferredLanes = sharedLanes.filter((lane) => grants.get(lane).deferred);
  const immediateLanes = sharedLanes.filter((lane) => !grants.get(lane).deferred);
  const settledSharedLanes = await Promise.allSettled(immediateLanes.map(async (lane) => {
    resultsByLane.set(lane, await runLane(lane, grants.get(lane).granted, sharedSchedule));
  }));
  const sharedFailure = settledSharedLanes.find((result) => result.status === 'rejected');
  if (sharedFailure) throw sharedFailure.reason;
  // Budget-exhausted lanes start only after reserved capacity has been released.
  const settledDeferredLanes = await Promise.allSettled(deferredLanes.map(async (lane) => {
    resultsByLane.set(lane, await runLane(lane, grants.get(lane).deferredConcurrency, sharedSchedule));
  }));
  const deferredFailure = settledDeferredLanes.find((result) => result.status === 'rejected');
  if (deferredFailure) throw deferredFailure.reason;

  for (const lane of lanes.filter((candidate) => candidate.name === 'exclusive')) {
    resultsByLane.set(lane, await runLane(lane, grants.get(lane).granted));
  }
  return lanes.flatMap((lane) => {
    const laneResults = resultsByLane.get(lane);
    if (!laneResults) throw new Error(`Missing results for resource lane ${lane.name}`);
    return laneResults;
  });
}

function buildShardTestArgs({
  junitPath,
  files,
  root = rootDir,
  timeoutMs = DEFAULT_SHARD_TIMEOUT_MS,
}) {
  return [
    'test',
    '--timeout',
    String(parseTimeoutMs(timeoutMs)),
    '--reporter=junit',
    '--reporter-outfile',
    junitPath,
    ...files.map((file) => path.resolve(root, file)),
  ];
}

function parseShardReceipt(output) {
  if (typeof output !== 'string') return null;
  const root = output.match(/^\s*(?:<\?xml\b[^?]*\?>\s*)?<testsuites\b([^>]*)>[\s\S]*<\/testsuites\s*>\s*$/);
  const openingTags = output.match(/<testsuites\b/g) || [];
  const closingTags = output.match(/<\/testsuites\s*>/g) || [];
  if (!root || openingTags.length !== 1 || closingTags.length !== 1) return null;

  const readAttribute = (name) => root[1].match(new RegExp('\\b' + name + '="(\\d+)"'));
  const requiredAttributes = ['tests', 'assertions', 'failures', 'skipped'];
  const values = requiredAttributes.map(readAttribute);
  const hasInvalidRequiredAttribute = requiredAttributes.some((name, index) => {
    const occurrences = root[1].match(new RegExp('\\b' + name + '\\s*=', 'g')) || [];
    return occurrences.length !== 1 || !values[index];
  });
  const errorsOccurrences = root[1].match(/\berrors\s*=/g) || [];
  const errorsAttribute = readAttribute('errors');
  if (hasInvalidRequiredAttribute
    || errorsOccurrences.length > 1
    || (errorsOccurrences.length === 1 && !errorsAttribute)) return null;

  const tests = Number.parseInt(values[0][1], 10);
  const assertions = Number.parseInt(values[1][1], 10);
  const failed = Number.parseInt(values[2][1], 10);
  const errors = Number.parseInt(errorsAttribute?.[1] || '0', 10);
  const skipped = Number.parseInt(values[3][1], 10);
  const passed = tests - failed - errors - skipped;
  if (tests === 0 || passed < 0) return null;
  return { assertions, errors, failed, passed, skipped, tests };
}

function extractFailedTestCases(output, limit = 20) {
  const failures = [];
  for (const { attrs, body } of parseJUnitTestcases(output)) {
    const type = body.match(/<(failure|error)\b/)?.[1];
    if (!type) continue;
    failures.push({
      file: attrs.file || attrs.classname || 'unknown',
      line: attrs.line || '',
      name: attrs.name || 'unknown',
      type,
    });
    if (failures.length >= limit) break;
  }
  return failures;
}

function classifyShardFailure(result) {
  if (result?.signal) return 'signal';
  const output = typeof result?.output === 'string' ? result.output : '';
  const stderrTail = typeof result?.stderrTail === 'string' ? result.stderrTail : '';
  const parsed = parseShardReceipt(output);
  const failedReceipt = parsed && (parsed.failed > 0 || parsed.errors > 0);
  const hasTimeoutDiagnostic = (value) => /\b(?:etimedout|timed?\s*out|timeout\s*(?:error|exception))\b/i.test(value);
  const failedOutput = failedReceipt
    ? parseJUnitTestcases(output)
      .map(({ body }) => body)
      .filter(body => /<(?:failure|error)\b/.test(body))
      .join('\n')
    : '';
  const stderrDiagnostics = stripVTControlCharacters(stderrTail).split(/\r?\n/)
    .filter(line => !/^\s*\((?:pass|fail|skip|todo)\)(?:\s|$)/i.test(line))
    .join('\n');
  if (hasTimeoutDiagnostic(failedOutput) || hasTimeoutDiagnostic(stderrDiagnostics)) return 'test-timeout';
  if (failedReceipt) return 'test-failure';
  if (parsed) return 'post-junit-exit';
  return 'incomplete-receipt';
}

function createStderrTailCollector() {
  let tail = '';
  let pending = '';
  let discardingLine = false;
  const append = (value) => {
    tail = (tail + value).slice(-STDERR_TAIL_LIMIT);
  };

  return {
    write(chunk) {
      let text = String(chunk);
      if (discardingLine) {
        const newline = text.indexOf('\n');
        if (newline === -1) return;
        text = text.slice(newline + 1);
        discardingLine = false;
      }
      pending += text;
      while (pending) {
        const newline = pending.indexOf('\n');
        if (newline !== -1) {
          const line = pending.slice(0, newline + 1);
          pending = pending.slice(newline + 1);
          append(line.length > STDERR_TAIL_LIMIT ? STDERR_OMITTED_LINE : redact(line));
          continue;
        }
        if (pending.length > STDERR_TAIL_LIMIT) {
          pending = '';
          discardingLine = true;
          append(STDERR_OMITTED_LINE);
        }
        break;
      }
    },
    value() {
      if (!discardingLine && pending) append(redact(pending));
      pending = '';
      return tail;
    },
  };
}

function writeDurationProfile({ allTests, label, outputPath, runReportDir }) {
  const files = walkProfileFiles(runReportDir, '.xml');
  if (files.length === 0) return false;
  const metrics = parseJUnitFiles(files);
  const measured = new Set(metrics.allFileDurations.map((entry) => normalizePath(entry.file)));
  if (!allTests.every((file) => measured.has(normalizePath(file)))) return false;

  const profile = buildProfile({ integrationSkipped: false, label: label || 'local-full' }, metrics);
  const target = path.resolve(outputPath);
  const temporary = `${target}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify(profile, null, 2));
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return true;
}

function aggregateShardReceipts(receipts, expectedCount) {
  const totals = {
    assertions: 0,
    errors: 0,
    failed: 0,
    passed: 0,
    skipped: 0,
    tests: 0,
  };
  const seen = new Set();
  let incomplete = receipts.length !== expectedCount;
  let failedProcess = false;

  for (const receipt of receipts) {
    if (receipt === null || typeof receipt !== 'object'
      || !Number.isInteger(receipt.index)
      || receipt.index < 0
      || receipt.index >= expectedCount
      || seen.has(receipt.index)) {
      incomplete = true;
      continue;
    }
    seen.add(receipt.index);
    if (!Number.isInteger(receipt.code)) {
      incomplete = true;
    } else {
      failedProcess ||= receipt.code !== 0;
    }

    const parsed = parseShardReceipt(receipt.output);
    if (!parsed) {
      incomplete = true;
      continue;
    }
    for (const key of Object.keys(totals)) totals[key] += parsed[key];
  }

  incomplete ||= seen.size !== expectedCount;
  const status = incomplete
    ? 'INCOMPLETE'
    : (failedProcess || totals.failed > 0 || totals.errors > 0 ? 'FAIL' : 'PASS');
  return { ...totals, exitCode: status === 'PASS' ? 0 : 1, status };
}

function spawnShard(shard, options = {}) {
  const spawn = options.spawn || defaultSpawn;
  const env = options.env || process.env;
  const bunCommand = options.bunCommand || env.BUN_EXE || process.env.BUN_EXE || 'bun';
  const labelPrefix = options.labelPrefix || 'local-full';
  const targetReportDir = options.reportDirectory || reportDir;
  const platform = options.platform || process.platform;
  const processTree = options.processTree || createProcessTree({ env, platform });
  const stderrStream = options.stderrStream || process.stderr;
  const resolvedReportDir = path.resolve(targetReportDir);
  const junitPath = path.resolve(resolvedReportDir, `${labelPrefix}-shard-${shard.index}.xml`);
  if (path.dirname(junitPath) !== resolvedReportDir) {
    return Promise.reject(new Error('label prefix must produce a receipt directly inside test-results'));
  }
  fs.mkdirSync(resolvedReportDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const reservation = processTree.reserveChild({
      command: bunCommand,
      kind: 'test-shard',
      label: `${labelPrefix}-shard-${shard.index}`,
    });
    if (!reservation) {
      reject(new Error('test shard ownership manifest is unavailable'));
      return;
    }

    let child;
    let settled = false;
    let stderrDrainListener = null;
    const stderrTail = createStderrTailCollector();
    const clearStderrDrainListener = () => {
      if (!stderrDrainListener) return;
      stderrStream.off('drain', stderrDrainListener);
      stderrDrainListener = null;
    };
    const finish = (code, output, signal) => {
      if (settled) return;
      settled = true;
      clearStderrDrainListener();
      processTree.unregisterChild(reservation);
      const result = { code, index: shard.index, output };
      if (code !== 0) {
        if (signal) result.signal = signal;
        const retainedStderr = stderrTail.value();
        if (retainedStderr) result.stderrTail = retainedStderr;
      }
      resolve(result);
    };
    try {
      fs.rmSync(junitPath, { force: true });
      child = spawn(bunCommand, buildShardTestArgs({
        junitPath,
        files: shard.files,
        timeoutMs: options.timeoutMs,
      }), {
        cwd: rootDir,
        env,
        shell: false,
        stdio: ['inherit', 'inherit', 'pipe'],
        detached: platform !== 'win32',
        windowsHide: true,
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearStderrDrainListener();
        processTree.unregisterChild(reservation);
        reject(error);
      });
      if (!processTree.registerChild(reservation, child)) {
        settled = true;
        if (typeof processTree.abortChild === 'function') {
          processTree.abortChild(reservation, child);
        } else {
          try {
            child.kill?.('SIGKILL');
          } finally {
            processTree.cleanup?.('SIGKILL');
            processTree.unregisterChild(reservation);
          }
        }
        reject(new Error('test shard process could not be registered'));
        return;
      }
      child.stderr?.on('data', (chunk) => {
        const canContinue = stderrStream.write(chunk);
        stderrTail.write(chunk);
        if (
          canContinue === false
          && !stderrDrainListener
          && typeof child.stderr.pause === 'function'
          && typeof child.stderr.resume === 'function'
          && typeof stderrStream.once === 'function'
          && typeof stderrStream.off === 'function'
        ) {
          child.stderr.pause();
          stderrDrainListener = () => {
            stderrDrainListener = null;
            if (!settled) child.stderr.resume();
          };
          stderrStream.once('drain', stderrDrainListener);
        }
      });
    } catch (error) {
      if (!settled) processTree.unregisterChild(reservation);
      reject(error);
      return;
    }

    child.on('close', (code, signal) => {
      let output = null;
      try {
        output = fs.readFileSync(junitPath, 'utf8');
      } catch {}
      finish(code ?? 1, output, signal);
    });
  });
}

function prepareTestFixtures() {
  require('../test-env/helpers/fixtures.js').ensureTestFixtures();
}

async function runFullSuiteInParallel(args = {}, deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const processTree = deps.processTree || createProcessTree({ env, platform });
  let signal = null;
  let completed = false;
  let scheduleCancelled = false;
  const removeSignalHandlers = processTree.installSignalHandlers((received) => {
    signal = received;
  });

  try {
    const allTests = resolveRunFiles(deps.allTests || listAllFullSuiteTests(), args, deps);
    const requestedResourceBudget = args.shards === null || args.shards === undefined
      ? null
      : parseResourceBudget(args.shards);
    const shardTotal = requestedResourceBudget
      ?? getDefaultShardCount(deps.cpuCount ?? detectCpuCount(), platform);
    const subprocessShardTotal = requestedResourceBudget !== null
      ? shardTotal
      : Math.max(6, shardTotal);
    const profile = deps.profile || readNewestProfile(reportDir);
    const durationMap = deps.durationMap || createDurationMap(profile);
    const resourceMap = deps.classify
      ? null
      : await loadTestResourceMap(allTests, {
        classifySource: deps.classifySource,
        readFile: deps.readFile,
        root: deps.root || rootDir,
      });
    const lanePlan = buildResourceLanePlan(allTests, shardTotal, durationMap, {
      classify: deps.classify || ((file) => resourceMap.get(file)),
      subprocessShardTotal,
    });
    const shardSpecs = lanePlan.flatMap((lane) => lane.shards);
    const minimumBudget = minimumResourceBudget(lanePlan, platform);
    const effectiveResourceBudget = requestedResourceBudget === null
      ? Math.max(shardTotal, minimumBudget)
      : shardTotal;
    if (requestedResourceBudget !== null && requestedResourceBudget < minimumBudget) {
      console.log(
        `Full suite resource budget: requested=${requestedResourceBudget} minimum=${minimumBudget} outcome=rejected`,
      );
    }
    const laneGrants = computeLaneGrants(lanePlan, {
      platform,
      workerBudget: effectiveResourceBudget,
    });

    console.log(`Full suite resource budget: requested=${requestedResourceBudget ?? 'default'} effective=${effectiveResourceBudget}`);

    if (shardSpecs.length === 0) {
      // A cross-runner slice may legitimately own no files (more shards than
      // suite files); an empty unsharded inventory is still INCOMPLETE.
      const emptyCrossRunnerShard = parseCrossRunnerShard(args) !== null;
      const exitCode = signal ? signalExitCode(signal) : (emptyCrossRunnerShard ? 0 : 1);
      console.log(`Full suite aggregate: status=${exitCode === 0 ? 'PASS' : 'INCOMPLETE'} tests=0 assertions=0 passed=0 failed=0 errors=0 skipped=0`);
      console.log('Full suite exit: ' + exitCode);
      completed = true;
      return exitCode;
    }

    // Build the shared test-env fixtures once, before any shard can race to
    // repair them (CI does the same with `setup-fixtures.sh --force`). This is
    // a no-op when the fixture completion marker already exists.
    try {
      (deps.prepareFixtures || prepareTestFixtures)();
    } catch (error) {
      console.error(`Full suite fixture preparation failed: ${error.message}`);
      const exitCode = signal ? signalExitCode(signal) : 1;
      console.log('Full suite aggregate: status=INCOMPLETE tests=0 assertions=0 passed=0 failed=0 errors=0 skipped=0');
      console.log('Full suite exit: ' + exitCode);
      return exitCode;
    }

    fs.mkdirSync(reportDir, { recursive: true });
    const runReportDir = fs.mkdtempSync(path.join(reportDir, 'full-suite-'));

    console.log(`Running local full suite in ${shardSpecs.length} shard(s)`);
    for (const lane of lanePlan) {
      const grant = laneGrants.get(lane);
      const granted = grant.deferred ? grant.deferredConcurrency : grant.granted;
      const files = lane.shards.reduce((total, shard) => total + shard.files.length, 0);
      console.log(`Resource lane ${lane.name}: files=${files} shards=${lane.shards.length} concurrency=${granted} (nominal=${lane.concurrency} cost=${grant.cost} budget=${effectiveResourceBudget}${grant.deferred ? ' deferred' : ''})`);
    }
    const childEnv = stripFullSuiteChildEnv(
      typeof processTree.envFor === 'function' ? processTree.envFor(env) : env,
    );
    // Fixtures were prepared above; shards verify them and never repair, so the
    // runner stays the single fixture writer.
    childEnv.FORGE_FIXTURES_PREPARED = '1';
    let results;
    try {
      const nodeExecutable = deps.nodeExecutable ?? (
        process.versions.bun ? globalThis.Bun?.which?.('node') : process.execPath
      );
      if (typeof nodeExecutable !== 'string' || !path.isAbsolute(nodeExecutable)) {
        throw new Error('Full suite requires an absolute Node executable');
      }
      childEnv.FORGE_TEST_NODE_EXECUTABLE = nodeExecutable;
      results = await runLaneSchedule(lanePlan, async (shard, lane) => ({
        ...await spawnShard(shard, {
          bunCommand: deps.bunCommand,
          env: childEnv,
          labelPrefix: args.labelPrefix,
          reportDirectory: runReportDir,
          spawn: deps.spawn,
          platform,
          processTree,
          stderrStream: deps.stderrStream,
          timeoutMs: args.timeoutMs,
        }),
        resource: lane.name,
      }), () => {
        if (scheduleCancelled) return;
        scheduleCancelled = true;
        processTree.cleanup('SIGKILL');
      }, {
        grants: laneGrants,
        platform,
        workerBudget: effectiveResourceBudget,
      });
    } catch (error) {
      console.error('Full suite shard execution failed:', error);
      const exitCode = signal ? signalExitCode(signal) : 1;
      console.log('Full suite aggregate: status=INCOMPLETE tests=0 assertions=0 passed=0 failed=0 errors=0 skipped=0');
      console.log('Full suite exit: ' + exitCode);
      return exitCode;
    }

    const nonzeroShards = results.filter((result) => result.code !== 0);
    if (nonzeroShards.length > 0) {
      console.error(`Full suite non-zero shards: ${nonzeroShards.map((result) => {
        let diagnostic = `${result.index}:${result.resource}:exit=${result.code} cause=${classifyShardFailure(result)}`;
        if (result.signal) diagnostic += ` signal=${result.signal}`;
        const stderrTail = result.stderrTail?.trim();
        if (stderrTail) diagnostic += ` stderr=${JSON.stringify(stderrTail)}`;
        return diagnostic;
      }).join(', ')}`);
      const failedTests = nonzeroShards.flatMap((result) => extractFailedTestCases(result.output));
      if (failedTests.length > 0) {
        console.error(`Full suite failing tests: ${failedTests.map((failure) => `${failure.file}${failure.line ? `:${failure.line}` : ''} (${failure.name})`).join(', ')}`);
      }
    }
    const aggregate = aggregateShardReceipts(results, shardSpecs.length);
    const exitCode = signal ? signalExitCode(signal) : aggregate.exitCode;
    if (signal) aggregate.status = 'INCOMPLETE';
    if (aggregate.status !== 'INCOMPLETE') {
      const labelPrefix = args.labelPrefix || 'local-full';
      try {
        (deps.writeDurationProfile || writeDurationProfile)({
          allTests,
          label: labelPrefix,
          outputPath: deps.profileOutputPath || path.join(reportDir, `${labelPrefix}.profile.json`),
          runReportDir,
        });
      } catch (error) {
        console.warn(`Full suite profile was not updated: ${error.message}`);
      }
    }
    if (aggregate.status === 'PASS' && exitCode === 0) {
      fs.rmSync(runReportDir, { force: true, recursive: true });
    }
    console.log(`Full suite aggregate: status=${aggregate.status} tests=${aggregate.tests} assertions=${aggregate.assertions} passed=${aggregate.passed} failed=${aggregate.failed} errors=${aggregate.errors} skipped=${aggregate.skipped}`);
    console.log(`Full suite exit: ${exitCode}`);
    completed = true;
    return exitCode;
  } finally {
    removeSignalHandlers();
    if (!scheduleCancelled) processTree.cleanup(signal || !completed ? 'SIGKILL' : 'SIGTERM');
  }
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (args.verifyPartition) return verifyPartitionCommand(args, deps);
  const status = await runFullSuiteInParallel(args, deps);
  return status;
}

if (require.main === module) {
  main().then((status) => {
    process.exit(status);
  }).catch((error) => {
    console.error(`test-full-suite: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  aggregateShardReceipts,
  assertExactShardAssignment,
  buildResourceLanePlan,
  buildShardTestArgs,
  buildShardSpecs,
  classifyShardFailure,
  classifyTestResource,
  computeLaneGrants,
  extractFailedTestCases,
  laneWorkerCost,
  getDefaultShardCount,
  listAllFullSuiteTests,
  loadTestResourceMap,
  loadTestWeights,
  main,
  parseArgs,
  resolveRunFiles,
  runLaneSchedule,
  runFullSuiteInParallel,
  spawnShard,
  tokenizeResourceSyntax,
  verifyPartitionCommand,
  walkAllTests,
  writeDurationProfile,
};
