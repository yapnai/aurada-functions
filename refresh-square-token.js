// Refresh Square access tokens using refresh tokens
require('dotenv').config();
const AWS = require('aws-sdk');
const https = require('https');

// Configure AWS
AWS.config.update({ region: 'us-east-1' });
const dynamodb = new AWS.DynamoDB.DocumentClient();
const secretsManager = new AWS.SecretsManager();

const MERCHANTS_TABLE = 'square-merchants';

// Function to get OAuth credentials from AWS Secrets Manager
async function getOAuthCredentials() {
  try {
    console.log('🔐 Retrieving OAuth credentials from Secrets Manager...');
    const result = await secretsManager.getSecretValue({ SecretId: 'square-oauth-keys' }).promise();
    const credentials = JSON.parse(result.SecretString);
    console.log('✅ OAuth credentials retrieved successfully');
    return credentials;
  } catch (error) {
    console.error('❌ Error retrieving OAuth credentials:', error);
    throw new Error('Failed to retrieve Square OAuth credentials');
  }
}

// Function to refresh access token using refresh token
async function refreshAccessToken(refreshToken, credentials) {
  return new Promise((resolve, reject) => {
    const tokenEndpoint = credentials.SQUARE_ENVIRONMENT === 'production' 
      ? 'connect.squareup.com'
      : 'connect.squareupsandbox.com';
    
    const postData = JSON.stringify({
      client_id: credentials.SQUARE_APPLICATION_ID,
      client_secret: credentials.SQUARE_APPLICATION_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
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
    
    console.log(`🔄 Making refresh request to ${tokenEndpoint}/oauth2/token`);
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const responseData = JSON.parse(data);
          
          if (res.statusCode === 200) {
            console.log('✅ Token refresh successful!');
            console.log('New token expires at:', responseData.expires_at);
            resolve(responseData);
          } else {
            console.error('❌ Token refresh failed:', responseData);
            reject(new Error(`Token refresh failed: ${responseData.error || 'Unknown error'}`));
          }
        } catch (parseError) {
          console.error('❌ Error parsing refresh response:', parseError);
          reject(new Error('Invalid response from Square token endpoint'));
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('❌ HTTP request error:', error);
      reject(error);
    });
    
    req.write(postData);
    req.end();
  });
}

// Function to update merchant data with new tokens
async function updateMerchantTokens(restaurantId, newTokenData) {
  const updateParams = {
    TableName: MERCHANTS_TABLE,
    Key: {
      PK: restaurantId
    },
    UpdateExpression: 'SET access_token = :access_token, refresh_token = :refresh_token, expires_at = :expires_at, updated_at = :updated_at',
    ExpressionAttributeValues: {
      ':access_token': newTokenData.access_token,
      ':refresh_token': newTokenData.refresh_token,
      ':expires_at': newTokenData.expires_at,
      ':updated_at': new Date().toISOString()
    }
  };
  
  try {
    await dynamodb.update(updateParams).promise();
    console.log(`✅ Updated tokens for restaurant: ${restaurantId}`);
  } catch (error) {
    console.error(`❌ Error updating tokens for ${restaurantId}:`, error);
    throw error;
  }
}

// Main function to refresh tokens for a restaurant
async function refreshSquareTokens(restaurantId = 'redbird-prod') {
  try {
    console.log(`🚀 Starting token refresh for restaurant: ${restaurantId}`);
    
    // 1. Get current merchant data
    console.log('📊 Retrieving current merchant data...');
    const params = {
      TableName: MERCHANTS_TABLE,
      Key: {
        PK: restaurantId
      }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      throw new Error(`Restaurant not found in square-merchants table: ${restaurantId}`);
    }
    
    const merchantData = result.Item;
    console.log(`🏪 Found restaurant: ${merchantData.business_name}`);
    
    // 2. Check if we have a refresh token
    if (!merchantData.refresh_token) {
      throw new Error('No refresh token found! Restaurant needs to re-authorize.');
    }
    
    console.log('🔑 Refresh token found, proceeding with refresh...');
    
    // 3. Get OAuth credentials
    const credentials = await getOAuthCredentials();
    
    // 4. Refresh the access token
    const newTokenData = await refreshAccessToken(merchantData.refresh_token, credentials);
    
    // 5. Update the merchant record with new tokens
    await updateMerchantTokens(restaurantId, newTokenData);
    
    console.log('🎉 Token refresh completed successfully!');
    console.log(`✅ New access token expires: ${newTokenData.expires_at}`);
    console.log(`🔑 New token starts with: ${newTokenData.access_token.substring(0, 10)}...`);
    
    return {
      success: true,
      restaurantId: restaurantId,
      businessName: merchantData.business_name,
      newExpiresAt: newTokenData.expires_at,
      tokenPrefix: newTokenData.access_token.substring(0, 10)
    };
    
  } catch (error) {
    console.error('❌ Error refreshing tokens:', error);
    throw error;
  }
}

// Export for use in other modules
module.exports = {
  refreshSquareTokens,
  refreshAccessToken,
  updateMerchantTokens
};

// Run if called directly
if (require.main === module) {
  refreshSquareTokens()
    .then(result => {
      console.log('\n🎊 SUCCESS! Token refresh completed:');
      console.log(`Restaurant: ${result.businessName}`);
      console.log(`New expiration: ${result.newExpiresAt}`);
    })
    .catch(error => {
      console.error('\n💥 FAILED! Token refresh error:', error.message);
      process.exit(1);
    });
}
