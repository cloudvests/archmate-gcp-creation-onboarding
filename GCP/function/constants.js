// Configuration Constants
const ENVIRONMENT = 'dev';

// Cognito Configuration
const COGNITO_TOKEN_URL = 'https://eu-central-1_iGIvitu1C.auth.eu-central-1.amazoncognito.com/oauth2/token';
const COGNITO_CLIENT_ID = '53g60himc7al9r37m2ocpssur9';
const COGNITO_CLIENT_SECRET_B64 = '1uob3sh4p1idr6k0u2vik36h2tc87thjpumkddt567cierc64s7o';

// AWS Endpoint
const AWS_ENDPOINT = 'https://zspu86b2d7.execute-api.eu-central-1.amazonaws.com/dev';
const AWS_ENDPOINT_PATH = '/dev/run-assessment';

module.exports = {
  ENVIRONMENT,
  COGNITO_TOKEN_URL,
  COGNITO_CLIENT_ID,
  COGNITO_CLIENT_SECRET_B64,
  AWS_ENDPOINT,
  AWS_ENDPOINT_PATH
};
