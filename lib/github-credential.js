'use strict';

const { createGithubContext, readGithubAuto } = require('./github-context');

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
  if (request?.protocol !== 'https' || request.host?.toLowerCase() !== 'github.com') return 0;
  const projectRoot = options.projectRoot || process.cwd();
  const write = options.write || (value => process.stdout.write(value));
  const writeError = options.writeError || (value => process.stderr.write(value));
  try {
    const automatic = (options.readAuto || readGithubAuto)(projectRoot, options);
    if (!automatic) return 0;
    const context = (options.createContext || createGithubContext)(projectRoot, options);
    context.writeCredential(write);
    return 0;
  } catch {
    write('quit=true\n\n');
    writeError('Forge could not resolve this clone\'s GitHub account. Run forge github status.\n');
    return 1;
  }
}

module.exports = { parseRequest, runCredentialHelper };
