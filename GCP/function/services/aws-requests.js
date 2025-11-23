const axios = require('axios');
const { getCognitoAccessToken } = require('./cognito');
const { AWS_ENDPOINT, AWS_ENDPOINT_PATH } = require('../constants');

/**
 * Build headers for requests to the AWS endpoint.
 * API Gateway authorizer is configured with token source "auth-token",
 * so we send the token in the "auth-token" header.
 */
function getAwsRequestHeaders(auth) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (auth?.token) {
    // API Gateway Cognito authorizer with token source "auth-token" expects
    // the token in the "auth-token" header (raw token, no "Bearer" prefix)
    headers['auth-token'] = auth.token;
    
    // Also include Authorization header for compatibility
    const tokenType = auth.tokenType || 'Bearer';
    headers['Authorization'] = `${tokenType} ${auth.token}`;
  }

  if (process.env.AWS_API_KEY) {
    headers['x-api-key'] = process.env.AWS_API_KEY;
  }

  return headers;
}

/**
 * Safely combine base endpoint URL with a desired path.
 */
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

/**
 * Send payload to AWS endpoint with retry logic
 */
async function sendToAwsEndpoint(payload, cognitoAuth) {
  // Get AWS endpoint from environment variable - can be full URL or base URL
  const endpointBase = process.env.AWS_ENDPOINT || AWS_ENDPOINT;
  const endpointPath = (process.env.AWS_ENDPOINT_PATH || AWS_ENDPOINT_PATH || '').trim();
  let awsEndpoint = endpointBase;
  
  // Check if URL already contains a path
  let urlHasPath = awsEndpoint.includes('/', 8); // Check if there's a '/' after 'https://'
  
  // If AWS_ENDPOINT_PATH is explicitly set, use it (override any existing path)
  if (endpointPath) {
    awsEndpoint = buildEndpointWithPath(endpointBase, endpointPath);
  } else if (!urlHasPath) {
    // Only add default path if URL doesn't already have a path
    awsEndpoint = awsEndpoint + AWS_ENDPOINT_PATH;
  }
  // If URL already has a path and AWS_ENDPOINT_PATH is not set, use URL as-is
  
  console.log('Sending to AWS endpoint:', awsEndpoint);
  
  // Check if we have a valid Cognito token
  if (!cognitoAuth || !cognitoAuth.token) {
    throw new Error('Cannot send to AWS: Cognito token was not obtained successfully.');
  }
  
  // Try common API Gateway paths if the default fails
  const alternativePaths = ['/api', '/data', '/webhook', '/post', '/submit'];
  let lastError = null;
  
  // Helper to send payload to a specific endpoint with the current token
  const postToAws = (endpoint) => {
    const headers = getAwsRequestHeaders(cognitoAuth);
    
    // Log full token info for debugging (first 100 chars only)
    const authHeader = headers['Authorization'] || '';
    const tokenPart = authHeader.replace('Bearer ', '');
    
    console.log('Sending request to AWS with headers:', {
      'Content-Type': headers['Content-Type'],
      'auth-token': headers['auth-token'] ? `${headers['auth-token'].substring(0, 20)}...` : 'MISSING',
      'Authorization': authHeader ? `${authHeader.substring(0, 20)}...` : 'MISSING',
      'x-api-key': headers['x-api-key'] ? '***' : 'not set',
      'User-Agent': headers['User-Agent'] || 'not set'
    });
    
    console.log('Token details:', {
      tokenLength: tokenPart.length,
      tokenStartsWith: tokenPart.substring(0, 20),
      tokenType: cognitoAuth?.tokenType,
      scope: cognitoAuth?.grantedScope,
      claims: cognitoAuth?.claims ? {
        iss: cognitoAuth.claims.iss,
        client_id: cognitoAuth.claims.client_id,
        scope: cognitoAuth.claims.scope
      } : null
    });
    
    return axios.post(endpoint, payload, {
      headers: headers,
      timeout: 10000
    });
  };

  // First try the configured/default endpoint
  try {
    const response = await postToAws(awsEndpoint);
    return {
      success: true,
      response: response,
      endpoint: awsEndpoint
    };
  } catch (awsError) {
    let errorAfterRetry = awsError;
    // If unauthorized, refresh the Cognito token once and retry immediately
    if (awsError.response?.status === 401) {
      console.warn('Received 401 Unauthorized from AWS endpoint.');
      console.warn('Response data:', JSON.stringify(awsError.response?.data, null, 2));
      console.warn('Request headers sent:', JSON.stringify(awsError.config?.headers, null, 2));
      console.warn('Attempting to refresh Cognito token and retry once...');
      try {
        const refreshedAuth = await getCognitoAccessToken({ forceRefresh: true });
        console.log('New token obtained, retrying request...');
        const retryResponse = await postToAws(awsEndpoint);
        return {
          success: true,
          response: retryResponse,
          endpoint: awsEndpoint,
          retriedWithNewToken: true
        };
      } catch (retryError) {
        console.error('Retry after Cognito token refresh also failed:', retryError.response?.status, retryError.message);
        console.error('Retry error response data:', JSON.stringify(retryError.response?.data, null, 2));
        errorAfterRetry = retryError;
      }
    }

    lastError = errorAfterRetry;
    console.warn(`Failed to send to ${awsEndpoint}:`, errorAfterRetry.response?.status, errorAfterRetry.response?.statusText);
    
    // If it's a 404 and we haven't tried alternatives yet, try common paths
    if (errorAfterRetry.response?.status === 404 && !process.env.AWS_ENDPOINT_PATH) {
      // Extract base URL from the current endpoint
      let baseUrl;
      try {
        const urlObj = new URL(awsEndpoint);
        baseUrl = `${urlObj.protocol}//${urlObj.hostname}${urlObj.port ? ':' + urlObj.port : ''}`;
      } catch (e) {
        const match = awsEndpoint.match(/^(https?:\/\/[^\/]+)/);
        baseUrl = match ? match[1] : awsEndpoint.split('/').slice(0, 3).join('/');
      }
      
      for (const altPath of alternativePaths) {
        const altEndpoint = baseUrl + altPath;
        console.log(`Trying alternative endpoint: ${altEndpoint}`);
        
        try {
          const altResponse = await postToAws(altEndpoint);
          return {
            success: true,
            response: altResponse,
            endpoint: altEndpoint
          };
        } catch (altError) {
          console.warn(`Alternative endpoint ${altEndpoint} also failed:`, altError.response?.status);
          // Continue to next alternative
        }
      }
    }
    
    // Build error details
    const headersSent = errorAfterRetry?.config?.headers || {};
    const responseHeaders = errorAfterRetry?.response?.headers || {};
    
    return {
      success: false,
      error: buildErrorDetails(errorAfterRetry, awsEndpoint, cognitoAuth),
      lastError: errorAfterRetry,
      endpoint: awsEndpoint
    };
  }
}

/**
 * Build detailed error information for debugging
 */
function buildErrorDetails(error, endpoint, cognitoAuth) {
  const headersSent = error?.config?.headers || {};
  const responseHeaders = error?.response?.headers || {};
  
  return {
    message: error?.message || 'Failed to send to AWS endpoint',
    endpoint: endpoint,
    statusCode: error?.response?.status,
    statusText: error?.response?.statusText,
    responseData: error?.response?.data,
    responseHeaders: {
      'www-authenticate': responseHeaders['www-authenticate'] || responseHeaders['WWW-Authenticate'] || null,
      'x-amzn-errortype': responseHeaders['x-amzn-errortype'] || responseHeaders['X-Amzn-Errortype'] || null,
      'x-amzn-requestid': responseHeaders['x-amzn-requestid'] || responseHeaders['X-Amzn-Requestid'] || null
    },
    diagnostics: {
      cognitoTokenObtained: cognitoAuth ? !!cognitoAuth.token : false,
      tokenPreview: cognitoAuth?.token ? cognitoAuth.token.substring(0, 30) + '...' : 'NO TOKEN',
      authTokenHeaderPresent: !!(headersSent['auth-token'] || headersSent['Auth-Token']),
      authTokenHeaderPreview: (headersSent['auth-token'] || headersSent['Auth-Token'] || '').substring(0, 50) + '...',
      authorizationHeaderPresent: !!(headersSent['Authorization'] || headersSent['authorization']),
      authorizationHeaderPreview: (headersSent['Authorization'] || headersSent['authorization'] || '').substring(0, 50) + '...',
      apiKeyPresent: !!(headersSent['x-api-key'] || headersSent['X-Api-Key']),
      tokenClaims: cognitoAuth?.claims ? {
        iss: cognitoAuth.claims.iss,
        sub: cognitoAuth.claims.sub,
        client_id: cognitoAuth.claims.client_id,
        scope: cognitoAuth.claims.scope,
        token_use: cognitoAuth.claims.token_use,
        exp: cognitoAuth.claims.exp,
        expHuman: cognitoAuth.claims.exp ? new Date(cognitoAuth.claims.exp * 1000).toISOString() : null,
        isExpired: cognitoAuth.claims.exp ? (Date.now() / 1000) > cognitoAuth.claims.exp : null
      } : null,
      requestHeaders: {
        'Content-Type': headersSent['Content-Type'] || headersSent['content-type'],
        'auth-token': headersSent['auth-token'] || headersSent['Auth-Token'] ? 'PRESENT' : 'MISSING',
        'Authorization': headersSent['Authorization'] || headersSent['authorization'] ? 'PRESENT' : 'MISSING',
        'x-api-key': headersSent['x-api-key'] || headersSent['X-Api-Key'] ? 'PRESENT' : 'MISSING',
        'User-Agent': headersSent['User-Agent'] || headersSent['user-agent'] || 'not set'
      },
      requestMethod: error?.config?.method || 'POST',
      requestUrl: error?.config?.url || endpoint
    },
    suggestion: 'The endpoint might not accept POST requests. Please configure your API Gateway to accept POST on this route, or use a different endpoint that accepts POST requests. Check API Gateway authorizer configuration and ensure it accepts tokens from the Cognito User Pool.'
  };
}

module.exports = {
  getAwsRequestHeaders,
  buildEndpointWithPath,
  sendToAwsEndpoint,
  buildErrorDetails
};

