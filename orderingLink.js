const AWS = require('aws-sdk');
const https = require('https');

// Configure AWS region
AWS.config.update({ 
  region: process.env.AWS_REGION || 'us-east-1'
});
const secretsManager = new AWS.SecretsManager();
const dynamodb = new AWS.DynamoDB.DocumentClient();

const CLIENT_DATABASE_TABLE = process.env.CLIENT_DATABASE_TABLE || 'clientDatabase';
const PHONE_NUMBER_CLIENT_MAP_TABLE = 'phoneNumberClientMap';

// Function to extract customer phone number from Retell call data
function extractCustomerPhoneNumber(body) {
  // Extract the customer phone number (the number that called)
  return body.call?.from_number;
}

// Function to extract restaurant phone number from Retell call data (fallback)
function extractRestaurantPhoneNumber(body) {
  // Extract the restaurant phone number (the number customer called)
  return body.call?.to_number;
}

// Function to get location ID from restaurant phone number (fallback)
async function getLocationFromPhoneNumber(phoneNumber) {
  if (!phoneNumber) {
    throw new Error('Phone number is required for location lookup');
  }

  const params = {
    TableName: PHONE_NUMBER_CLIENT_MAP_TABLE,
    Key: { phoneNumber: phoneNumber }
  };

  try {
    console.log(`Looking up location for phone number: ${phoneNumber}`);
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      throw new Error(`No location found for phone number: ${phoneNumber}`);
    }

    console.log(`Found location: ${result.Item.restaurantName} - ${result.Item.locationId}`);
    return {
      locationId: result.Item.locationId,
      restaurantName: result.Item.restaurantName
    };
  } catch (error) {
    console.error('Error looking up location:', error);
    throw error;
  }
}

// Function to get restaurant ordering data from clientDatabase
async function getRestaurantOrderingData(locationId) {
  if (!locationId) {
    throw new Error('Location ID is required');
  }

  const params = {
    TableName: CLIENT_DATABASE_TABLE,
    Key: { locationId: locationId }
  };

  try {
    console.log(`Getting restaurant data for location: ${locationId}`);
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      throw new Error(`No restaurant found for location ID: ${locationId}`);
    }

    console.log(`Found restaurant: ${result.Item.restaurantName}`);
    return result.Item;
  } catch (error) {
    console.error('Error getting restaurant data:', error);
    throw error;
  }
}

// Function to build dynamic ordering message
function buildOrderingMessage(restaurantData) {
  const restaurantName = restaurantData.restaurantName || 'Restaurant';
  
  // Base greeting
  let message = `Thank you for calling ${restaurantName}!`;
  
  // Get order links
  const orderLinks = restaurantData.orderLinks;
  const pickupLink = orderLinks?.pickupLink;
  const deliveryLinks = orderLinks?.deliveryLinks;
  
  // Add pickup section if link exists
  if (pickupLink) {
    message += ` To place a pick-up order please visit us at ${pickupLink}`;
  }
  
  // Add delivery section if links exist
  if (deliveryLinks && Array.isArray(deliveryLinks) && deliveryLinks.length > 0) {
    message += `\n\nIf you'd like your order delivered to your doorstep visit us at:`;
    deliveryLinks.forEach(link => {
      message += `\n${link}`;
    });
  }
  
  // Fallback if no links available
  if (!pickupLink && (!deliveryLinks || deliveryLinks.length === 0)) {
    message += ` Please call us directly to place your order.`;
  }
  
  // Add "powered by Yapn AI" at the bottom
  message += `\n\nPowered by Yapn AI`;
  
  return message;
}

// Function to send ordering links via SMS
module.exports.sendOrderingLink = async (event) => {
  console.log('Processing ordering link SMS request...');
  
  try {
    // Essential logging
    console.log('Request info:', {
      path: event.rawPath,
      method: event.requestContext?.http?.method,
      bodyType: typeof event.body
    });
    
    // Parse the request body
    let requestBody;
    if (typeof event.body === 'string') {
      requestBody = JSON.parse(event.body);
    } else {
      requestBody = event.body || {};
    }

    // Extract locationId from request (optional now)
    let locationId = requestBody.locationId;
    
    // Extract customer phone number from Retell call data
    const customerPhone = extractCustomerPhoneNumber(requestBody);
    
    if (!customerPhone) {
      return createErrorResponse(400, 'Customer phone number not found in call data');
    }

    // Fallback: get locationId from phone number if missing or invalid
    if (!locationId) {
      console.log('No locationId provided, falling back to phone number lookup');
      try {
        const restaurantPhone = extractRestaurantPhoneNumber(requestBody);
        if (!restaurantPhone) {
          return createErrorResponse(400, 'No locationId provided and restaurant phone number not found in call data');
        }
        
        const locationData = await getLocationFromPhoneNumber(restaurantPhone);
        locationId = locationData.locationId;
        console.log(`✅ Fallback successful: resolved locationId ${locationId} from phone ${restaurantPhone}`);
      } catch (error) {
        return createErrorResponse(400, `No locationId provided and phone number lookup failed: ${error.message}`);
      }
    }

    console.log(`Processing order links for location: ${locationId}, customer: ${customerPhone}`);

    // Get restaurant data from database
    let restaurantData;
    try {
      restaurantData = await getRestaurantOrderingData(locationId);
    } catch (error) {
      if (error.message.includes('No restaurant found')) {
        return createErrorResponse(404, `Restaurant not found for location: ${locationId}`);
      }
      throw error; // Re-throw other database errors
    }

    // Build dynamic message
    const dynamicMessage = buildOrderingMessage(restaurantData);

    // Send SMS with dynamic message
    const smsResult = await sendOrderingLinkSMS(customerPhone, dynamicMessage);
    console.log('✅ Dynamic ordering links SMS sent successfully');

    return createSuccessResponse({
      success: true,
      message: 'Ordering links sent successfully',
      restaurantName: restaurantData.restaurantName,
      smsResult: smsResult
    });

  } catch (error) {
    console.error('Error in ordering link workflow:', error.message);
    console.error('Error stack:', error.stack);
    
    return createErrorResponse(500, 'Internal server error', { 
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// Function to send ordering links SMS using TextBelt
async function sendOrderingLinkSMS(phoneNumber, message) {
  return new Promise(async (resolve, reject) => {
    try {
      // Get TextBelt API key from Secrets Manager
      const textbeltResult = await secretsManager.getSecretValue({ SecretId: 'textbelt-api-key' }).promise();
      const textbeltApiKey = textbeltResult.SecretString;

      // Prepare form data for TextBelt
      const formData = new URLSearchParams();
      formData.append('phone', phoneNumber);
      formData.append('message', message);
      formData.append('key', textbeltApiKey);
      formData.append('sender', 'Red Bird Chicken');

      const postData = formData.toString();

      const options = {
        hostname: 'textbelt.com',
        port: 443,
        path: '/text',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.success) {
              resolve(result);
            } else {
              reject(new Error(`TextBelt error: ${result.error}`));
            }
          } catch (parseError) {
            reject(new Error(`Failed to parse TextBelt response: ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(postData);
      req.end();

    } catch (secretError) {
      reject(new Error(`Failed to get TextBelt API key: ${secretError.message}`));
    }
  });
}

// Helper function to create success response
function createSuccessResponse(data) {
  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    },
    body: JSON.stringify(data)
  };
}

// Helper function to create error response
function createErrorResponse(statusCode, message, additionalData = {}) {
  return {
    statusCode: statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    },
    body: JSON.stringify({
      error: message,
      ...additionalData
    })
  };
}
