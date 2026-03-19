const fs = require('node:fs');

const GIT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';

function resolveBashCommand() {
	if (process.env.BASH_CMD) {
		return process.env.BASH_CMD;
	}

	if (process.platform === 'win32' && fs.existsSync(GIT_BASH_PATH)) {
		return GIT_BASH_PATH;
	}

	return 'bash';
}

module.exports = {
	resolveBashCommand,
};
