const { GoogleAuth } = require('google-auth-library');
const { getProjectIdFromMetadata, getServiceAccountEmail, findServiceAccountStartingWithAws, extractWorkloadIdentityInfo } = require('../services/gcp-metadata');
const { getCognitoAccessToken } = require('../services/cognito');
const { sendToAwsEndpoint, buildErrorDetails } = require('../services/aws-requests');

/**
 * Safely stringify an object, handling circular references
 */
function safeStringify(obj, space = 2) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, val) => {
    if (val != null && typeof val === 'object') {
      if (seen.has(val)) {
        return '[Circular]';
      }
      seen.add(val);
    }
    // Replace functions with their string representation
    if (typeof val === 'function') {
      return `[Function: ${val.name || 'anonymous'}]`;
    }
    return val;
  }, space);
}

async function extractAndSendGCPInfo(req, res) {
  try {
    // Log entire request object, handling circular references
    console.log('data recieved from GCP:', safeStringify(req));

    // Set CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    // Detect if this is an Eventarc event (CloudEvents format)
    // Eventarc events have Ce-* headers or the body contains CloudEvents structure
    const isEventarcEvent = req.headers && (
      req.headers['ce-type'] || 
      req.headers['ce-source'] || 
      (req.body && req.body.type && req.body.source)
    );
    
    console.log('Is Eventarc event:', isEventarcEvent);

    // Extract project ID
    const projectId = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT || 
                     await getProjectIdFromMetadata();

    if (!projectId) {
      res.status(500).json({
        success: false,
        error: 'Could not determine GCP project ID from metadata service'
      });
      return;
    }

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

    // Helper function to extract headers from rawHeaders array
    const getHeader = (name) => {
      if (!req.rawHeaders || !Array.isArray(req.rawHeaders)) {
        return null;
      }
      const lowerName = name.toLowerCase();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === lowerName) {
          return req.rawHeaders[i + 1];
        }
      }
      return null;
    };
    
    // Helper function to parse query string from URL
    const parseQuery = (url) => {
      const query = {};
      if (!url || !url.includes('?')) return query;
      const queryString = url.split('?')[1];
      if (!queryString) return query;
      queryString.split('&').forEach(param => {
        const [key, value] = param.split('=');
        if (key) {
          query[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
        }
      });
      return query;
    };
    
    // Try to parse JSON body if Content-Type indicates JSON
    let parsedBody = req.body;
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length === 0) {
      // Body might be empty object, try to parse from raw body if available
      try {
        const contentType = req.headers?.['content-type'] || getHeader('content-type') || '';
        if (contentType.includes('application/json') && req.rawBody) {
          parsedBody = typeof req.rawBody === 'string' ? JSON.parse(req.rawBody) : req.rawBody;
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }
    
    // Extract eventType from request - handle both HTTP and Eventarc events
    let eventType = null;
    
    // If this is an Eventarc event, extract eventType from CloudEvent
    if (isEventarcEvent) {
      // CloudEvents format: check ce-type header or body.type
      const cloudEventType = req.headers?.['ce-type'] || 
                            getHeader('ce-type') ||
                            parsedBody?.type ||
                            '';
      
      console.log('CloudEvent type:', cloudEventType);
      
      // Map Cloud Asset Inventory event types to our eventType
      if (cloudEventType.includes('Create') || cloudEventType.includes('create')) {
        eventType = 'create';
      } else if (cloudEventType.includes('Update') || cloudEventType.includes('update')) {
        eventType = 'update';
      } else if (cloudEventType.includes('Delete') || cloudEventType.includes('delete')) {
        eventType = 'delete';
      }
      
      // Also check the event data payload for operation type
      if (!eventType && parsedBody?.data) {
        const eventData = typeof parsedBody.data === 'string' ? JSON.parse(parsedBody.data) : parsedBody.data;
        if (eventData?.operation) {
          const operation = eventData.operation.toLowerCase();
          if (operation.includes('create')) eventType = 'create';
          else if (operation.includes('update')) eventType = 'update';
          else if (operation.includes('delete')) eventType = 'delete';
        }
      }
    }
    
    // If not Eventarc event or eventType not found, try HTTP request methods
    if (!eventType) {
      // Try to get eventType from request body (parsed)
      if (parsedBody && parsedBody.eventType) {
        eventType = String(parsedBody.eventType).toLowerCase().trim();
      }
      // Try to get eventType from query parameters (parse from URL if req.query is empty)
      else {
        const queryParams = req.query && Object.keys(req.query).length > 0 
          ? req.query 
          : parseQuery(req.url || req.originalUrl);
        if (queryParams.eventType) {
          eventType = String(queryParams.eventType).toLowerCase().trim();
        }
        // Try to get eventType from headers (check both parsed headers and rawHeaders)
        else {
          const headerValue = req.headers?.['x-event-type'] || 
                             req.headers?.['event-type'] ||
                             getHeader('x-event-type') ||
                             getHeader('event-type');
          if (headerValue) {
            eventType = String(headerValue).toLowerCase().trim();
          }
          // Try to detect from HTTP method (POST = create, PUT/PATCH = update, DELETE = delete)
          else if (req.method) {
            const method = req.method.toUpperCase();
            if (method === 'DELETE') {
              eventType = 'delete';
            } else if (method === 'PUT' || method === 'PATCH') {
              eventType = 'update';
            } else if (method === 'POST') {
              eventType = 'create';
            }
          }
        }
      }
    }
    
    // Validate eventType and default to 'create' if not valid
    const validEventTypes = ['create', 'delete', 'update'];
    if (!eventType || !validEventTypes.includes(eventType)) {
      console.warn(`Invalid or missing eventType: ${eventType}. Defaulting to 'create'`);
      eventType = 'create';
    }
    
    console.log(`Detected eventType: ${eventType} (method: ${req.method}, body: ${JSON.stringify(parsedBody)}, query: ${JSON.stringify(req.query || parseQuery(req.url || req.originalUrl))})`);

    // Prepare payload with detail.vendor = "GCP" for Step Function condition matching
    const payload = {
      detail: {
        vendor: "GCP",
        eventType: eventType,
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
    let cognitoErrorDetails = null;
    try {
      cognitoAuth = await getCognitoAccessToken();
      console.log('Cognito token obtained successfully. Token preview:', cognitoAuth?.token ? cognitoAuth.token.substring(0, 50) + '...' : 'missing');
    } catch (cognitoError) {
      console.error('CRITICAL: Failed to obtain Cognito token:', cognitoError.message);
      console.error('Cognito error stack:', cognitoError.stack);
      
      // Capture detailed error information
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
      
      // Return detailed error to user
      res.status(500).json({
        success: false,
        error: 'Failed to obtain Cognito access token required for AWS API authentication',
        cognitoError: cognitoErrorDetails,
        message: 'The function could not authenticate with Cognito to obtain an access token. Check the cognitoError details for more information.'
      });
      return;
    }

    console.log('Extracted data:', JSON.stringify(payload, null, 2));

    // Send to AWS endpoint
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
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

module.exports = {
  extractAndSendGCPInfo
};

