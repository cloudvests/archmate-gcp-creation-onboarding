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
 * Always tries to extract from GCP API first, falls back to environment variables only if extraction fails
 */
async function extractWorkloadIdentityInfo(projectId) {
  let poolId = null;
  let identityName = null;
  let providerResourceName = null;
  let projectNumber = null;

  try {
    console.log(`Attempting to extract workload identity info for project: ${projectId}`);
    
    // Always try to extract from project configuration first (not from env vars)
    try {
      // Use WorkloadIdentityPoolsClient from @google-cloud/iam
      const { v1beta } = require('@google-cloud/iam');
      const poolsClient = new v1beta.WorkloadIdentityPoolsClient();
      
      const location = 'global';
      const parent = `projects/${projectId}/locations/${location}`;
      
      console.log(`Listing workload identity pools from: ${parent}`);
      
      // List workload identity pools
      const [pools] = await poolsClient.listWorkloadIdentityPools({
        parent: parent
      });

      console.log(`Found ${pools.length} workload identity pool(s)`);

      // Try to find pool related to AWS (check name and display name)
      let awsPool = pools.find(pool => {
        const name = pool.name?.toLowerCase() || '';
        const displayName = pool.displayName?.toLowerCase() || '';
        return name.includes('aws') || displayName.includes('aws');
      });

      // If no AWS-specific pool found, try to use the first pool (fallback)
      if (!awsPool && pools.length > 0) {
        console.log('No AWS-specific pool found, using first available pool');
        awsPool = pools[0];
      }

      if (awsPool) {
        console.log(`Using pool: ${awsPool.name}`);
        
        // Extract pool ID from name: projects/{project}/locations/{location}/workloadIdentityPools/{poolId}
        const nameParts = awsPool.name.split('/');
        poolId = nameParts[nameParts.length - 1];
        console.log(`Extracted poolId: ${poolId}`);
        
        // Extract project number from pool name if available
        // Format: projects/{project_number}/locations/{location}/workloadIdentityPools/{poolId}
        if (nameParts.length > 1 && nameParts[0] === 'projects') {
          const potentialProjectNumber = nameParts[1];
          // Check if it's numeric (project number) vs project ID
          if (/^\d+$/.test(potentialProjectNumber)) {
            projectNumber = potentialProjectNumber;
            console.log(`Extracted projectNumber from pool name: ${projectNumber}`);
          }
        }
        
        // Try to get providers from this pool
        console.log(`Listing providers for pool: ${awsPool.name}`);
        const [providers] = await poolsClient.listWorkloadIdentityPoolProviders({
          parent: awsPool.name
        });

        console.log(`Found ${providers?.length || 0} provider(s) for this pool`);

        if (providers && providers.length > 0) {
          // Use the first provider (or find AWS-specific one)
          let provider = providers.find(p => 
            p.name?.toLowerCase().includes('aws') || 
            p.displayName?.toLowerCase().includes('aws')
          ) || providers[0];

          console.log(`Using provider: ${provider.name}`);
          
          // Extract provider ID from name: projects/{project_number}/locations/{location}/workloadIdentityPools/{poolId}/providers/{providerId}
          const providerNameParts = provider.name.split('/');
          identityName = providerNameParts[providerNameParts.length - 1];
          console.log(`Extracted identityName: ${identityName}`);
          
          // Store the full provider resource name
          providerResourceName = provider.name;
          console.log(`Provider resource name: ${providerResourceName}`);
          
          // Extract project number from provider resource name if not already found
          // Format: projects/{project_number}/locations/...
          if (!projectNumber && providerNameParts.length > 1 && providerNameParts[0] === 'projects') {
            const potentialProjectNumber = providerNameParts[1];
            if (/^\d+$/.test(potentialProjectNumber)) {
              projectNumber = potentialProjectNumber;
              console.log(`Extracted projectNumber from provider name: ${projectNumber}`);
            }
          }
        } else {
          console.warn('No providers found for the workload identity pool');
        }
      } else {
        console.warn('No workload identity pools found');
      }
    } catch (poolError) {
      console.error('Error extracting workload identity info from API:', poolError.message);
      if (poolError.response) {
        console.error('Response status:', poolError.response.status);
        console.error('Response data:', poolError.response.data);
      }
      console.error('Stack trace:', poolError.stack);
      
      // Fallback to environment variables only if API extraction fails
      console.log('Falling back to environment variables');
      poolId = process.env.WORKLOAD_IDENTITY_POOL_ID || null;
      identityName = process.env.WORKLOAD_IDENTITY_NAME || null;
      providerResourceName = process.env.WORKLOAD_IDENTITY_PROVIDER_RESOURCE_NAME || null;
      projectNumber = process.env.GCP_PROJECT_NUMBER || null;
    }

    // If project number is still not found, try to get it from metadata
    if (!projectNumber) {
      console.log('Project number not found, attempting to get from metadata service');
      projectNumber = await getProjectNumberFromMetadata();
      if (projectNumber) {
        console.log(`Got projectNumber from metadata: ${projectNumber}`);
      }
    }

    const result = {
      poolId: poolId || null,
      identityName: identityName || null,
      providerResourceName: providerResourceName || null,
      projectNumber: projectNumber || null
    };

    console.log('Final extracted workload identity info:', JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error('Error in extractWorkloadIdentityInfo:', error.message);
    console.error('Stack trace:', error.stack);
    
    // Final fallback to environment variables
    return {
      poolId: process.env.WORKLOAD_IDENTITY_POOL_ID || null,
      identityName: process.env.WORKLOAD_IDENTITY_NAME || null,
      providerResourceName: process.env.WORKLOAD_IDENTITY_PROVIDER_RESOURCE_NAME || null,
      projectNumber: process.env.GCP_PROJECT_NUMBER || await getProjectNumberFromMetadata() || null
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


