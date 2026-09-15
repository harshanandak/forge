'use strict';

const { readGithubAuto, writeGithubCredential } = require('./github-context');
const { assertGithubRouterCloneRegistered } = require('./github-router');

function parseRequest(input) {
  if (typeof input !== 'string' || input.length > 64 * 1024) return null;
  const request = Object.create(null);
  for (const line of input.split(/\r?\n/)) {
    if (!line) break;
    const separator = line.indexOf('=');
    if (separator < 1) return null;
    request[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return request;
}

function runCredentialHelper(operation, options = {}) {
  if (!['get', 'store', 'erase'].includes(operation)) return 1;
  if (operation !== 'get') return 0;
  const request = parseRequest(options.input || '');
  const host = request?.host?.toLowerCase();
  if (request?.protocol !== 'https' || (host !== 'github.com' && host !== 'github.com:443')) return 0;
  const projectRoot = options.projectRoot || process.cwd();
  const write = options.write || (value => process.stdout.write(value));
  const writeError = options.writeError || (value => process.stderr.write(value));
  try {
    const automatic = (options.readAuto || readGithubAuto)(projectRoot, options);
    if (automatic === false) return 0;
    if (automatic !== true) throw new Error('Automatic GitHub routing configuration is invalid.');
    if (!options.createContext || options.assertRegistered) {
      (options.assertRegistered || assertGithubRouterCloneRegistered)(projectRoot, options);
    }
    if (options.createContext) {
      options.createContext(projectRoot, options).writeCredential(write);
    } else {
      writeGithubCredential(projectRoot, write, options);
    }
    return 0;
  } catch {
    write('quit=true\n\n');
    writeError('Forge could not resolve this clone\'s GitHub account. Run forge github status.\n');
    return 1;
  }
}

module.exports = { parseRequest, runCredentialHelper };
