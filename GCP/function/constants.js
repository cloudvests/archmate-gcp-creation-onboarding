// Configuration Constants
const ENVIRONMENT = 'dev';

// Cognito Configuration
const COGNITO_TOKEN_URL = 'https://eu-central-1yxgmmtmcl.auth.eu-central-1.amazoncognito.com/oauth2/token';
const COGNITO_CLIENT_ID = '279kthrmc1kbopa1j95tlkf3gq';
const COGNITO_CLIENT_SECRET_B64 = 'bq59uldpgve563hhefrgptq3k7mfml83tkk2eoqm1qpfpfn4jml';

// AWS Endpoint
const AWS_ENDPOINT = 'https://nmrhp26ra7.execute-api.eu-central-1.amazonaws.com';
const AWS_ENDPOINT_PATH = '/prod/run-assessment';

module.exports = {
  ENVIRONMENT,
  COGNITO_TOKEN_URL,
  COGNITO_CLIENT_ID,
  COGNITO_CLIENT_SECRET_B64,
  AWS_ENDPOINT,
  AWS_ENDPOINT_PATH
};

