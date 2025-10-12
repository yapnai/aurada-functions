const AWS = require('aws-sdk');
const { SquareClient, SquareEnvironment, SquareError } = require('square');
const https = require('https');

// Configure AWS region (Lambda uses IAM role for credentials)
AWS.config.update({ 
  region: process.env.AWS_REGION || 'us-east-1'
});
const dynamodb = new AWS.DynamoDB.DocumentClient();
const secretsManager = new AWS.SecretsManager();

// Cache for Square credentials (separate cache for each environment)
let squareCredentialsCache = {
  sandbox: null,
  production: null
};
let squareClientCache = {
  sandbox: null,
  production: null
};

// Function to detect environment from request path
function detectEnvironmentFromPath(event) {
  const path = event.rawPath || event.path || '';
  console.log('Detecting environment from path:', path);
  
  if (path.includes('/sandbox/')) {
    console.log('Environment detected: sandbox');
    return 'sandbox';
  } else {
    console.log('Environment detected: production (default)');
    return 'production';
  }
}

// Function to get Square credentials from AWS Secrets Manager
async function getSquareCredentials(environment = 'production') {
  if (squareCredentialsCache[environment]) {
    console.log(`Using cached ${environment} credentials`);
    return squareCredentialsCache[environment];
  }
  
  try {
    // Use environment-specific secret names
    const secretId = `square-api-keys-${environment}`;
    console.log(`Retrieving Square credentials from secret: ${secretId}`);
    
    const result = await secretsManager.getSecretValue({ SecretId: secretId }).promise();
    squareCredentialsCache[environment] = JSON.parse(result.SecretString);
    
    // Initialize Square client with retrieved credentials
    squareClientCache[environment] = new SquareClient({
      token: squareCredentialsCache[environment].SQUARE_ACCESS_TOKEN,
      environment: environment === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox
    });
    
    console.log(`Successfully initialized ${environment} Square client`);
    return squareCredentialsCache[environment];
  } catch (error) {
    console.error(`Error retrieving Square credentials for ${environment}:`, error);
    throw new Error(`Failed to retrieve Square API credentials for ${environment}`);
  }
}

// Function to get Square client for specific environment
function getSquareClient(environment = 'production') {
  return squareClientCache[environment];
}

// Function to get restaurant's Square OAuth credentials from square-merchants table
async function getRestaurantSquareCredentials(restaurantName) {
  const params = {
    TableName: MERCHANTS_TABLE,
    Key: { PK: restaurantName }
  };
  
  try {
    console.log(`Getting Square credentials for restaurant: ${restaurantName}`);
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      throw new Error(`Restaurant "${restaurantName}" not found in square-merchants table. They need to authorize first.`);
    }
    
    console.log(`✅ Found OAuth credentials for: ${result.Item.business_name}`);
    return {
      access_token: result.Item.access_token,
      locations: result.Item.locations,
      merchant_id: result.Item.merchant_id,
      business_name: result.Item.business_name
    };
  } catch (error) {
    console.error('Error getting restaurant Square credentials:', error);
    throw error;
  }
}

const SESSION_CARTS_TABLE = process.env.SESSION_CARTS_TABLE || 'session-carts';
const PHONE_NUMBER_CLIENT_MAP_TABLE = process.env.PHONE_NUMBER_CLIENT_MAP_TABLE || 'phoneNumberClientMap';
const CLIENT_DATABASE_TABLE = process.env.CLIENT_DATABASE_TABLE || 'clientDatabase';
const MERCHANTS_TABLE = process.env.MERCHANTS_TABLE || 'square-merchants';

// Simple UUID alternative using timestamp and random number
function generateIdempotencyKey() {
  return `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Session cart helper functions
function extractCallId(body) {
  return body.call?.call_id;
}

function extractPhoneNumber(body) {
  // Extract the restaurant phone number (the number customer called)
  // For phone calls: use to_number
  // For web calls: fallback to default restaurant number for testing
  return body.call?.to_number || '+17037057917';
}

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

async function getRestaurantDetails(locationId) {
  if (!locationId) {
    throw new Error('Location ID is required for restaurant lookup');
  }

  const params = {
    TableName: CLIENT_DATABASE_TABLE,
    Key: { locationId: locationId }
  };

  try {
    console.log(`Getting restaurant details for location: ${locationId}`);
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      throw new Error(`No restaurant found for location ID: ${locationId}`);
    }

    console.log(`Found restaurant: ${result.Item.restaurantName} at ${result.Item.address}`);
    return {
      restaurantName: result.Item.restaurantName,
      address: result.Item.address,
      locationId: result.Item.locationId
    };
  } catch (error) {
    console.error('Error getting restaurant details:', error);
    throw error;
  }
}

async function getSessionCart(callId) {
  if (!callId) return [];
  
  const params = {
    TableName: SESSION_CARTS_TABLE,
    Key: { call_id: callId }
  };
  
  try {
    const result = await dynamodb.get(params).promise();
    return result.Item?.cart_items || [];
  } catch (error) {
    console.error('Error getting session cart:', error);
    return [];
  }
}

module.exports.createOrderAndPaymentLink = async (event) => {
  console.log('Processing session cart and creating payment link...');
  
  // Add 500ms buffer as requested
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  let cartData; // Declare for error handling scope
  
  try {
    // Detect environment from request path
    const environment = detectEnvironmentFromPath(event);
    console.log(`Operating in ${environment} environment`);
    
    // Get Square credentials for detected environment
    await getSquareCredentials(environment);
    const squareClient = getSquareClient(environment);
    
    if (!squareClient) {
      throw new Error(`Square client not initialized for ${environment} environment`);
    }

    // Essential logging - clean and focused
    console.log('Request info:', {
      path: event.rawPath,
      method: event.requestContext?.http?.method,
      environment: environment,
      bodyType: typeof event.body
    });
    
    // Parse the request body
    let requestBody;
    if (typeof event.body === 'string') {
      requestBody = JSON.parse(event.body);
    } else {
      requestBody = event.body;
    }

    // Extract call ID for session cart
    const callId = extractCallId(requestBody);
    if (!callId) {
      return createErrorResponse(400, 'Missing call ID in request');
    }

    console.log(`Creating order for call: ${callId}`);

    // Get session cart (contains full DynamoDB data)
    const sessionCart = await getSessionCart(callId);
    
    if (!sessionCart || sessionCart.length === 0) {
      return createErrorResponse(400, 'Cart is empty. Please add items first.');
    }

    // Calculate cart summary from session cart
    const subtotal = sessionCart.reduce((sum, item) => sum + item.lineTotal, 0);
    const itemCount = sessionCart.reduce((sum, item) => sum + item.quantity, 0);
    
    const cartSummary = {
      items: sessionCart,
      subtotal: subtotal,
      itemCount: itemCount,
      message: 'Tax will be calculated at checkout'
    };

    // Extract customer info and other data from request  
    const phone = requestBody.args?.phone || requestBody.phone;
    const customerName = requestBody.customerName;
    const phoneNumber = extractPhoneNumber(requestBody);
    
    // Get location ID from phone number mapping
    let locationId = requestBody.args?.locationId || requestBody.locationId;
    if (!locationId) {
      try {
        const locationData = await getLocationFromPhoneNumber(phoneNumber);
        locationId = locationData.locationId;
        console.log(`✅ Resolved location ID from phone ${phoneNumber}: ${locationId}`);
      } catch (error) {
        console.error(`❌ Failed to resolve location from phone ${phoneNumber}:`, error.message);
        // Fallback to secrets if lookup fails
        locationId = null;
      }
    }
    
    cartData = {
      updatedCart: sessionCart,
      cartSummary: cartSummary,
      customerInfo: requestBody.args?.customerInfo || requestBody.customerInfo || (phone ? { phone: phone } : null),
      customerName: customerName,
      locationId: locationId,
      checkoutOptions: requestBody.args?.checkoutOptions || requestBody.checkoutOptions,
      description: requestBody.args?.description || requestBody.description,
      phoneNumber: phoneNumber  // Add phone number for restaurant lookup
    };

    console.log('Payment link request with session cart:', {
      itemsCount: sessionCart.length,
      subtotal: subtotal,
      hasCustomerInfo: !!cartData.customerInfo,
      hasLocationId: !!cartData.locationId
    });

    // Step 1: Convert cart data to Square format (no validation needed)
    const orderResult = convertCartToSquareOrder(cartData.updatedCart, cartData.cartSummary);
    
    // Step 2: Create payment link (environment-specific)
    let paymentLinkResult;
    if (environment === 'sandbox') {
      console.log('🧪 Sandbox mode: Creating mock payment link');
      paymentLinkResult = await createMockPaymentLink({
        locationId: cartData.locationId || squareCredentialsCache[environment].SQUARE_LOCATION_ID,
        orderSummary: orderResult.orderSummary,
        description: cartData.description,
        customerName: cartData.customerName
      });
    } else {
      console.log('🏭 Production mode: Creating real Square payment link');
      
      // Get restaurant info from phone number mapping
      const locationData = await getLocationFromPhoneNumber(phoneNumber);
      const restaurantName = locationData.restaurantName; // "The Red Bird Hot Chicken & Fries"
      const restaurantLocationId = locationData.locationId; // "L1RNWD28M2J3M"
      
      console.log(`✅ Restaurant: ${restaurantName}, Location: ${restaurantLocationId}`);
      
      // Get restaurant's OAuth credentials
      const restaurantCredentials = await getRestaurantSquareCredentials(restaurantName);
      
      // Create Square client with restaurant's OAuth token
      const restaurantSquareClient = new SquareClient({
        token: restaurantCredentials.access_token,
        environment: SquareEnvironment.Production
      });
      
      console.log(`✅ Using restaurant OAuth credentials for: ${restaurantCredentials.business_name}`);
      
      paymentLinkResult = await createSquarePaymentLink({
        squareClient: restaurantSquareClient,
        locationId: cartData.locationId || restaurantLocationId,
        lineItems: orderResult.squareLineItems,
        customerInfo: cartData.customerInfo,
        orderSummary: orderResult.orderSummary,
        checkoutOptions: cartData.checkoutOptions,
        description: cartData.description
      });
    }

    // Step 3: Send SMS with payment link if customer phone is provided
    let smsResult = null;
    if (cartData.customerInfo && cartData.customerInfo.phone) {
      try {
        smsResult = await sendPaymentLinkSMS(
          cartData.customerInfo.phone,
          paymentLinkResult.paymentLink.url,
          orderResult.orderSummary,
          cartData.phoneNumber  // Pass restaurant phone number for lookup
        );
        console.log('✅ SMS sent successfully with payment link');
      } catch (smsError) {
        console.error('⚠️ SMS sending failed:', smsError.message);
        // Don't fail the whole process if SMS fails
      }
    }

    console.log(`🎉 Complete workflow successful: ${orderResult.orderSummary.itemCount} items, $${cartData.cartSummary.subtotal.toFixed(2)} subtotal + tax `);

    return createSuccessResponse({
      success: true,
      message: 'Pre-validated cart processed and payment link created successfully',
      orderSummary: orderResult.orderSummary,
      paymentLink: paymentLinkResult.paymentLink,
      smsResult: smsResult,
      squareLineItems: orderResult.squareLineItems
    });

  } catch (error) {
    console.error('Error in payment workflow:', error.message);
    console.error('Error stack:', error.stack);
    
    // Log only essential cart info, not full transcript data
    const errorContext = cartData ? {
      hasCartSummary: !!cartData.cartSummary,
      hasUpdatedCart: !!cartData.updatedCart,
      itemCount: cartData.updatedCart?.length || 0,
      hasCustomerInfo: !!cartData.customerInfo,
      hasLocationId: !!cartData.locationId
    } : { cartData: 'undefined' };
    console.error('Error context:', errorContext);
    
    return createErrorResponse(500, 'Internal server error', { 
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// Helper function to convert pre-validated cart data to Square order format
function convertCartToSquareOrder(cartItems, cartSummary) {
  console.log('Converting cart data to Square order format...');
  
  // Build Square-ready line items from DynamoDB cart data
  const squareLineItems = cartItems.map(item => {
    // Use cart's native price and currency fields
    if (!item.price || !item.currency) {
      console.error('Cart item missing price information:', JSON.stringify(item, null, 2));
      throw new Error(`Cart item "${item.item_name}" is missing price information. Please refresh cart.`);
    }
    
    // Calculate total item price including modifiers
    // item.price is in cents, modifier.price is in dollars (needs conversion)
    const modifierPriceInCents = (item.modifiers || [])
      .reduce((sum, mod) => sum + Math.round((mod.price || 0) * 100), 0);
    
    const totalPriceInCents = item.price + modifierPriceInCents;
    
    return {
      name: `${item.item_name} - Regular`,  // Hard-code "Regular" since cart no longer includes variation
      quantity: item.quantity.toString(),
      variationName: "Regular",  // Hard-code "Regular" 
      catalogObjectId: item.variation_id, // Use variation_id from cart
      basePriceMoney: {
        amount: BigInt(totalPriceInCents), // Total price including modifiers in cents
        currency: item.currency
      },
      ...(item.specialInstructions && { note: item.specialInstructions })
    };
  });

  // Use the cart summary data (Square will calculate tax automatically)
  const orderSummary = {
    items: cartItems,
    subtotal: Math.round(cartSummary.subtotal * 100), // Convert to cents
    itemCount: cartSummary.itemCount,
    // Remove tax fields - Square handles tax calculation
    taxMessage: 'Tax will be calculated at checkout',
    createdAt: new Date().toISOString()
  };

  console.log(`✅ Converted cart: ${cartItems.length} items, $${cartSummary.subtotal.toFixed(2)} subtotal (+ tax)`);

  return {
    orderSummary,
    squareLineItems
  };
}

// Helper function to process order with menu data (OLD - now unused)
async function processOrderWithMenu(items) {
  // This function is no longer needed since cart functions handle validation
  throw new Error('This function is deprecated. Use cart functions for validation.');
}

// Helper function to create mock payment link for sandbox testing
async function createMockPaymentLink({ locationId, orderSummary, description, customerName }) {
  console.log('Creating mock payment link for sandbox testing...');
  
  const timestamp = Date.now();
  const orderId = `MOCK_ORDER_${timestamp}`;
  const paymentLinkId = `mock_payment_link_${timestamp}`;
  
  // Generate realistic-looking mock URLs
  const mockUrl = `https://yapn.ai`;  // Short URL
  const mockLongUrl = `https://www.yapn.ai/order/${orderId}?ref=voice_ai`; // Long URL
  
  console.log(`✅ Mock payment link created: ${mockUrl}`);
  
  // Return same structure as real Square API response
  return {
    paymentLink: {
      id: paymentLinkId,
      version: 1,
      orderId: orderId,
      url: mockUrl,
      longUrl: mockLongUrl,
      createdAt: new Date().toISOString()
    },
    relatedResources: null
  };
}

// Helper function to create Square payment link
async function createSquarePaymentLink({ squareClient, locationId, lineItems, customerInfo, orderSummary, checkoutOptions, description }) {
  console.log('Creating Square payment link...');

  const paymentLinkRequest = {
    idempotencyKey: generateIdempotencyKey(),
    description: description || `Red Bird Chicken Order - ${orderSummary.itemCount} items`,
    order: {
      locationId: locationId,
      lineItems: lineItems,
      referenceId: `ORDER-${Date.now()}`,
      source: {
        name: `Order for ${cartData.customerName} by yapn Voice AI`
      }
    }
  };

  // Add checkout options if provided
  if (checkoutOptions) {
    paymentLinkRequest.checkoutOptions = checkoutOptions;
  }

  // Customer data pre-population disabled - keeping payment links simple
  // Square payment links work fine without pre-populated customer data
  // The customer can enter their info during checkout

  try {
    const response = await squareClient.checkout.paymentLinks.create(paymentLinkRequest);

    if (!response.paymentLink) {
      throw new Error('Payment link not found in API response');
    }

    const paymentLink = response.paymentLink;
    console.log(`✅ Payment link created: ${paymentLink.url}`);

    return {
      paymentLink: {
        id: paymentLink.id,
        version: paymentLink.version,
        orderId: paymentLink.orderId,
        url: paymentLink.url,
        longUrl: paymentLink.longUrl,
        createdAt: paymentLink.createdAt
      },
      relatedResources: response.relatedResources || null
    };

  } catch (error) {
    console.error('Square payment link creation failed:', error.message);
    if (error instanceof SquareError) {
      console.error('Square API Error Details:', {
        statusCode: error.statusCode,
        errors: error.errors
      });
    }
    throw error;
  }
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
    body: JSON.stringify(data, (key, value) => {
      // Handle BigInt serialization
      if (typeof value === 'bigint') {
        return value.toString();
      }
      return value;
    })
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

// Function to send payment link via SMS using TextBelt
async function sendPaymentLinkSMS(phoneNumber, paymentLinkUrl, orderSummary, restaurantPhoneNumber) {
  return new Promise(async (resolve, reject) => {
    try {
      // Get restaurant details for dynamic SMS
      let restaurantName = 'Restaurant';
      let address = 'Restaurant location';
      
      try {
        const locationData = await getLocationFromPhoneNumber(restaurantPhoneNumber);
        const restaurantDetails = await getRestaurantDetails(locationData.locationId);
        restaurantName = restaurantDetails.restaurantName;
        address = restaurantDetails.address;
        console.log(`Using dynamic restaurant data: ${restaurantName} at ${address}`);
      } catch (lookupError) {
        console.error('Failed to get restaurant details, using generic message:', lookupError.message);
        restaurantName = null;
        address = null;
      }

      // Get TextBelt API key from Secrets Manager
      const textbeltResult = await secretsManager.getSecretValue({ SecretId: 'textbelt-api-key' }).promise();
      const textbeltApiKey = textbeltResult.SecretString;

      // Create order summary for SMS
      const itemCount = orderSummary.itemCount;
      const subtotal = (orderSummary.subtotal / 100).toFixed(2);
      
      // Build item list for SMS
      let itemList = '';
      if (orderSummary.items && orderSummary.items.length > 0) {
        const topItems = orderSummary.items.slice(0, 3); // Show first 3 items
        itemList = topItems.map(item => 
          `${item.quantity}x ${item.name}`
        ).join(', ');
        
        if (orderSummary.items.length > 3) {
          itemList += ` +${orderSummary.items.length - 3} more`;
        }
        itemList = `Your order: ${itemList}. `;
      }

      // Format the SMS message with dynamic restaurant data (graceful fallback for missing data)
      const restaurantPart = restaurantName ? `from ${restaurantName} ` : '';
      const addressPart = address ? `Pick up at: ${address}.` : '';
      const message = `Your order ${restaurantPart}is almost ready! \n${itemList}Subtotal: $${subtotal} (+ tax). \nComplete your payment here: ${paymentLinkUrl}. \n${addressPart}`;

      // Prepare form data for TextBelt
      const formData = new URLSearchParams();
      formData.append('phone', phoneNumber);
      formData.append('message', message);
      formData.append('key', textbeltApiKey);
      formData.append('sender', restaurantName || 'Restaurant');

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