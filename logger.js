const AWS = require('aws-sdk');

// Configure AWS region (Lambda uses IAM role for credentials)
AWS.config.update({ 
  region: process.env.AWS_REGION || 'us-east-1'
});

// Logger function to capture exact Retell request structure
module.exports.logger = async (event) => {
  console.log('[logger] Starting function...');
  
  try {
    // Log the full event object
    console.log('[logger] Full Event Object:', JSON.stringify(event, null, 2));
    
    // Log specific parts for easier reading
    console.log('[logger] Headers:', JSON.stringify(event.headers || {}, null, 2));
    console.log('[logger] Query Parameters:', JSON.stringify(event.queryStringParameters || {}, null, 2));
    console.log('[logger] Path Parameters:', JSON.stringify(event.pathParameters || {}, null, 2));
    console.log('[logger] HTTP Method:', event.httpMethod);
    console.log('[logger] Resource Path:', event.resource);
    console.log('[logger] Request Context:', JSON.stringify(event.requestContext || {}, null, 2));
    
    // Log raw body
    console.log('[logger] Raw Body (string):', event.body);
    
    // Try to parse body as JSON
    let parsedBody = null;
    if (event.body) {
      try {
        parsedBody = JSON.parse(event.body);
        console.log('[logger] Parsed Body (JSON):', JSON.stringify(parsedBody, null, 2));
      } catch (parseError) {
        console.log('[logger] Body Parse Error:', parseError.message);
        console.log('[logger] Body is not valid JSON');
      }
    } else {
      console.log('[logger] No body in request');
    }
    
    // Log any Retell-specific headers (if they exist)
    const retellHeaders = {};
    if (event.headers) {
      Object.keys(event.headers).forEach(key => {
        if (key.toLowerCase().includes('retell') || key.toLowerCase().includes('x-')) {
          retellHeaders[key] = event.headers[key];
        }
      });
    }
    console.log('[logger] Retell/Custom Headers:', JSON.stringify(retellHeaders, null, 2));
    
    // Return success response
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: JSON.stringify({
        message: 'Request logged successfully',
        timestamp: new Date().toISOString(),
        receivedData: {
          hasBody: !!event.body,
          bodyLength: event.body ? event.body.length : 0,
          headerCount: event.headers ? Object.keys(event.headers).length : 0,
          method: event.httpMethod
        }
      })
    };
    
  } catch (error) {
    console.error('[logger] Error in logger function:', error);
    
    // Still return success so we can see what we got
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: JSON.stringify({
        message: 'Logger function completed with error',
        error: error.message,
        timestamp: new Date().toISOString()
      })
    };
  }
};
