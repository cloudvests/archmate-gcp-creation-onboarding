// Configuration Constants
const ENVIRONMENT = 'prod';

// Cognito Configuration
const COGNITO_TOKEN_URL = 'https://archmate-gcp-onboarding-dev.auth.eu-central-1.amazoncognito.com/oauth2/token';
const COGNITO_CLIENT_ID = '53g60himc7al9r37m2ocpssur9';
const COGNITO_CLIENT_SECRET_B64 = '1uob3sh4p1idr6k0u2vik36h2tc87thjpumkddt567cierc64s7o';

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
