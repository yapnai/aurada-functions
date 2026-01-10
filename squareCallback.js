const AWS = require('aws-sdk');
const https = require('https');
const { v4: uuidv4 } = require('uuid');

// Configure AWS
AWS.config.update({ 
  region: process.env.AWS_REGION || 'us-east-1'
});

const dynamodb = new AWS.DynamoDB.DocumentClient();
const secretsManager = new AWS.SecretsManager();

// Cache for Square OAuth credentials
let oauthCredentials = null;

// Table names
const OAUTH_STATE_TABLE = process.env.OAUTH_STATE_TABLE || 'square-oauth-state';
const MERCHANTS_TABLE = process.env.MERCHANTS_TABLE || 'square-merchants-v2';

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

module.exports.callback = async (event) => {
  console.log('Processing Square OAuth callback...');
  console.log('Event structure:', JSON.stringify(event, null, 2));
  
  try {
    // Get OAuth credentials
    const credentials = await getOAuthCredentials();
    
    // Extract parameters from callback - handle both HTTP API v1 and v2 formats
    let queryParams = {};
    
    if (event.queryStringParameters) {
      // HTTP API v1 format
      queryParams = event.queryStringParameters;
    } else if (event.rawQueryString) {
      // HTTP API v2 format - parse the raw query string
      const urlParams = new URLSearchParams(event.rawQueryString);
      queryParams = Object.fromEntries(urlParams.entries());
    } else if (event.query) {
      // Another HTTP API v2 format
      queryParams = event.query;
    }
    
    console.log('Extracted query parameters:', queryParams);
    
    const authorizationCode = queryParams.code;
    let state = queryParams.state;
    const error = queryParams.error;
    
    // Handle authorization errors (user denied, etc.)
    if (error) {
      console.log('Authorization failed:', error);
      return createErrorPageResponse('Authorization Failed', 
        `The Square authorization was not completed. Error: ${error}`);
    }
    
    // Validate required parameters
    if (!authorizationCode) {
      console.error('Missing authorization code');
      console.error('Raw event queryStringParameters:', event.queryStringParameters);
      console.error('Raw event rawQueryString:', event.rawQueryString);
      return createErrorPageResponse('Invalid Request', 
        'Missing authorization code from Square.');
    }
    
    // Validate state parameter (CSRF protection) - with fallback for Square's mobile OAuth issues
    let stateData = null;
    
    if (state) {
      // Preferred: Use the state parameter if provided (desktop flow)
      console.log('State parameter provided:', state);
      stateData = await validateAndGetState(state);
      if (!stateData) {
        console.error('Invalid or expired state parameter:', state);
        return createErrorPageResponse('Invalid Request', 
          'The authorization request has expired or is invalid. Please try again.');
      }
    } else {
      // Fallback: Square mobile doesn't return state parameter consistently
      console.log('No state parameter from Square - using fallback method (likely mobile OAuth)');
      stateData = await findMostRecentValidState();
      if (!stateData) {
        console.error('No valid pending authorization found');
        return createErrorPageResponse('Invalid Request', 
          'No pending authorization found. Please restart the authorization process.');
      }
      console.log('Found pending authorization for restaurant:', stateData.restaurant_id);
      // Set state for any cleanup or logging that might need it
      state = stateData.state;
    }
    
    console.log('Valid state found for restaurant:', stateData.restaurant_id);
    
    // Exchange authorization code for tokens
    const callbackUrl = getCallbackUrl(event);
    const tokenData = await exchangeCodeForTokens(authorizationCode, credentials, callbackUrl);
    console.log('Token exchange successful:', {
      merchant_id: tokenData.merchant_id,
      expires_at: tokenData.expires_at,
      token_type: tokenData.token_type,
      access_token_prefix: tokenData.access_token ? tokenData.access_token.substring(0, 20) + '...' : 'null'
    });
    
    // Get merchant and location info
    const merchantInfo = await getMerchantInfo(tokenData.access_token, credentials);
    console.log('Merchant info retrieved:', JSON.stringify(merchantInfo, null, 2));
    
    const locationData = await getLocationInfo(tokenData.access_token, credentials);
    console.log('Location data retrieved:', JSON.stringify(locationData, null, 2));
    
    // Store merchant data, tokens, and locations
    await storeMerchantData(stateData.restaurant_id, tokenData, merchantInfo, locationData);
    
    // Note: Not cleaning up state data for now to support mobile OAuth fallback
    // TODO: Add cleanup job later to remove old OAuth states
    
    console.log('Successfully authorized restaurant:', stateData.restaurant_id);
    console.log('Merchant name:', merchantInfo.businessName);
    console.log('Locations found:', locationData.length);
    console.log('Location IDs:', locationData.map(loc => `${loc.name}: ${loc.id}`).join(', '));
    
    // Return success page
    return createSuccessPageResponse(merchantInfo, stateData.restaurant_id, locationData);
    
  } catch (error) {
    console.error('Error in Square OAuth callback:', error);
    
    return createErrorPageResponse('Authorization Error', 
      'An error occurred while processing your Square authorization. Please try again.');
  }
};

// Helper function to validate and retrieve state data
async function validateAndGetState(state) {
  const params = {
    TableName: OAUTH_STATE_TABLE,
    Key: { state: state }
  };
  
  try {
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      return null;
    }
    
    // Check if state has expired
    const now = Math.floor(Date.now() / 1000);
    if (result.Item.expires_at < now) {
      console.log('State expired:', state);
      return null;
    }
    
    return result.Item;
    
  } catch (error) {
    console.error('Error validating state:', error);
    return null;
  }
}

// Helper function to find the most recent valid OAuth state when Square doesn't return state parameter
async function findMostRecentValidState() {
  const params = {
    TableName: OAUTH_STATE_TABLE
  };
  
  try {
    const result = await dynamodb.scan(params).promise();
    
    if (!result.Items || result.Items.length === 0) {
      return null;
    }
    
    const now = Math.floor(Date.now() / 1000);
    
    // Filter to only non-expired states and sort by creation time (most recent first)
    const validStates = result.Items
      .filter(item => item.expires_at > now)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    if (validStates.length === 0) {
      return null;
    }
    
    // Return the most recent valid state
    console.log(`Found ${validStates.length} valid pending state(s), using most recent`);
    console.log('Selected state for restaurant:', validStates[0].restaurant_id);
    return validStates[0];
    
  } catch (error) {
    console.error('Error finding valid OAuth state:', error);
    return null;
  }
}

// Helper function to exchange authorization code for tokens
async function exchangeCodeForTokens(code, credentials, redirectUri) {
  return new Promise((resolve, reject) => {
    const tokenEndpoint = credentials.SQUARE_ENVIRONMENT === 'production' 
      ? 'connect.squareup.com'
      : 'connect.squareupsandbox.com';
    
    const postData = JSON.stringify({
      client_id: credentials.SQUARE_APPLICATION_ID,
      client_secret: credentials.SQUARE_APPLICATION_SECRET,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });
    
    const options = {
      hostname: tokenEndpoint,
      port: 443,
      path: '/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Square-Version': '2025-06-18'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const responseData = JSON.parse(data);
          console.log('Raw Square token exchange response:', JSON.stringify(responseData, null, 2));
          
          if (res.statusCode === 200) {
            console.log('Successfully exchanged code for tokens');
            resolve(responseData);
          } else {
            console.error('Token exchange failed:', responseData);
            reject(new Error(`Token exchange failed: ${responseData.error || 'Unknown error'}`));
          }
        } catch (parseError) {
          console.error('Error parsing token response:', parseError);
          reject(new Error('Invalid response from Square token endpoint'));
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('HTTP request error:', error);
      reject(error);
    });
    
    req.write(postData);
    req.end();
  });
}

// Helper function to get merchant info
async function getMerchantInfo(accessToken, credentials) {
  return new Promise((resolve, reject) => {
    const apiEndpoint = credentials.SQUARE_ENVIRONMENT === 'production' 
      ? 'connect.squareup.com'
      : 'connect.squareupsandbox.com';
    
    const options = {
      hostname: apiEndpoint,
      port: 443,
      path: '/v2/merchants',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Square-Version': '2025-06-18'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const responseData = JSON.parse(data);
          
          if (res.statusCode === 200 && responseData.merchant) {
            resolve({
              businessName: responseData.merchant[0].business_name,
              merchantId: responseData.merchant[0].id,
              country: responseData.merchant[0].country,
              currency: responseData.merchant[0].currency
            });
          } else {
            console.error('Merchant info request failed:', responseData);
            resolve({
              businessName: 'Your Restaurant',
              merchantId: 'unknown',
              country: 'US',
              currency: 'USD'
            });
          }
        } catch (parseError) {
          console.error('Error parsing merchant response:', parseError);
          resolve({
            businessName: 'Your Restaurant',
            merchantId: 'unknown',
            country: 'US',
            currency: 'USD'
          });
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('Merchant info request error:', error);
      resolve({
        businessName: 'Your Restaurant',
        merchantId: 'unknown',
        country: 'US',
        currency: 'USD'
      });
    });
    
    req.end();
  });
}

// Helper function to get location info
async function getLocationInfo(accessToken, credentials) {
  return new Promise((resolve, reject) => {
    const apiEndpoint = credentials.SQUARE_ENVIRONMENT === 'production' 
      ? 'connect.squareup.com'
      : 'connect.squareupsandbox.com';
    
    const options = {
      hostname: apiEndpoint,
      port: 443,
      path: '/v2/locations',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Square-Version': '2025-06-18'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const responseData = JSON.parse(data);
          console.log('Raw Square locations API response:', JSON.stringify(responseData, null, 2));
          
          if (res.statusCode === 200 && responseData.locations) {
            console.log('Successfully retrieved locations:', responseData.locations.length);
            resolve(responseData.locations);
          } else {
            console.error('Location info request failed:', responseData);
            resolve([]); // Return empty array if no locations found
          }
        } catch (parseError) {
          console.error('Error parsing location response:', parseError);
          resolve([]);
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('Location info request error:', error);
      resolve([]);
    });
    
    req.end();
  });
}

// Helper function to store merchant data
async function storeMerchantData(restaurantId, tokenData, merchantInfo, locationData) {
  // Generate SK from merchant_id to ensure uniqueness
  // restaurantId is the groupId (e.g., FALAFEL_INC_GROUP)
  // SK will be a unique identifier for this specific merchant account
  const merchantSK = `MERCHANT_${tokenData.merchant_id}`;
  
  const params = {
    TableName: MERCHANTS_TABLE,
    Item: {
      PK: restaurantId,                      // Group ID (from authorize link)
      SK: merchantSK,                        // Unique merchant identifier
      merchant_id: tokenData.merchant_id,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: tokenData.expires_at,
      token_type: tokenData.token_type,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: 'active',
      business_name: merchantInfo.businessName,
      country: merchantInfo.country,
      currency: merchantInfo.currency,
      locations: locationData.map(loc => ({
        id: loc.id,
        name: loc.name,
        country: loc.country,
        currency: loc.currency,
        language: loc.language,
        status: loc.status,
        timezone: loc.timezone,
        capabilities: loc.capabilities,
        capabilities_supported: loc.capabilities_supported,
        created_at: loc.created_at,
        updated_at: loc.updated_at
      }))
    }
  };
  
  try {
    console.log('Storing merchant data for restaurant:', restaurantId);
    console.log('Data to store:', JSON.stringify(params.Item, null, 2));
    
    await dynamodb.put(params).promise();
    console.log('Successfully stored merchant data for restaurant:', restaurantId);
  } catch (error) {
    console.error('Error storing merchant data:', error);
    throw error;
  }
}

// Helper function to clean up state data
async function cleanupState(state) {
  const params = {
    TableName: OAUTH_STATE_TABLE,
    Key: { state: state }
  };
  
  try {
    await dynamodb.delete(params).promise();
    console.log('Cleaned up state:', state);
  } catch (error) {
    console.error('Error cleaning up state:', error);
    // Don't throw error - this is cleanup
  }
}

// Helper function to create success page response
function createSuccessPageResponse(merchantInfo, restaurantId, locationData) {
  const successPage = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Square Authorization Successful</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; background-color: #f5f5f5; }
            .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .success { color: #28a745; text-align: center; }
            .info { background: #e7f3ff; padding: 15px; border-radius: 5px; margin: 20px 0; }
            .button { display: inline-block; background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1 class="success">✅ Square Authorization Successful!</h1>
            
            <div class="info">
                <h3>Restaurant Details:</h3>
                <p><strong>Business Name:</strong> ${merchantInfo.businessName}</p>
                <p><strong>Restaurant ID:</strong> ${restaurantId}</p>
                <p><strong>Status:</strong> Connected to Square</p>
                
                <h3>Locations Found:</h3>
                ${locationData.map(loc => `
                    <div style="margin: 10px 0; padding: 10px; border: 1px solid #ddd; border-radius: 5px;">
                        <p><strong>Name:</strong> ${loc.name}</p>
                        <p><strong>Location ID:</strong> ${loc.id}</p>
                        <p><strong>Status:</strong> ${loc.status}</p>
                        <p><strong>Country:</strong> ${loc.country}</p>
                    </div>
                `).join('')}
            </div>
            
            <h3>What's Next?</h3>
            <ul>
                <li>Your Square account is now connected to our voice ordering system</li>
                <li>Customers can now place orders through our AI phone system</li>
                <li>Payment links will be automatically created using your Square account</li>
                <li>You'll receive SMS notifications for new orders</li>
            </ul>
            
            <h3>Support</h3>
            <p>If you have any questions or need help, please contact our support team.</p>
            
            <div style="text-align: center; margin-top: 30px;">
                <p><em>You can now close this window.</em></p>
            </div>
        </div>
    </body>
    </html>
  `;
  
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    },
    body: successPage
  };
}

// Helper function to create error page response
function createErrorPageResponse(title, message) {
  const errorPage = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Square Authorization Error</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; background-color: #f5f5f5; }
            .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .error { color: #dc3545; text-align: center; }
            .info { background: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #ffc107; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1 class="error">❌ ${title}</h1>
            
            <div class="info">
                <p>${message}</p>
            </div>
            
            <h3>What to do next:</h3>
            <ul>
                <li>Please contact support if this error persists</li>
                <li>You can try the authorization process again</li>
                <li>Make sure you're using the correct authorization link</li>
            </ul>
            
            <div style="text-align: center; margin-top: 30px;">
                <p><em>You can close this window and try again.</em></p>
            </div>
        </div>
    </body>
    </html>
  `;
  
  return {
    statusCode: 400,
    headers: {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    },
    body: errorPage
  };
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