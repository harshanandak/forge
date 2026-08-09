'use strict';

module.exports = {
  ...require('./src/authority-provider'),
  ...require('./src/backend-registry'),
  ...require('./src/feedback-intake'),
};
