const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');

/**
 * Cloud Function to extract GCP project information and send to AWS endpoint
 * Triggered by AWS Lambda
 */
exports.extractAndSendGCPInfo = async (req, res) => {
  try {
    // Set CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    // Extract project ID
    const projectId = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT || 
                     await getProjectIdFromMetadata();

    // Get service account information
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    const client = await auth.getClient();
    const project = await auth.getProjectId();
 
   // Get service account email (current service account)
   const serviceAccountEmail = client.email || client.client_email || await getServiceAccountEmail();
   console.log('Cloud Function is running as service account:', serviceAccountEmail || 'unknown');
 
   // Filter service account name that starts with "aws"
    let awsServiceAccount = process.env.AWS_SERVICE_ACCOUNT || null;
    if (awsServiceAccount) {
      console.log(`Using AWS service account from environment: ${awsServiceAccount}`);
    }

    if (!awsServiceAccount && serviceAccountEmail && serviceAccountEmail.startsWith('aws')) {
      awsServiceAccount = serviceAccountEmail;
      console.log(`Using current service account as AWS account: ${awsServiceAccount}`);
    }

    if (!awsServiceAccount) {
      // Try to find service account starting with "aws" from IAM
      awsServiceAccount = await findServiceAccountStartingWithAws(projectId);
      console.log(`Discovered AWS service account from IAM: ${awsServiceAccount || 'none found'}`);
    }

    // Load the pre-generated JSON key for the AWS-prefixed service account, if present
    let serviceAccountKeyDetails = null;
    const rawKeyFromEnv = process.env.AWS_SERVICE_ACCOUNT_KEY_B64;
    if (rawKeyFromEnv) {
      try {
        const decodedKeyString = Buffer.from(rawKeyFromEnv, 'base64').toString('utf8');
        serviceAccountKeyDetails = JSON.parse(decodedKeyString);
        console.log('Loaded service account key JSON from environment variables');
      } catch (err) {
        console.error('Failed to decode or parse AWS service account key from environment:', err.message);
        serviceAccountKeyDetails = {
          error: 'Failed to decode service account key',
          errorMessage: err.message,
          rawKeyBase64: rawKeyFromEnv
        };
      }
    } else {
      console.warn('AWS_SERVICE_ACCOUNT_KEY_B64 environment variable not set; no key will be sent');
    }

    // Extract Workload Identity Pool ID and Identity Name
    const { poolId, identityName, providerResourceName, projectNumber } = await extractWorkloadIdentityInfo(projectId);

    // Prepare payload with detail.vendor = "GCP" for Step Function condition matching
    const payload = {
      detail: {
        vendor: "GCP",
        projectId: projectId || project,
        projectNumber: projectNumber,
        serviceAccountName: awsServiceAccount,
        poolId: poolId,
        identityName: identityName,
        providerResourceName: providerResourceName,
        timestamp: new Date().toISOString(),
        serviceAccountKey: serviceAccountKeyDetails
      }
    };

    // Fetch Cognito access token for downstream AWS API authorization
    let cognitoAuth;
    try {
      cognitoAuth = await getCognitoAccessToken();
      console.log('Cognito token obtained successfully. Token preview:', cognitoAuth?.token ? cognitoAuth.token.substring(0, 50) + '...' : 'missing');
    } catch (cognitoError) {
      console.error('CRITICAL: Failed to obtain Cognito token:', cognitoError.message);
      console.error('Cognito error details:', JSON.stringify(cognitoError, null, 2));
      // Continue without token - will fail at AWS but we want to see the error
      cognitoAuth = null;
    }

    console.log('Extracted data:', JSON.stringify(payload, null, 2));

    // Send to AWS endpoint
    // Get AWS endpoint from environment variable - can be full URL or base URL
    const endpointBase = process.env.AWS_ENDPOINT || 'https://zspu86b2d7.execute-api.eu-central-1.amazonaws.com';
    const endpointPath = (process.env.AWS_ENDPOINT_PATH || '').trim();
    let awsEndpoint = endpointBase;
    
    // Check if URL already contains a path
    let urlHasPath = awsEndpoint.includes('/', 8); // Check if there's a '/' after 'https://'
    
    // If AWS_ENDPOINT_PATH is explicitly set, use it (override any existing path)
    if (endpointPath) {
      awsEndpoint = buildEndpointWithPath(endpointBase, endpointPath);
    } else if (!urlHasPath) {
      // Only add default path if URL doesn't already have a path
      awsEndpoint = awsEndpoint + '/dev/run-assessment';
    }
    // If URL already has a path and AWS_ENDPOINT_PATH is not set, use URL as-is
    
    console.log('Sending to AWS endpoint:', awsEndpoint);
    
    // Check if we have a valid Cognito token
    if (!cognitoAuth || !cognitoAuth.token) {
      const errorMsg = 'Cannot send to AWS: Cognito token was not obtained successfully.';
      console.error(errorMsg);
      res.status(500).json({
        success: false,
        error: errorMsg,
        message: 'Failed to obtain Cognito access token required for AWS API authentication'
      });
      return;
    }
    
    // Try common API Gateway paths if the default fails
    const alternativePaths = ['/api', '/data', '/webhook', '/post', '/submit'];
    let lastError = null;
    
    // Helper to send payload to a specific endpoint with the current token
    const postToAws = (endpoint) => {
      const headers = getAwsRequestHeaders(cognitoAuth);
      console.log('Sending request to AWS with headers:', {
        'Content-Type': headers['Content-Type'],
        'Authorization': headers['Authorization'] ? headers['Authorization'].substring(0, 50) + '...' : 'MISSING',
        'x-api-key': headers['x-api-key'] ? '***' : 'not set'
      });
      return axios.post(endpoint, payload, {
        headers: headers,
        timeout: 10000
      });
    };

    // First try the configured/default endpoint
    try {
      const response = await postToAws(awsEndpoint);

      console.log('Successfully sent to AWS endpoint:', response.status);

      res.status(200).json({
        success: true,
        message: 'Data extracted and sent successfully',
        data: payload,
        awsResponse: {
          status: response.status,
          statusText: response.statusText
        }
      });
      return;
    } catch (awsError) {
      let errorAfterRetry = awsError;
      // If unauthorized, refresh the Cognito token once and retry immediately
      if (awsError.response?.status === 401) {
        console.warn('Received 401 Unauthorized from AWS endpoint.');
        console.warn('Response data:', JSON.stringify(awsError.response?.data, null, 2));
        console.warn('Request headers sent:', JSON.stringify(awsError.config?.headers, null, 2));
        console.warn('Attempting to refresh Cognito token and retry once...');
        try {
          cognitoAuth = await getCognitoAccessToken({ forceRefresh: true });
          console.log('New token obtained, retrying request...');
          const retryResponse = await postToAws(awsEndpoint);
          console.log('Successfully sent to AWS endpoint after token refresh:', retryResponse.status);

          res.status(200).json({
            success: true,
            message: 'Data extracted and sent successfully',
            data: payload,
            awsResponse: {
              status: retryResponse.status,
              statusText: retryResponse.statusText,
              retriedWithNewToken: true
            }
          });
          return;
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
            
            console.log(`Successfully sent to alternative endpoint ${altEndpoint}:`, altResponse.status);
            
            res.status(200).json({
              success: true,
              message: 'Data extracted and sent successfully',
              data: payload,
              awsResponse: {
                status: altResponse.status,
                statusText: altResponse.statusText,
                endpoint: altEndpoint
              }
            });
            return;
          } catch (altError) {
            console.warn(`Alternative endpoint ${altEndpoint} also failed:`, altError.response?.status);
            // Continue to next alternative
          }
        }
      }
    }
    
    // If all attempts failed, return error with diagnostic info
    const headersSent = lastError?.config?.headers || {};
    const errorDetails = {
      message: lastError?.message || 'Failed to send to AWS endpoint',
      endpoint: awsEndpoint,
      statusCode: lastError?.response?.status,
      statusText: lastError?.response?.statusText,
      responseData: lastError?.response?.data,
      diagnostics: {
        cognitoTokenObtained: cognitoAuth ? !!cognitoAuth.token : false,
        tokenPreview: cognitoAuth?.token ? cognitoAuth.token.substring(0, 30) + '...' : 'NO TOKEN',
        authorizationHeaderPresent: !!(headersSent['Authorization'] || headersSent['authorization']),
        authorizationHeaderPreview: (headersSent['Authorization'] || headersSent['authorization'] || '').substring(0, 50) + '...',
        apiKeyPresent: !!(headersSent['x-api-key'] || headersSent['X-Api-Key']),
        requestHeaders: {
          'Content-Type': headersSent['Content-Type'] || headersSent['content-type'],
          'Authorization': headersSent['Authorization'] || headersSent['authorization'] ? 'PRESENT' : 'MISSING',
          'x-api-key': headersSent['x-api-key'] || headersSent['X-Api-Key'] ? 'PRESENT' : 'MISSING'
        }
      },
      suggestion: 'The endpoint might not accept POST requests. Please configure your API Gateway to accept POST on this route, or use a different endpoint that accepts POST requests.'
    };
    
    console.error('Error sending to AWS endpoint:', JSON.stringify(errorDetails, null, 2));
    
    // Still return success with extracted data even if AWS call fails
    res.status(200).json({
      success: true,
      message: 'Data extracted successfully but failed to send to AWS',
      data: payload,
      error: errorDetails
    });

  } catch (error) {
    console.error('Error in Cloud Function:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

/**
 * Get project ID from GCP metadata service
 */
async function getProjectIdFromMetadata() {
  try {
    const axios = require('axios');
    const metadataUrl = 'http://metadata.google.internal/computeMetadata/v1/project/project-id';
    const response = await axios.get(metadataUrl, {
      headers: {
        'Metadata-Flavor': 'Google'
      },
      timeout: 5000
    });
    return response.data;
  } catch (error) {
    console.error('Error getting project ID from metadata:', error.message);
    return null;
  }
}

/**
 * Retrieve Cognito OAuth2 token using the client credentials flow.
 */
async function getCognitoAccessToken(options = {}) {
  const tokenUrl = process.env.COGNITO_TOKEN_URL;
  const clientId = process.env.COGNITO_CLIENT_ID;
  const scope = process.env.COGNITO_CLIENT_SCOPE;
  const secretFromEnv = process.env.COGNITO_CLIENT_SECRET_B64;

  if (!tokenUrl || !clientId || !secretFromEnv) {
    throw new Error('Missing Cognito OAuth configuration (token URL, client ID, or secret).');
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
    logCognitoTokenMetadata(accessToken, {
      expiresIn,
      grantedScope: grantedScope || scope,
      isRefresh: Boolean(options.forceRefresh)
    });

    return {
      token: accessToken,
      tokenType,
      expiresIn,
      grantedScope: grantedScope || scope || null
    };
  } catch (err) {
    console.error('Failed to obtain Cognito token:', err.response?.data || err.message);
    throw new Error(`Unable to obtain Cognito access token: ${err.message}`);
  }
}

/**
 * Build headers for requests to the AWS endpoint.
 */
function getAwsRequestHeaders(auth) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (auth?.token) {
    const tokenType = auth.tokenType || 'Bearer';
    headers['Authorization'] = `${tokenType} ${auth.token}`;
  }

  if (process.env.AWS_API_KEY) {
    headers['x-api-key'] = process.env.AWS_API_KEY;
  }

  return headers;
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
 * Get project number from GCP metadata service
 */
async function getProjectNumberFromMetadata() {
  try {
    const axios = require('axios');
    const metadataUrl = 'http://metadata.google.internal/computeMetadata/v1/project/numeric-project-id';
    const response = await axios.get(metadataUrl, {
      headers: {
        'Metadata-Flavor': 'Google'
      },
      timeout: 5000
    });
    return response.data;
  } catch (error) {
    console.error('Error getting project number from metadata:', error.message);
    return null;
  }
}

/**
 * Get service account email from metadata service
 */
async function getServiceAccountEmail() {
  try {
    const axios = require('axios');
    const metadataUrl = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email';
    const response = await axios.get(metadataUrl, {
      headers: {
        'Metadata-Flavor': 'Google'
      },
      timeout: 5000
    });
    return response.data;
  } catch (error) {
    console.error('Error getting service account email from metadata:', error.message);
    return null;
  }
}

/**
 * Find service account starting with "aws" using IAM Service Account API
 */
async function findServiceAccountStartingWithAws(projectId) {
  try {
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    
    // Use IAM Service Account API REST endpoint
    const apiUrl = `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts`;
    
    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    if (response.data && response.data.accounts) {
      const awsServiceAccount = response.data.accounts.find(sa => 
        sa.email && sa.email.startsWith('aws')
      );

      return awsServiceAccount ? awsServiceAccount.email : null;
    }

    return null;
  } catch (error) {
    console.error('Error finding service account starting with aws:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    // Fallback: try to get from environment variable
    return process.env.AWS_SERVICE_ACCOUNT || null;
  }
}

/**
 * Extract Workload Identity Pool ID and Identity Name
 */
async function extractWorkloadIdentityInfo(projectId) {
  try {
    // Try to get from environment variables first
    let poolId = process.env.WORKLOAD_IDENTITY_POOL_ID;
    let identityName = process.env.WORKLOAD_IDENTITY_NAME;
    let providerResourceName = process.env.WORKLOAD_IDENTITY_PROVIDER_RESOURCE_NAME || null;
    let projectNumber = process.env.GCP_PROJECT_NUMBER || null;

    // If not in env, try to extract from project configuration
    if (!poolId || !identityName || !projectNumber) {
      try {
        // Use WorkloadIdentityPoolsClient from @google-cloud/iam
        const { v1beta } = require('@google-cloud/iam');
        const poolsClient = new v1beta.WorkloadIdentityPoolsClient();
        
        const location = 'global';
        const parent = `projects/${projectId}/locations/${location}`;
        
        // List workload identity pools
        const [pools] = await poolsClient.listWorkloadIdentityPools({
          parent: parent
        });

        // Find pool that might be related to AWS
        const awsPool = pools.find(pool => 
          pool.name && pool.name.toLowerCase().includes('aws')
        );

        if (awsPool) {
          // Extract pool ID from name: projects/{project}/locations/{location}/workloadIdentityPools/{poolId}
          const nameParts = awsPool.name.split('/');
          poolId = nameParts[nameParts.length - 1];
          
          // Try to get providers from this pool
          const [providers] = await poolsClient.listWorkloadIdentityPoolProviders({
            parent: awsPool.name
          });

          if (providers && providers.length > 0) {
            // Extract provider ID from name: projects/{project_number}/locations/{location}/workloadIdentityPools/{poolId}/providers/{providerId}
            const providerNameParts = providers[0].name.split('/');
            identityName = providerNameParts[providerNameParts.length - 1];
            // Store the full provider resource name
            providerResourceName = providers[0].name;
            // Extract project number from resource name (format: projects/{project_number}/locations/...)
            // The project number is at index 1 after splitting by '/'
            if (providerNameParts.length > 1 && providerNameParts[0] === 'projects') {
              projectNumber = providerNameParts[1];
            }
          }
        }
      } catch (poolError) {
        console.error('Error extracting workload identity info:', poolError.message);
        if (poolError.response) {
          console.error('Response status:', poolError.response.status);
          console.error('Response data:', poolError.response.data);
        }
      }
    }

    // If project number is still not found, try to get it from metadata
    if (!projectNumber) {
      projectNumber = await getProjectNumberFromMetadata();
    }

    return {
      poolId: poolId || null,
      identityName: identityName || null,
      providerResourceName: providerResourceName || null,
      projectNumber: projectNumber || null
    };
  } catch (error) {
    console.error('Error in extractWorkloadIdentityInfo:', error.message);
    return {
      poolId: null,
      identityName: null,
      providerResourceName: null,
      projectNumber: null
    };
  }
}
