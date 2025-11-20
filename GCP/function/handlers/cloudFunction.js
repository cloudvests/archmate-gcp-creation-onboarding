const { GoogleAuth } = require('google-auth-library');
const { getProjectIdFromMetadata, getServiceAccountEmail, findServiceAccountStartingWithAws, extractWorkloadIdentityInfo } = require('../services/gcp-metadata');
const { getCognitoAccessToken } = require('../services/cognito');
const { sendToAwsEndpoint, buildErrorDetails } = require('../services/aws-requests');

async function extractAndSendGCPInfo(req, res) {
  try {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    const projectId = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT || 
                     await getProjectIdFromMetadata();

    if (!projectId) {
      res.status(500).json({
        success: false,
        error: 'Could not determine GCP project ID from metadata service'
      });
      return;
    }

    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    const client = await auth.getClient();
    const project = await auth.getProjectId();
 
    const serviceAccountEmail = client.email || client.client_email || await getServiceAccountEmail();
    console.log('Cloud Function is running as service account:', serviceAccountEmail || 'unknown');
 
    let awsServiceAccount = process.env.AWS_SERVICE_ACCOUNT || null;
    if (awsServiceAccount) {
      console.log(`Using AWS service account: ${awsServiceAccount}`);
    }

    if (!awsServiceAccount && serviceAccountEmail && serviceAccountEmail.startsWith('aws')) {
      awsServiceAccount = serviceAccountEmail;
      console.log(`Using current service account as AWS account: ${awsServiceAccount}`);
    }

    if (!awsServiceAccount) {
      awsServiceAccount = await findServiceAccountStartingWithAws(projectId);
      console.log(`Discovered AWS service account from IAM: ${awsServiceAccount || 'none found'}`);
    }

    let serviceAccountKeyDetails = null;
    const rawKeyFromEnv = process.env.AWS_SERVICE_ACCOUNT_KEY_B64;
    if (rawKeyFromEnv) {
      try {
        const decodedKeyString = Buffer.from(rawKeyFromEnv, 'base64').toString('utf8');
        serviceAccountKeyDetails = JSON.parse(decodedKeyString);
        console.log('Loaded service account key JSON');
      } catch (err) {
        console.error('Failed to decode or parse AWS service account key from environment:', err.message);
        serviceAccountKeyDetails = {
          error: 'Failed to decode service account key',
          errorMessage: err.message,
          rawKeyBase64: rawKeyFromEnv
        };
      }
    } else {
      console.warn('AWS_SERVICE_ACCOUNT_KEY_B64 not set; no key will be sent');
    }

    const { poolId, identityName, providerResourceName, projectNumber } = await extractWorkloadIdentityInfo(projectId);

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

    let cognitoAuth;
    let cognitoErrorDetails = null;
    try {
      cognitoAuth = await getCognitoAccessToken();
      console.log('Cognito token obtained successfully. Token preview:', cognitoAuth?.token ? cognitoAuth.token.substring(0, 50) + '...' : 'missing');
    } catch (cognitoError) {
      console.error('CRITICAL: Failed to obtain Cognito token:', cognitoError.message);
      console.error('Cognito error stack:', cognitoError.stack);
      
      cognitoErrorDetails = {
        message: cognitoError.message,
        responseStatus: cognitoError.response?.status,
        responseStatusText: cognitoError.response?.statusText,
        responseData: cognitoError.response?.data,
        responseHeaders: cognitoError.response?.headers,
        requestUrl: cognitoError.config?.url,
        requestMethod: cognitoError.config?.method
      };
      
      console.error('Cognito error details:', JSON.stringify(cognitoErrorDetails, null, 2));
      
      res.status(500).json({
        success: false,
        error: 'Failed to obtain Cognito access token required for AWS API authentication',
        cognitoError: cognitoErrorDetails,
        message: 'The function could not authenticate with Cognito to obtain an access token. Check the cognitoError details for more information.'
      });
      return;
    }

    console.log('Extracted data:', JSON.stringify(payload, null, 2));

    const result = await sendToAwsEndpoint(payload, cognitoAuth);

    if (result.success) {
      res.status(200).json({
        success: true,
        message: 'Data extracted and sent successfully',
        data: payload,
        awsResponse: {
          status: result.response.status,
          statusText: result.response.statusText,
          retriedWithNewToken: result.retriedWithNewToken || false,
          endpoint: result.endpoint
        }
      });
      return;
    }

    const errorDetails = buildErrorDetails(result.lastError || result.error, result.endpoint, cognitoAuth);
    console.error('Error sending to AWS endpoint:', JSON.stringify(errorDetails, null, 2));
    
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
      stack: undefined
    });
  }
}

module.exports = {
  extractAndSendGCPInfo
};

