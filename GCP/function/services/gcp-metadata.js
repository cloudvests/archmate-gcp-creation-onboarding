const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');

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

async function findServiceAccountStartingWithAws(projectId) {
  try {
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    
    const client = await auth.getClient();
    const accessTokenResult = await client.getAccessToken();
    const accessToken = accessTokenResult?.token || accessTokenResult;
    
    const apiUrl = `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts`;
    
    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
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
    return process.env.AWS_SERVICE_ACCOUNT || null;
  }
}

async function extractWorkloadIdentityInfo(projectId) {
  try {
    let poolId = process.env.WORKLOAD_IDENTITY_POOL_ID;
    let identityName = process.env.WORKLOAD_IDENTITY_NAME;
    let providerResourceName = process.env.WORKLOAD_IDENTITY_PROVIDER_RESOURCE_NAME || null;
    let projectNumber = process.env.GCP_PROJECT_NUMBER || null;

    if (!poolId || !identityName || !projectNumber) {
      try {
        const { v1beta } = require('@google-cloud/iam');
        const poolsClient = new v1beta.WorkloadIdentityPoolsClient();
        
        const location = 'global';
        const parent = `projects/${projectId}/locations/${location}`;
        
        const [pools] = await poolsClient.listWorkloadIdentityPools({
          parent: parent
        });

        if (!pools || !Array.isArray(pools) || pools.length === 0) {
          console.warn('No workload identity pools found');
        } else {
          const awsPool = pools.find(pool => 
            pool.name && pool.name.toLowerCase().includes('aws')
          );

          if (awsPool) {
            const nameParts = awsPool.name.split('/');
            poolId = nameParts[nameParts.length - 1];
            
            const [providers] = await poolsClient.listWorkloadIdentityPoolProviders({
              parent: awsPool.name
            });

            if (providers && providers.length > 0) {
              const providerNameParts = providers[0].name.split('/');
              identityName = providerNameParts[providerNameParts.length - 1];
              providerResourceName = providers[0].name;
              if (providerNameParts.length > 1 && providerNameParts[0] === 'projects') {
                projectNumber = providerNameParts[1];
              }
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
  getServiceAccountEmail,
  findServiceAccountStartingWithAws,
  extractWorkloadIdentityInfo
};

