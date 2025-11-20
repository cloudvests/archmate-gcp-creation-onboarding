const axios = require('axios');
const { getAwsRequestHeaders } = require('./cognito');
const { buildEndpointWithPath } = require('../utils/helpers');
const { AWS_ENDPOINT, AWS_ENDPOINT_PATH } = require('../constants');

async function sendToAwsEndpoint(payload, cognitoAuth) {
  const endpointBase = AWS_ENDPOINT;
  const endpointPath = AWS_ENDPOINT_PATH.trim();
  let awsEndpoint = endpointBase;
  
  let urlHasPath = awsEndpoint.includes('/', 8);
  
  if (endpointPath) {
    awsEndpoint = buildEndpointWithPath(endpointBase, endpointPath);
  } else if (!urlHasPath) {
    awsEndpoint = awsEndpoint + '/dev/run-assessment';
  }
  
  console.log('Sending to AWS endpoint:', awsEndpoint);
  
  if (!cognitoAuth || !cognitoAuth.token) {
    throw new Error('Cannot send to AWS: Cognito token was not obtained successfully.');
  }
  
  const headers = getAwsRequestHeaders(cognitoAuth);
  
  try {
    const response = await axios.post(awsEndpoint, payload, {
      headers: headers,
      timeout: 10000
    });
    console.log('Successfully sent to AWS endpoint:', response.status);
    return { success: true, response, endpoint: awsEndpoint };
  } catch (awsError) {
    let errorAfterRetry = awsError;
    if (awsError.response?.status === 401) {
      console.warn('Received 401 Unauthorized from AWS endpoint.');
      console.warn('Response data:', JSON.stringify(awsError.response?.data, null, 2));
      console.warn('Request headers sent:', JSON.stringify(awsError.config?.headers, null, 2));
      console.warn('Attempting to refresh Cognito token and retry once...');
      
      const { getCognitoAccessToken } = require('./cognito');
      try {
        const refreshedAuth = await getCognitoAccessToken({ forceRefresh: true });
        console.log('New token obtained, retrying request...');
        const retryHeaders = getAwsRequestHeaders(refreshedAuth);
        const retryResponse = await axios.post(awsEndpoint, payload, {
          headers: retryHeaders,
          timeout: 10000
        });
        console.log('Successfully sent to AWS endpoint after token refresh:', retryResponse.status);
        return { success: true, response: retryResponse, endpoint: awsEndpoint, retriedWithNewToken: true };
      } catch (retryError) {
        console.error('Retry after Cognito token refresh also failed:', retryError.response?.status, retryError.message);
        console.error('Retry error response data:', JSON.stringify(retryError.response?.data, null, 2));
        errorAfterRetry = retryError;
      }
    }
    
    console.warn(`Failed to send to ${awsEndpoint}:`, errorAfterRetry.response?.status, errorAfterRetry.response?.statusText);
    return { success: false, error: errorAfterRetry, endpoint: awsEndpoint, lastError: errorAfterRetry };
  }
}

function buildErrorDetails(lastError, awsEndpoint, cognitoAuth) {
  const headersSent = lastError?.config?.headers || {};
  const responseHeaders = lastError?.response?.headers || {};
  
  return {
    message: lastError?.message || 'Failed to send to AWS endpoint',
    endpoint: awsEndpoint,
    statusCode: lastError?.response?.status,
    statusText: lastError?.response?.statusText,
    responseData: lastError?.response?.data,
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
      requestMethod: lastError?.config?.method || 'POST',
      requestUrl: lastError?.config?.url || awsEndpoint
    },
    suggestion: 'The endpoint might not accept POST requests. Please configure your API Gateway to accept POST on this route, or use a different endpoint that accepts POST requests. Check API Gateway authorizer configuration and ensure it accepts tokens from the Cognito User Pool.'
  };
}

module.exports = {
  sendToAwsEndpoint,
  buildErrorDetails
};

