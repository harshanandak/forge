const path = require('node:path');

function toPosixPath(filePath) {
	return filePath.replaceAll('\\', '/').split(path.sep).join('/');
}

function normalizeRepoPath(filePath) {
	return toPosixPath(path.normalize(filePath));
}

module.exports = {
	normalizeRepoPath,
};
