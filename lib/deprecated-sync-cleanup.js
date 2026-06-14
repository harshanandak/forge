'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEPRECATED_SYNC_FILES = [
  '.github/workflows/github-to-beads.yml',
  '.github/workflows/beads-to-github.yml',
  '.github/beads-mapping.json',
  '.github/beads-sync-config.json',
  '.github/scripts/beads-sync/comment.mjs',
  '.github/scripts/beads-sync/config.mjs',
  '.github/scripts/beads-sync/github-api.mjs',
  '.github/scripts/beads-sync/index.mjs',
  '.github/scripts/beads-sync/label-mapper.mjs',
  '.github/scripts/beads-sync/mapping.mjs',
  '.github/scripts/beads-sync/reverse-sync.mjs',
  '.github/scripts/beads-sync/reverse-sync-cli.mjs',
  '.github/scripts/beads-sync/run-bd.mjs',
  '.github/scripts/beads-sync/sanitize.mjs',
  'scripts/github-beads-sync.config.json',
  'scripts/github-beads-sync/comment.mjs',
  'scripts/github-beads-sync/config.mjs',
  'scripts/github-beads-sync/github-api.mjs',
  'scripts/github-beads-sync/index.mjs',
  'scripts/github-beads-sync/label-mapper.mjs',
  'scripts/github-beads-sync/mapping.mjs',
  'scripts/github-beads-sync/reverse-sync.mjs',
  'scripts/github-beads-sync/reverse-sync-cli.mjs',
  'scripts/github-beads-sync/run-bd.mjs',
  'scripts/github-beads-sync/sanitize.mjs'
];

const DEPRECATED_SYNC_FILE_SET = new Set(DEPRECATED_SYNC_FILES);

const DEPRECATED_SYNC_DIRS = [
  'scripts/github-beads-sync',
  '.github/scripts/beads-sync',
  '.github/scripts',
  '.github/workflows'
];

const LEGACY_SYNC_SCAN_DIRS = [
  'scripts/github-beads-sync',
  '.github/scripts/beads-sync'
];

const NON_BLOCKING_CUSTOM_SYNC_FILES = new Set([
  '.github/beads-mapping.json',
  '.github/beads-sync-config.json',
  'scripts/github-beads-sync.config.json'
]);

const KNOWN_GENERATED_HASHES = new Map([
  ['.github/workflows/github-to-beads.yml', [
    'f3f18b300f0faada51087b33c1be83fcc80cba75432645707a10188d824558f6',
    'fa475e7ba914b9e2b95eea0f170e396f9e6e6df87c0ea143f2cfcee18c016ff5',
    '46bc8d78a39641e90b901fa0af10dfd35f28c1eaf14bb5ced504ea915faacd35',
    '074f70345de076acb4b8c2c3e40633b2158ebe0851aaf88b8890b0fc42686585',
    '8345c0875c19887a49472fb3cf03a7ae83348c03c3a05756a92be1f096b6d6ee',
    '5ce4e4229db7d94d6d6fdb5d473a7278f9f0f72c3eb80fc334ea97800aa59b0a',
    '50a0385f6094187ab2978d1442dd269ccbdbbd3818b9aebc1000ac059eb714f6',
    '1d8d1637b75e582b257a0640b8e7efcc747223b55cde249adccd42f65a502839',
    'e9d14f24f6316369d623dcbcea98695e6ff169929e1b024076a9c6cc071b5fb0',
    '31db1e5aa0947026e9a1ac7a0990a191224580c906a17175196cd2fca40edafa',
    '152a5b54745eb01e9bf51993bdd8885fea429a0e62b13f6319d6f6805a8aba15',
    '17ec1a14f387fdfc2ce4c492b12f0148b0149a1ba5fd7ac123fc2dcd2eba0a68',
    '4f8831c5dd066b45e8aa7b5ed62eaf1d5f8c2ac5be0df97624a5db20668e2973',
    'dc33a595a08db419daf062f9b0499fb51d44f6d96d8da8123ff6ec65c2ee407c',
    'f60ed0c74013fa2f4dc29ab67bc506dea9605aee938f6a2b69ea0d117d28a47b',
    'c9370c43bcfdc97ffb56d8a0e8a20abe24edce12f9939eb3353a561fa3bf1972'
  ]],
  ['.github/workflows/beads-to-github.yml', [
    '62f801b12ddcf4a7e5343ec4e7a4f244f612ebba2f4bf46ba3cc1e7c92374693',
    '0739867fb1e28b3d8d31587f2e7659af493dad1363544332973e5ac38c5c5073',
    '83e9fb3de96cd04ffee1232e6fd91a8322d6231a1a42877993afa78be071656e'
  ]],
  ['.github/beads-mapping.json', [
    'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356',
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
  ]],
  ['.github/beads-sync-config.json', '737be9ca940b3f6c059a229ffed84d3dedd2c871682c4923f780e59ba6be45ea'],
  ['.github/scripts/beads-sync/comment.mjs', 'af03fe24e7a7c302b73ccfe400e456dae61f6729369ff15ca64b429f8eb59816'],
  ['.github/scripts/beads-sync/config.mjs', '9c7537d1f93f4fafdb6370b0c03c3f77c6daa20dd302b12a2de89af941a71464'],
  ['.github/scripts/beads-sync/github-api.mjs', 'a730e6be6b51efffb486ee61ca555714d3e3ba5fc829ef567a92ff4a2d3dba17'],
  ['.github/scripts/beads-sync/index.mjs', 'ba655a7d0b4cea9ff3c1f8f81cb54a60a32212e187679990438dec02b42f8262'],
  ['.github/scripts/beads-sync/label-mapper.mjs', 'c9427ceecd8a2d35c0ec2b6e8eb0491a368ff4a15c30db9d9f7a1f7283d6aceb'],
  ['.github/scripts/beads-sync/mapping.mjs', '716ec16887ae632dd834ea3b8a0397ef14231128f5b398e66d148d5e2135a7f8'],
  ['.github/scripts/beads-sync/reverse-sync-cli.mjs', 'b9dd3b88555893f46a7a47e1e31ec883822ee7e73dc4e1eaad14fc33a1080e3b'],
  ['.github/scripts/beads-sync/reverse-sync.mjs', '70df756f23db182e8e21cff6f492e4c262e9b0475ca1fcf1c1938888b3b9c611'],
  ['.github/scripts/beads-sync/run-bd.mjs', '4154636d43be89a0cea9e00b4e587acd9c9caf3e17b6d0aac305d5f6a34ec96d'],
  ['.github/scripts/beads-sync/sanitize.mjs', 'c3f227d18e7cb1d0ab1dd7c622b1c7dd5e05c0c180e6603a1e3ac524bbf2e47b'],
  ['scripts/github-beads-sync.config.json', '737be9ca940b3f6c059a229ffed84d3dedd2c871682c4923f780e59ba6be45ea'],
  ['scripts/github-beads-sync/comment.mjs', 'af03fe24e7a7c302b73ccfe400e456dae61f6729369ff15ca64b429f8eb59816'],
  ['scripts/github-beads-sync/config.mjs', '9c7537d1f93f4fafdb6370b0c03c3f77c6daa20dd302b12a2de89af941a71464'],
  ['scripts/github-beads-sync/github-api.mjs', 'a730e6be6b51efffb486ee61ca555714d3e3ba5fc829ef567a92ff4a2d3dba17'],
  ['scripts/github-beads-sync/index.mjs', [
    'a4df5082f0cf7f93e46299e04aaa29ba5846379ab389d68551e26ca710c90ed3',
    '0ae43e46c9552a907c3efc619724ada95e2345046750309e23d680d7f8b5781d',
    '6cb8c5d2b7831d2d994df4c540e5f2ec02244bfb994b59af1424cbee387ec837',
    'ba655a7d0b4cea9ff3c1f8f81cb54a60a32212e187679990438dec02b42f8262'
  ]],
  ['scripts/github-beads-sync/label-mapper.mjs', 'c9427ceecd8a2d35c0ec2b6e8eb0491a368ff4a15c30db9d9f7a1f7283d6aceb'],
  ['scripts/github-beads-sync/mapping.mjs', [
    '098f79f78929dfba7bb4a9c5b76c51e37e71e2c0d6bcb1016afaaaf6df789b94',
    '716ec16887ae632dd834ea3b8a0397ef14231128f5b398e66d148d5e2135a7f8'
  ]],
  ['scripts/github-beads-sync/reverse-sync-cli.mjs', [
    '1b88004657678ae2ac7908edd18a7b971928aa9830fd5525842d0b0ddf158d20',
    'b9dd3b88555893f46a7a47e1e31ec883822ee7e73dc4e1eaad14fc33a1080e3b'
  ]],
  ['scripts/github-beads-sync/reverse-sync.mjs', [
    '4da1bf5f5d5253dee4c77cbfea4e9dd86d9e0a267d46197e5eecab5a3f9b5687',
    'f33adf1a2d6a7a7437e0efd6cb7f223843d522e82d7061ac355ea2909dbb7624',
    '70df756f23db182e8e21cff6f492e4c262e9b0475ca1fcf1c1938888b3b9c611'
  ]],
  ['scripts/github-beads-sync/run-bd.mjs', [
    '6d9117b1f7e4d0628941a30773da183dc2ff8e5e5357e4ae897c381dba854c38',
    '1af7367645ff03102b2c3253718e360fd829ea4cad95fd50b973ec68b21a0cc1',
    '4154636d43be89a0cea9e00b4e587acd9c9caf3e17b6d0aac305d5f6a34ec96d'
  ]],
  ['scripts/github-beads-sync/sanitize.mjs', 'c3f227d18e7cb1d0ab1dd7c622b1c7dd5e05c0c180e6603a1e3ac524bbf2e47b']
]);

const GENERATED_MARKERS = [
  'Generated by Forge GitHub-Beads sync',
  'forge:deprecated-github-beads-sync'
];

const BRANCH_TEMPLATED_WORKFLOWS = new Set([
  '.github/workflows/beads-to-github.yml'
]);

const GENERATED_DEFAULT_BRANCH_VALUES = new Set([
  'master',
  'main'
]);

const BEADS_VERSION_TEMPLATED_WORKFLOWS = new Set([
  '.github/workflows/github-to-beads.yml',
  '.github/workflows/beads-to-github.yml'
]);

const GENERATED_BEADS_VERSION_VALUES = [
  '0.49.1',
  '1.0.0',
  '__FORGE_BEADS_VERSION__'
];

function normalizeContent(content) {
  return content.replaceAll(/\r\n/g, '\n');
}

function sha256(content) {
  return crypto.createHash('sha256').update(normalizeContent(content), 'utf8').digest('hex');
}

function generatedDefaultBranchValues(options = {}) {
  const values = new Set(GENERATED_DEFAULT_BRANCH_VALUES);
  const defaultBranch = typeof options.defaultBranch === 'string' ? options.defaultBranch.trim() : '';
  if (defaultBranch) {
    values.add(defaultBranch);
  }

  return values;
}

function toPortablePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function listFilesRecursively(rootDir) {
  const files = [];

  if (!fs.existsSync(rootDir)) {
    return files;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function collectDeprecatedSyncFiles(projectRoot) {
  const files = new Set(DEPRECATED_SYNC_FILES);

  for (const dir of LEGACY_SYNC_SCAN_DIRS) {
    const scanDir = path.join(projectRoot, dir);
    for (const filePath of listFilesRecursively(scanDir)) {
      files.add(toPortablePath(path.relative(projectRoot, filePath)));
    }
  }

  return [...files].sort((a, b) => a.localeCompare(b));
}

function generatedHashKeyFor(file) {
  const githubScriptsPrefix = '.github/scripts/beads-sync/';
  if (file.startsWith(githubScriptsPrefix)) {
    return `scripts/github-beads-sync/${file.slice(githubScriptsPrefix.length)}`;
  }

  if (file === '.github/beads-sync-config.json') {
    return 'scripts/github-beads-sync.config.json';
  }

  return file;
}

function packageSourceFor(file, packageDir) {
  if (!packageDir) {
    return null;
  }

  const githubScriptsPrefix = '.github/scripts/beads-sync/';
  if (file.startsWith(githubScriptsPrefix)) {
    return path.join(packageDir, 'scripts', 'github-beads-sync', file.slice(githubScriptsPrefix.length));
  }

  if (file === '.github/beads-sync-config.json') {
    return path.join(packageDir, 'scripts', 'github-beads-sync.config.json');
  }

  return path.join(packageDir, file);
}

function normalizedLegacyWorkflowTemplates(file, content, options = {}) {
  const candidates = new Set();
  const addCandidate = (candidate) => {
    if (candidate !== content) {
      candidates.add(candidate);
    }
  };

  let branchNormalized = content;
  if (BRANCH_TEMPLATED_WORKFLOWS.has(file)) {
    const branchList = content.match(/branches:\s*\[([^\]\r\n]+)\]/);
    const branchName = branchList?.[1]?.trim();
    if (branchName && !branchName.includes(',') && generatedDefaultBranchValues(options).has(branchName)) {
      branchNormalized = content.replace(branchList[0], 'branches: [master]');
      addCandidate(branchNormalized);
    }
  }

  if (BEADS_VERSION_TEMPLATED_WORKFLOWS.has(file) && /BD_VERSION="[^"\r\n]+"/.test(content)) {
    const bases = new Set([content, branchNormalized]);
    for (const base of bases) {
      for (const version of GENERATED_BEADS_VERSION_VALUES) {
        addCandidate(base
          .replaceAll(/BD_VERSION="[^"\r\n]+"/g, `BD_VERSION="${version}"`)
          .replaceAll(/(- name:\s+Install Beads CLI)(?: \(pinned to v[^)\r\n]+\))?/g, `$1 (pinned to v${version})`));
      }
    }
  }

  return [...candidates];
}

function isGeneratedLegacySyncFile(projectRoot, file, options = {}) {
  const fullPath = path.join(projectRoot, file);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return false;
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  const contentHash = sha256(content);

  const knownHashes = KNOWN_GENERATED_HASHES.get(generatedHashKeyFor(file));
  if (knownHashes === contentHash || (Array.isArray(knownHashes) && knownHashes.includes(contentHash))) {
    return true;
  }

  for (const templateContent of normalizedLegacyWorkflowTemplates(file, content, options)) {
    const templateHash = sha256(templateContent);
    if (knownHashes === templateHash || (Array.isArray(knownHashes) && knownHashes.includes(templateHash))) {
      return true;
    }
  }

  const packageSource = packageSourceFor(file, options.packageDir);
  if (packageSource && fs.existsSync(packageSource) && fs.statSync(packageSource).isFile()) {
    const packageContent = fs.readFileSync(packageSource, 'utf8');
    if (sha256(packageContent) === contentHash) {
      return true;
    }
  }

  return GENERATED_MARKERS.some((marker) => content.includes(marker));
}

function removeDirIfEmpty(projectRoot, dir) {
  const dirPath = path.join(projectRoot, dir);
  try {
    if (fs.existsSync(dirPath) && fs.readdirSync(dirPath).length === 0) {
      fs.rmdirSync(dirPath);
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) {
      throw error;
    }
  }
}

function cleanupDeprecatedSyncFiles(projectRoot, options = {}) {
  const removed = [];
  const skipped = [];
  const files = collectDeprecatedSyncFiles(projectRoot);
  const entries = files.map((file) => {
    const fullPath = path.join(projectRoot, file);
    const exists = fs.existsSync(fullPath);
    return {
      file,
      fullPath,
      exists,
      generated: exists ? isGeneratedLegacySyncFile(projectRoot, file, options) : false
    };
  });

  if (entries.some((entry) => (
    entry.exists
      && !entry.generated
      && DEPRECATED_SYNC_FILE_SET.has(entry.file)
      && !NON_BLOCKING_CUSTOM_SYNC_FILES.has(entry.file)
  ))) {
    return { removed, skipped: files };
  }

  for (const entry of entries) {
    if (!entry.exists) {
      skipped.push(entry.file);
      continue;
    }

    if (!entry.generated) {
      skipped.push(entry.file);
      continue;
    }

    fs.rmSync(entry.fullPath, { force: true });
    removed.push(entry.file);
  }

  for (const dir of DEPRECATED_SYNC_DIRS) {
    removeDirIfEmpty(projectRoot, dir);
  }

  return { removed, skipped };
}

module.exports = {
  DEPRECATED_SYNC_FILES,
  cleanupDeprecatedSyncFiles,
  isGeneratedLegacySyncFile
};
