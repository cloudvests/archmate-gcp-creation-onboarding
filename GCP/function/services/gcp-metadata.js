const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');

/**
 * Get project ID from GCP metadata service
 */
async function getProjectIdFromMetadata() {
  try {
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

module.exports = {
  getProjectIdFromMetadata,
  getProjectNumberFromMetadata,
  getServiceAccountEmail,
  findServiceAccountStartingWithAws,
  extractWorkloadIdentityInfo
};

