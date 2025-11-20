const axios = require('axios');
const { decodeJwtPayload, logCognitoTokenMetadata, resolveClientSecret } = require('../utils/helpers');
const { COGNITO_TOKEN_URL, COGNITO_CLIENT_ID, COGNITO_CLIENT_SECRET_B64 } = require('../constants');

async function getCognitoAccessToken(options = {}) {
  const tokenUrl = COGNITO_TOKEN_URL;
  const clientId = COGNITO_CLIENT_ID;
  const scope = null; // Not provided in constants
  const secretFromEnv = COGNITO_CLIENT_SECRET_B64;

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
    throw new Error('Unable to resolve Cognito client secret from configured value.');
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
    console.error('Failed to obtain Cognito token. Error details:');
    console.error('  Message:', err.message);
    console.error('  Response status:', err.response?.status);
    console.error('  Response status text:', err.response?.statusText);
    console.error('  Response data:', JSON.stringify(err.response?.data, null, 2));
    console.error('  Request URL:', err.config?.url);
    console.error('  Request method:', err.config?.method);
    console.error('  Request headers:', JSON.stringify(err.config?.headers, null, 2));
    
    const errorMessage = err.response?.data?.error_description || 
                        err.response?.data?.error || 
                        err.message;
    
    const enhancedError = new Error(`Unable to obtain Cognito access token: ${errorMessage}`);
    enhancedError.response = err.response;
    enhancedError.config = err.config;
    throw enhancedError;
  }
}

function getAwsRequestHeaders(auth) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (auth?.token) {
    headers['auth-token'] = auth.token;
    
    const tokenType = auth.tokenType || 'Bearer';
    headers['Authorization'] = `${tokenType} ${auth.token}`;
  }

  return headers;
}

module.exports = {
  getCognitoAccessToken,
  getAwsRequestHeaders
};

