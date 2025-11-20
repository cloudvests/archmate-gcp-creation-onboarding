function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) {
      return null;
    }
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch (error) {
    console.warn('Failed to decode JWT payload:', error.message);
    return null;
  }
}

function logCognitoTokenMetadata(token, { expiresIn, grantedScope, isRefresh }) {
  const prefix = isRefresh ? 'Refreshed Cognito token' : 'New Cognito token';
  const summary = {
    expiresIn: expiresIn ? `${expiresIn}s` : 'unknown',
    scope: grantedScope || 'none'
  };

  if (token && token.includes('.')) {
    try {
      const payload = decodeJwtPayload(token);
      if (payload) {
        summary.issuer = payload.iss;
        summary.client_id = payload.client_id || payload.clientId || payload.aud;
        summary.token_use = payload.token_use;
        summary.exp = payload.exp;
        summary.expHuman = payload.exp ? new Date(payload.exp * 1000).toISOString() : undefined;
      }
    } catch (err) {
      console.warn('Unable to decode Cognito token payload:', err.message);
    }
  }

  console.log(`${prefix}:`, summary);
}

function buildEndpointWithPath(baseUrl, desiredPath) {
  const normalizedPath = desiredPath.startsWith('/') ? desiredPath : `/${desiredPath}`;

  try {
    const urlObj = new URL(baseUrl);
    return `${urlObj.protocol}//${urlObj.hostname}${urlObj.port ? ':' + urlObj.port : ''}${normalizedPath}`;
  } catch (err) {
    const match = baseUrl.match(/^(https?:\/\/[^\/]+)/);
    if (match) {
      return match[1] + normalizedPath;
    }
    return baseUrl + normalizedPath;
  }
}

function resolveClientSecret(secretFromConfig) {
  if (!secretFromConfig) {
    return null;
  }

  const trimmed = secretFromConfig.trim();
  const decoded = tryDecodeBase64(trimmed);

  if (decoded) {
    console.log('Using Cognito client secret decoded from base64.');
    return decoded;
  }

  console.log('Using Cognito client secret as-is.');
  return trimmed;
}

function tryDecodeBase64(value) {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (!decoded) {
      return null;
    }

    const reencoded = Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '');
    const normalizedOriginal = value.replace(/=+$/, '');

    if (reencoded === normalizedOriginal) {
      return decoded;
    }
  } catch (err) {
    return null;
  }

  return null;
}

module.exports = {
  decodeJwtPayload,
  logCognitoTokenMetadata,
  buildEndpointWithPath,
  resolveClientSecret,
  tryDecodeBase64
};

