'use strict';

function normalizeHttpError(error, requestId) {
  const candidate = Number(error?.status || error?.code);
  const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  const internal = status >= 500;
  return {
    status,
    body: {
      error: internal ? 'Unexpected server error' : String(error?.message || 'Request failed').slice(0, 300),
      requestId: String(requestId || '').slice(0, 80) || null
    },
    log: {
      requestId: String(requestId || '').slice(0, 80) || null,
      status,
      message: String(error?.message || 'Unexpected server error').slice(0, 500)
    }
  };
}

module.exports = { normalizeHttpError };
