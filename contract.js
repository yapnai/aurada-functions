const AWS = require('aws-sdk');
const https = require('https');

// Configure AWS region
AWS.config.update({ 
  region: process.env.AWS_REGION || 'us-east-1'
});
const secretsManager = new AWS.SecretsManager();

// Function to extract customer phone number from Retell call data
function extractCustomerPhoneNumber(body) {
  // Extract the customer phone number (the number that called)
  return body.call?.from_number;
}

// Function to send contract via SMS
module.exports.sendContract = async (event) => {
  console.log('Processing contract SMS request...');
  
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

    // Extract customer phone number from Retell call data
    const customerPhone = extractCustomerPhoneNumber(requestBody);
    
    if (!customerPhone) {
      return createErrorResponse(400, 'Customer phone number not found in call data');
    }

    console.log(`Sending contract to customer: ${customerPhone}`);

    // Send SMS with contract message
    const contractMessage = "Thank you for contacting Char'd. View your contrct here: www.yapn.ai";
    const smsResult = await sendContractSMS(customerPhone, contractMessage);
    console.log('✅ Contract SMS sent successfully');

    return createSuccessResponse({
      success: true,
      message: 'Contract sent successfully',
      smsResult: smsResult
    });

  } catch (error) {
    console.error('Error in contract workflow:', error.message);
    console.error('Error stack:', error.stack);
    
    return createErrorResponse(500, 'Internal server error', { 
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// Function to send contract SMS using TextBelt
async function sendContractSMS(phoneNumber, message) {
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
      formData.append('sender', 'Char\'d');

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
