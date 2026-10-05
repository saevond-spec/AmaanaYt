function mergeYouTubeOAuthTokens(existing, fresh, requestedScopes = []) {
  if (!fresh || typeof fresh !== 'object' || Array.isArray(fresh)) {
    throw new Error('Google did not return YouTube authorization tokens');
  }
  const returnedScope = typeof fresh.scope === 'string' ? fresh.scope.trim() : '';
  // Google omits `scope` when the grant matches the scopes in the authorization request.
  const scopes = returnedScope || (Array.isArray(requestedScopes) ? requestedScopes.join(' ') : '');
  const merged = { ...(existing || {}), ...fresh,
    scope: [...new Set(scopes.split(/\s+/).filter(Boolean))].join(' ') };
  const refreshToken = fresh.refresh_token || existing?.refresh_token;
  if (refreshToken) merged.refresh_token = refreshToken;
  else delete merged.refresh_token;
  return merged;
}

module.exports = { mergeYouTubeOAuthTokens };
