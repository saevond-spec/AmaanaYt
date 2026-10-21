'use strict';

function createRetryableInitializer(initialize) {
  if (typeof initialize !== 'function') throw new TypeError('Initializer must be a function');
  let initialized;
  return function init() {
    if (!initialized) {
      let attempt;
      attempt = Promise.resolve().then(initialize).catch((error) => {
        if (initialized === attempt) initialized = undefined;
        throw error;
      });
      initialized = attempt;
    }
    return initialized;
  };
}

module.exports = { createRetryableInitializer };
