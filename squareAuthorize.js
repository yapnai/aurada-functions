const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

// Configure AWS
AWS.config.update({ 
  region: process.env.AWS_REGION || 'us-east-1'
});

const dynamodb = new AWS.DynamoDB.DocumentClient();
const secretsManager = new AWS.SecretsManager();

// Cache for Square OAuth credentials
let oauthCredentials = null;

// Table to store temporary OAuth state
const OAUTH_STATE_TABLE = process.env.OAUTH_STATE_TABLE || 'square-oauth-state';

// Function to get Square OAuth credentials from AWS Secrets Manager
async function getOAuthCredentials() {
  if (oauthCredentials) {
    return oauthCredentials;
  }
  
  try {
    console.log('Attempting to retrieve OAuth credentials from Secrets Manager...');
    const result = await secretsManager.getSecretValue({ SecretId: 'square-oauth-keys' }).promise();
    oauthCredentials = JSON.parse(result.SecretString);
    console.log('Successfully retrieved OAuth credentials from Secrets Manager');
    console.log('Application ID found:', oauthCredentials.SQUARE_APPLICATION_ID ? 'Yes' : 'No');
    console.log('Application Secret found:', oauthCredentials.SQUARE_APPLICATION_SECRET ? 'Yes' : 'No');
    console.log('Environment:', oauthCredentials.SQUARE_ENVIRONMENT);
    return oauthCredentials;
  } catch (error) {
    console.error('Error retrieving Square OAuth credentials from Secrets Manager:', error);
    console.error('Error details:', {
      code: error.code,
      message: error.message,
      statusCode: error.statusCode
    });
    throw new Error('Failed to retrieve Square OAuth credentials');
  }
}

module.exports.authorize = async (event) => {
  console.log('Starting Square OAuth authorization...');
  
  try {
    // Get OAuth credentials
    const credentials = await getOAuthCredentials();
    
    // Extract restaurant/merchant identifier from query parameters
    const queryParams = event.queryStringParameters || {};
    const restaurantId = queryParams.restaurant_id || queryParams.agent_number || queryParams.merchant_id;
    
    if (!restaurantId) {
      return createErrorResponse(400, 'Missing required parameter: restaurant_id (or agent_number/merchant_id)');
    }
    
    console.log('Authorizing restaurant:', restaurantId);
    
    // Generate secure state parameter for CSRF protection
    const state = uuidv4();
    
    // Store state temporarily in DynamoDB (expires in 10 minutes)
    await storeOAuthState(state, restaurantId);
    
    // Build Square authorization URL
    const baseUrl = credentials.SQUARE_ENVIRONMENT === 'production' 
      ? 'https://connect.squareup.com/oauth2/authorize'
      : 'https://connect.squareupsandbox.com/oauth2/authorize';
    
    // Essential scopes for menu management and payments
    const scopes = [
      'MERCHANT_PROFILE_READ',         // Basic business info
      'ORDERS_READ',                   // Read order data
      'ORDERS_WRITE',                  // Create orders and payment links
      'PAYMENTS_WRITE',                // Create payment links
      'ITEMS_READ',                    // Get catalog/menu items
      'ITEMS_WRITE',                   // Update menu items (optional)
      'INVENTORY_READ'                 // Check item availability
    ].join(' ');
    
    // Get the callback URL (your API Gateway endpoint)
    const callbackUrl = getCallbackUrl(event);
    
    // Build authorization parameters
    const authParams = {
      client_id: credentials.SQUARE_APPLICATION_ID,
      scope: scopes,
      redirect_uri: callbackUrl,
      state: state,
      response_type: 'code'
    };
    
    // Add session=false for production (required)
    if (credentials.SQUARE_ENVIRONMENT === 'production') {
      authParams.session = 'false';
    }
    
    const authorizationUrl = `${baseUrl}?` + new URLSearchParams(authParams);
    
    console.log('Generated authorization URL for restaurant:', restaurantId);
    console.log('State parameter:', state);
    console.log('🔗 FULL AUTHORIZATION URL:', authorizationUrl);
    
    // Redirect to Square authorization page
    return {
      statusCode: 302,
      headers: {
        'Location': authorizationUrl,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      body: ''
    };
    
  } catch (error) {
    console.error('Error in Square OAuth authorization:', error);
    
    return createErrorResponse(500, 'Internal server error', { 
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// Helper function to store OAuth state temporarily
async function storeOAuthState(state, restaurantId) {
  const params = {
    TableName: OAUTH_STATE_TABLE,
    Item: {
      state: state,
      restaurant_id: restaurantId,
      created_at: new Date().toISOString(),
      expires_at: Math.floor(Date.now() / 1000) + (10 * 60) // 10 minutes from now
    }
  };
  
  try {
    await dynamodb.put(params).promise();
    console.log('Stored OAuth state:', state);
  } catch (error) {
    console.error('Error storing OAuth state:', error);
    throw error;
  }
}

// Helper function to get callback URL from the current request
function getCallbackUrl(event) {
  const domain = event.requestContext?.domainName || event.headers?.Host;
  
  if (!domain) {
    throw new Error('Could not determine callback URL from request');
  }
  
  // For HTTP API v2, the default stage doesn't need to be in the path
  // The callback URL should be: https://domain/square/callback
  const protocol = 'https';
  const callbackUrl = `${protocol}://${domain}/square/callback`;
  
  console.log('Callback URL:', callbackUrl);
  return callbackUrl;
}

// Helper function to create error response
function createErrorResponse(statusCode, message, additionalData = {}) {
  return {
    statusCode: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    },
    body: JSON.stringify({
      error: message,
      ...additionalData
    })
  };
} 