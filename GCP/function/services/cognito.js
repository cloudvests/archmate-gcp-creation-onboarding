const axios = require('axios');
const { COGNITO_TOKEN_URL, COGNITO_CLIENT_ID, COGNITO_CLIENT_SECRET_B64 } = require('../constants');

/**
 * Retrieve Cognito OAuth2 token using the client credentials flow.
 */
async function getCognitoAccessToken(options = {}) {
  const tokenUrl = process.env.COGNITO_TOKEN_URL || COGNITO_TOKEN_URL;
  const clientId = process.env.COGNITO_CLIENT_ID || COGNITO_CLIENT_ID;
  const scope = process.env.COGNITO_CLIENT_SCOPE;
  const secretFromEnv = process.env.COGNITO_CLIENT_SECRET_B64 || COGNITO_CLIENT_SECRET_B64;

  // Log configuration status (without exposing secrets)
  console.log('Cognito configuration check:');
  console.log('  COGNITO_TOKEN_URL:', tokenUrl ? 'SET' : 'MISSING');
  console.log('  COGNITO_CLIENT_ID:', clientId ? clientId : 'MISSING');
  console.log('  COGNITO_CLIENT_SCOPE:', scope || 'not set');
  console.log('  COGNITO_CLIENT_SECRET_B64:', secretFromEnv ? 'SET (length: ' + secretFromEnv.length + ')' : 'MISSING');

  if (!tokenUrl || !clientId || !secretFromEnv) {
    const missing = [];
    if (!tokenUrl) missing.push('COGNITO_TOKEN_URL');
    if (!clientId) missing.push('COGNITO_CLIENT_ID');
    if (!secretFromEnv) missing.push('COGNITO_CLIENT_SECRET_B64');
    throw new Error(`Missing Cognito OAuth configuration: ${missing.join(', ')}`);
  }

  const clientSecret = resolveClientSecret(secretFromEnv);
  if (!clientSecret) {
    throw new Error('Unable to resolve Cognito client secret from Terraform-provided value.');
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    });

    if (scope) {
      params.append('scope', scope);
    }

    // Match the user's curl command exactly - no Basic auth, just form-encoded data
    console.log('Requesting Cognito token from:', tokenUrl);
    console.log('Using client_id:', clientId);
    console.log('Using scope:', scope || 'none');
    console.log('Request body (sanitized):', `grant_type=client_credentials&client_id=${clientId}&client_secret=***&scope=${scope || ''}`);
    
    const response = await axios.post(tokenUrl, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    });
    
    console.log('Cognito token response status:', response.status);

    if (!response.data || !response.data.access_token) {
      throw new Error('Cognito token response missing access_token');
    }

    const { access_token: accessToken, token_type: tokenType = 'Bearer', expires_in: expiresIn, scope: grantedScope } = response.data;
    
    // Decode and log token claims for debugging
    let tokenClaims = null;
    try {
      tokenClaims = decodeJwtPayload(accessToken);
      if (tokenClaims) {
        console.log('Cognito token claims:', {
          iss: tokenClaims.iss,
          sub: tokenClaims.sub,
          client_id: tokenClaims.client_id,
          scope: tokenClaims.scope,
          token_use: tokenClaims.token_use,
          exp: tokenClaims.exp,
          expHuman: tokenClaims.exp ? new Date(tokenClaims.exp * 1000).toISOString() : null
        });
      }
    } catch (err) {
      console.warn('Could not decode token claims:', err.message);
    }
    
    logCognitoTokenMetadata(accessToken, {
      expiresIn,
      grantedScope: grantedScope || scope,
      isRefresh: Boolean(options.forceRefresh)
    });

    return {
      token: accessToken,
      tokenType,
      expiresIn,
      grantedScope: grantedScope || scope || null,
      claims: tokenClaims
    };
  } catch (err) {
    // Log detailed error information
    console.error('Failed to obtain Cognito token. Error details:');
    console.error('  Message:', err.message);
    console.error('  Response status:', err.response?.status);
    console.error('  Response status text:', err.response?.statusText);
    console.error('  Response data:', JSON.stringify(err.response?.data, null, 2));
    console.error('  Request URL:', err.config?.url);
    console.error('  Request method:', err.config?.method);
    console.error('  Request headers:', JSON.stringify(err.config?.headers, null, 2));
    
    // Preserve the original error with all details
    const errorMessage = err.response?.data?.error_description || 
                        err.response?.data?.error || 
                        err.message;
    
    const enhancedError = new Error(`Unable to obtain Cognito access token: ${errorMessage}`);
    enhancedError.response = err.response;
    enhancedError.config = err.config;
    throw enhancedError;
  }
}

/**
 * Resolve client secret whether Terraform provided base64 or plain text.
 */
function resolveClientSecret(secretFromTerraform) {
  if (!secretFromTerraform) {
    return null;
  }

  const trimmed = secretFromTerraform.trim();
  const decoded = tryDecodeBase64(trimmed);

  if (decoded) {
    console.log('Using Cognito client secret decoded from base64 (Terraform template input).');
    return decoded;
  }

  console.log('Using Cognito client secret as-is from Terraform template.');
  return trimmed;
}

function tryDecodeBase64(value) {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (!decoded) {
      return null;
    }

    // Re-encode to ensure the original looked like base64 and not plain text.
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

/**
 * Log sanitized Cognito token metadata for troubleshooting.
 */
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

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  const payload = Buffer.from(parts[1], 'base64').toString('utf8');
  return JSON.parse(payload);
}

module.exports = {
  getCognitoAccessToken
};

