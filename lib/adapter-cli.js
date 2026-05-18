'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { GreptileReviewAdapter } = require('./adapters/greptile-review-adapter');
const { validateReviewAdapter } = require('./review-adapter');

function parseOption(args, name, fallback = undefined) {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1] && !args[index + 1].startsWith('--')) {
    return args[index + 1];
  }
  if (index !== -1) {
    return '';
  }
  return fallback;
}

function validateAdapterName(name) {
  if (!name || typeof name !== 'string') {
    return 'Adapter name is required';
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return 'Adapter name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens';
  }
  return null;
}

function assertValidAdapterName(name) {
  const error = validateAdapterName(name);
  if (error) {
    throw new Error(error);
  }
}

function adapterNameToClassName(name) {
  return `${name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}ReviewAdapter`;
}

function getReviewAdapterDir(projectRoot) {
  return path.join(projectRoot, '.forge', 'adapters', 'review');
}

function getAdapterPath(projectRoot, name, kind = 'review') {
  assertValidAdapterName(name);
  const adapterDir = path.resolve(projectRoot, '.forge', 'adapters', kind);
  const adapterPath = path.resolve(adapterDir, `${name}.js`);
  if (!adapterPath.startsWith(`${adapterDir}${path.sep}`)) {
    throw new Error('Adapter path must stay under .forge/adapters');
  }
  return adapterPath;
}

function renderReviewAdapterScaffold(name, template) {
  const className = adapterNameToClassName(name);
  return `'use strict';

class ${className} {
  constructor(options = {}) {
    this.id = options.id || '${name}';
    this.kind = 'review';
    this.name = options.name || '${className}';
  }

  async fetchThreads(_context) {
    throw new Error('${name}.fetchThreads must connect to the review provider');
  }

  parse(payload) {
    // Start from the ${template} template and normalize provider payloads into:
    // { id, commentId, file, line, body, author, isResolved, raw }
    return Array.isArray(payload) ? payload : [];
  }

  async reply(_context) {
    throw new Error('${name}.reply must post a review-thread reply');
  }

  async resolve(_context) {
    throw new Error('${name}.resolve must mark a review thread resolved');
  }

  score(threads) {
    return threads.map((thread) => ({ ...thread, resolved: false, reason: 'not scored' }));
  }
}

module.exports = { ${className} };
`;
}

function scaffoldAdapter(args, projectRoot) {
  const subcommand = args[0];
  const name = args[1];
  const kind = parseOption(args, 'kind', 'review');
  const template = parseOption(args, 'template', 'greptile');

  if (subcommand !== 'adapter' || !name) {
    return { success: false, error: 'Usage: forge new adapter <name> --kind=review --template=greptile' };
  }
  const nameError = validateAdapterName(name);
  if (nameError) {
    return { success: false, error: nameError };
  }
  if (kind !== 'review') {
    return { success: false, error: 'Only --kind=review is supported in this foundation PR' };
  }
  if (template !== 'greptile') {
    return { success: false, error: 'Only --template=greptile is supported in this foundation PR' };
  }

  const adapterDir = getReviewAdapterDir(projectRoot);
  const adapterPath = getAdapterPath(projectRoot, name, kind);
  fs.mkdirSync(adapterDir, { recursive: true });

  if (fs.existsSync(adapterPath)) {
    return { success: false, error: `Adapter already exists: ${path.relative(projectRoot, adapterPath)}` };
  }

  fs.writeFileSync(adapterPath, renderReviewAdapterScaffold(name, template));

  return {
    success: true,
    output: `Created review adapter scaffold: ${path.relative(projectRoot, adapterPath).split(path.sep).join('/')}`,
  };
}

function loadAdapter(name, projectRoot) {
  if (name === 'greptile') {
    return new GreptileReviewAdapter();
  }

  const adapterPath = getAdapterPath(projectRoot, name);
  if (!fs.existsSync(adapterPath)) {
    throw new Error(`Adapter not found: ${name}`);
  }

  const mod = require(adapterPath);
  const exported = mod.default || mod[adapterNameToClassName(name)] || mod.adapter || mod;
  return typeof exported === 'function' ? new exported() : exported;
}

function runFixtureReplay(args, projectRoot) {
  const name = args[1];
  const fixturePath = parseOption(args, 'fixture');

  if (!name || !fixturePath) {
    return { success: false, error: 'Usage: forge adapter test <name> --fixture=<path>' };
  }

  let adapter;
  try {
    adapter = loadAdapter(name, projectRoot);
  } catch (error) {
    return { success: false, error: error.message };
  }
  const validation = validateReviewAdapter(adapter);
  if (!validation.valid) {
    return { success: false, error: validation.errors.join('; ') };
  }

  const absoluteFixturePath = path.isAbsolute(fixturePath)
    ? fixturePath
    : path.join(projectRoot, fixturePath);
  const fixture = JSON.parse(fs.readFileSync(absoluteFixturePath, 'utf8'));
  const parsed = adapter.parse(fixture.input || fixture);
  const scores = adapter.score(parsed, {
    projectRoot,
    sinceCommit: fixture.sinceCommit || null,
    _exec: fixture.gitOutput ? () => fixture.gitOutput : () => '',
  });

  if (fixture.expect?.threads !== undefined && parsed.length !== fixture.expect.threads) {
    return {
      success: false,
      error: `Expected ${fixture.expect.threads} parsed threads, got ${parsed.length}`,
    };
  }

  return {
    success: true,
    output: `Adapter ${name} fixture replay passed: ${parsed.length} parsed thread${parsed.length === 1 ? '' : 's'}, ${scores.length} scored result${scores.length === 1 ? '' : 's'}`,
  };
}

function listAdapters(projectRoot) {
  const adapterDir = getReviewAdapterDir(projectRoot);
  const local = fs.existsSync(adapterDir)
    ? fs.readdirSync(adapterDir).filter((file) => file.endsWith('.js')).map((file) => file.replace(/\.js$/, ''))
    : [];
  return ['greptile', ...local].sort((left, right) => left.localeCompare(right));
}

function setAdapterEnabled(args, projectRoot, enabled) {
  const name = args[1];
  if (!name) {
    return { success: false, error: `Usage: forge adapter ${enabled ? 'enable' : 'disable'} <name>` };
  }
  const configDir = path.join(projectRoot, '.forge');
  const configPath = path.join(configDir, 'adapters.json');
  fs.mkdirSync(configDir, { recursive: true });
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : { review: {} };
  config.review = config.review || {};
  config.review[name] = { enabled };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    success: true,
    output: `${enabled ? 'Enabled' : 'Disabled'} review adapter: ${name}`,
  };
}

function handleAdapterCommand(args, projectRoot) {
  const action = args[0];

  if (action === 'test') {
    return runFixtureReplay(args, projectRoot);
  }
  if (action === 'list') {
    return { success: true, output: listAdapters(projectRoot).join('\n') };
  }
  if (action === 'enable') {
    return setAdapterEnabled(args, projectRoot, true);
  }
  if (action === 'disable') {
    return setAdapterEnabled(args, projectRoot, false);
  }

  return {
    success: false,
    error: 'Usage: forge adapter <test|list|enable|disable> ...',
  };
}

module.exports = {
  adapterNameToClassName,
  getAdapterPath,
  handleAdapterCommand,
  listAdapters,
  runFixtureReplay,
  scaffoldAdapter,
  setAdapterEnabled,
  validateAdapterName,
};
