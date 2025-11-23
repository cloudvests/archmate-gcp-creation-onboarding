const { extractAndSendGCPInfo } = require('./handlers/cloudFunction');
// Export with camelCase name for Cloud Functions entry point
exports.archmateExtractAndSendGCPInfo = extractAndSendGCPInfo;
