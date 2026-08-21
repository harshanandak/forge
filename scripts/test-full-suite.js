#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');

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
const { createProcessTree, signalExitCode } = require('./process-tree');
const { stripGitHookEnv } = require('./test');

const rootDir = path.join(__dirname, '..');
const reportDir = path.join(rootDir, 'test-results');
const RESOURCE_LANES = new Set(['unit', 'subprocess', 'exclusive']);
const RESOURCE_LANE_RANK = new Map([
  ['unit', 0],
  ['subprocess', 1],
  ['exclusive', 2],
]);
const DEFAULT_SHARD_TIMEOUT_MS = 30000;
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
    shards: null,
    timeoutMs: DEFAULT_SHARD_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--label-prefix') args.labelPrefix = next;
    if (current === '--shards') args.shards = Number.parseInt(next, 10);
    if (current === '--timeout') args.timeoutMs = parseTimeoutMs(next);
  }

  return args;
}

function parseTimeoutMs(value) {
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout must be a positive integer');
  }
  return timeoutMs;
}

function getDefaultShardCount(cpuCount = os.cpus().length) {
  if (!Number.isInteger(cpuCount) || cpuCount <= 1) return 1;
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

function assertExactShardAssignment(allTests, shardSpecs) {
  const expectedFiles = new Set(allTests);
  const assignedFiles = new Set();

  for (const shard of shardSpecs) {
    for (const file of shard.files) {
      if (!expectedFiles.has(file)) {
        throw new Error(`Test file ${file} is not part of the full suite`);
      }
      if (assignedFiles.has(file)) {
        throw new Error(`Test file ${file} belongs to more than exactly one shard`);
      }
      assignedFiles.add(file);
    }
  }

  for (const file of expectedFiles) {
    if (!assignedFiles.has(file)) {
      throw new Error(`Test file ${file} was omitted from the shard assignment`);
    }
  }
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

function tokenizeResourceSyntax(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    if (/\s/.test(current)) {
      index += 1;
      continue;
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
    if (current === '"' || current === "'") {
      const quote = current;
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\' && index + 1 < source.length) index += 1;
        value += source[index];
        index += 1;
      }
      index += 1;
      tokens.push({ type: 'string', value });
      continue;
    }
    if (current === '`') {
      let dynamic = false;
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '`') {
        if (source[index] === '\\' && index + 1 < source.length) {
          index += 1;
        } else if (source[index] === '$' && source[index + 1] === '{') {
          dynamic = true;
        }
        value += source[index];
        index += 1;
      }
      index += 1;
      tokens.push({ type: dynamic ? 'dynamic-string' : 'string', value });
      continue;
    }
    if (/[A-Za-z_$]/.test(current)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      tokens.push({ type: 'identifier', value: source.slice(start, index) });
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
      const resolved = fs.realpathSync(candidate);
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

  const inspectModule = (absoluteFile) => {
    if (moduleCache.has(absoluteFile)) return moduleCache.get(absoluteFile);
    let inspected;
    try {
      const source = readFile(absoluteFile);
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

  return (file) => {
    const absoluteFile = path.resolve(root, file);
    if (!isWithinRoot(root, absoluteFile)) return 'subprocess';
    let realFile;
    try {
      realFile = fs.realpathSync(absoluteFile);
    } catch {
      return 'subprocess';
    }
    if (!isWithinRoot(realRoot, realFile)) return 'subprocess';
    return classifyModule(realFile, new Set()).resource;
  };
}

function classifyTestResource(file, options = {}) {
  return createTestResourceClassifier(options)(file);
}

async function loadTestResourceMap(allTests, options = {}) {
  const classify = createTestResourceClassifier(options);
  const uniqueFiles = [...new Set(allTests)];
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

async function runLaneSchedule(lanes, execute, cancel = () => {}) {
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
  const overlapsSubprocess = sharedLanes.some((lane) => lane.name === 'subprocess');
  const sharedSchedule = { stopped: false };
  const settledSharedLanes = await Promise.allSettled(sharedLanes.map(async (lane) => {
    // One unit worker fills otherwise-idle CPU without recreating broad process pressure.
    const concurrency = overlapsSubprocess && lane.name === 'unit' ? 1 : lane.concurrency;
    resultsByLane.set(lane, await runLane(lane, concurrency, sharedSchedule));
  }));
  const sharedFailure = settledSharedLanes.find((result) => result.status === 'rejected');
  if (sharedFailure) throw sharedFailure.reason;

  for (const lane of lanes.filter((candidate) => candidate.name === 'exclusive')) {
    resultsByLane.set(lane, await runLane(lane));
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
    const finish = (code, output) => {
      if (settled) return;
      settled = true;
      processTree.unregisterChild(reservation);
      resolve({ code, index: shard.index, output });
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
        stdio: 'inherit',
        detached: platform !== 'win32',
        windowsHide: true,
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
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
    } catch (error) {
      if (!settled) processTree.unregisterChild(reservation);
      reject(error);
      return;
    }

    child.on('close', (code) => {
      let output = null;
      try {
        output = fs.readFileSync(junitPath, 'utf8');
      } catch {}
      finish(code ?? 1, output);
    });
  });
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
    const allTests = deps.allTests || listAllFullSuiteTests();
    const shardTotal = Number.isInteger(args.shards) && args.shards > 0
      ? args.shards
      : getDefaultShardCount(deps.cpuCount);
    const subprocessShardTotal = Number.isInteger(args.shards) && args.shards > 0
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

    if (shardSpecs.length === 0) {
      const exitCode = signal ? signalExitCode(signal) : 1;
      console.log('Full suite aggregate: status=INCOMPLETE tests=0 assertions=0 passed=0 failed=0 errors=0 skipped=0');
      console.log('Full suite exit: ' + exitCode);
      completed = true;
      return exitCode;
    }

    fs.mkdirSync(reportDir, { recursive: true });
    const runReportDir = fs.mkdtempSync(path.join(reportDir, 'full-suite-'));

    console.log(`Running local full suite in ${shardSpecs.length} shard(s)`);
    for (const lane of lanePlan) {
      console.log(`Resource lane ${lane.name}: files=${lane.shards.reduce((total, shard) => total + shard.files.length, 0)} shards=${lane.shards.length} concurrency=${lane.concurrency}`);
    }
    const childEnv = stripFullSuiteChildEnv(
      typeof processTree.envFor === 'function' ? processTree.envFor(env) : env,
    );
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
          timeoutMs: args.timeoutMs,
        }),
        resource: lane.name,
      }), () => {
        if (scheduleCancelled) return;
        scheduleCancelled = true;
        processTree.cleanup('SIGKILL');
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
      console.error(`Full suite non-zero shards: ${nonzeroShards.map((result) => `${result.index}:${result.resource}:exit=${result.code}`).join(', ')}`);
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
  classifyTestResource,
  extractFailedTestCases,
  getDefaultShardCount,
  listAllFullSuiteTests,
  loadTestResourceMap,
  main,
  parseArgs,
  runLaneSchedule,
  runFullSuiteInParallel,
  spawnShard,
  walkAllTests,
  writeDurationProfile,
};
