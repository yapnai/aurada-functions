const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();

const TABLE_NAME = process.env.YAPN_ANALYTICS_TABLE || 'yapn-analytics';

module.exports.handlePostCallAnalysis = async (event) => {
  console.log('Handling post-call analysis webhook...');
  
  try {
    // Parse the request body
    let body;
    if (typeof event.body === 'string') {
      body = JSON.parse(event.body);
    } else {
      body = event.body;
    }

    // Log only essential info, not the full payload with transcripts/timestamps
    console.log('Processing post-call analysis for event:', body.event);

    // Validate that this is a call_analyzed event
    if (body.event !== 'call_analyzed') {
      console.error('Invalid event type:', body.event);
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        body: JSON.stringify({
          error: 'Invalid event type. Expected call_analyzed',
          received: body.event
        })
      };
    }

    // Extract analysis data from call.call_analysis
    const callAnalysis = body.call?.call_analysis;
    if (!callAnalysis) {
      console.error('Missing call_analysis object');
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        body: JSON.stringify({
          error: 'Missing call_analysis object'
        })
      };
    }

    // Extract order details and upsell from custom_analysis_data
    const customData = callAnalysis.custom_analysis_data || {};
    const orderDetails = customData.order_details || '';
    const upsell = customData._upsell || '';
    
    // Extract restaurant phone from call data
    const restaurantPhone = body.call?.to_number || '+17039699580';

    console.log('Order details:', orderDetails);
    console.log('Upsell:', upsell);
    console.log('Restaurant phone:', restaurantPhone);

    // Parse and filter items
    const orderedItems = parseAndFilterItems(orderDetails);
    const upsoldItems = parseAndFilterItems(upsell);

    console.log('Parsed ordered items:', orderedItems);
    console.log('Parsed upsold items:', upsoldItems);

    // Update DynamoDB
    await updateAnalytics(restaurantPhone, orderedItems, upsoldItems);

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: JSON.stringify({
        success: true,
        message: 'Post-call analysis processed successfully',
        orderedItems: orderedItems,
        upsoldItems: upsoldItems
      })
    };

  } catch (error) {
    console.error('Error handling post-call analysis:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: JSON.stringify({
        error: 'Internal server error',
        details: error.message
      })
    };
  }
};

// Function to parse item strings and filter out sauces
function parseAndFilterItems(itemString) {
  if (!itemString || itemString.trim() === '') {
    return [];
  }

  const items = [];
  
  // Split by comma and process each item
  const itemParts = itemString.split(',');
  
  for (const part of itemParts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Extract quantity and item name using regex
    // Matches patterns like "1 Zaatar fries", "2 Canned Coke", etc.
    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    
    if (match) {
      const quantity = parseInt(match[1]);
      const itemName = match[2].trim();
      
      // Filter out sauces (case insensitive)
      if (!isSauce(itemName)) {
        items.push({
          name: itemName,
          quantity: quantity
        });
      } else {
        console.log(`Filtered out sauce: ${itemName}`);
      }
    } else {
      console.warn(`Could not parse item: ${trimmed}`);
    }
  }

  return items;
}

// Function to check if an item is a sauce (free item to filter out)
function isSauce(itemName) {
  const lowerName = itemName.toLowerCase();
  
  // List of sauce keywords to filter out
  const sauceKeywords = [
    'sauce',
    'habibi sauce',
    'tahini',
    'hot sauce',
    'garlic sauce'
  ];

  return sauceKeywords.some(keyword => lowerName.includes(keyword));
}

// Function to update analytics in DynamoDB
async function updateAnalytics(restaurantPhone, orderedItems, upsoldItems) {
  try {
    // First, ensure the record exists with empty maps if it doesn't exist
    await ensureRecordExists(restaurantPhone);
    
    // Now update the counts
    await updateItemCounts(restaurantPhone, orderedItems, upsoldItems);

  } catch (error) {
    console.error('Error updating DynamoDB:', error);
    throw error;
  }
}

// Function to ensure the record exists with proper structure
async function ensureRecordExists(restaurantPhone) {
  const params = {
    TableName: TABLE_NAME,
    Key: {
      restaurant_phone: restaurantPhone
    },
    UpdateExpression: 'SET #total_orders = if_not_exists(#total_orders, :zero), #total_items_ordered = if_not_exists(#total_items_ordered, :empty_map), #total_items_upsold = if_not_exists(#total_items_upsold, :empty_map), #last_updated = :timestamp',
    ExpressionAttributeNames: {
      '#total_orders': 'total_orders',
      '#total_items_ordered': 'total_items_ordered',
      '#total_items_upsold': 'total_items_upsold',
      '#last_updated': 'last_updated'
    },
    ExpressionAttributeValues: {
      ':zero': 0,
      ':empty_map': {},
      ':timestamp': new Date().toISOString()
    }
  };

  await dynamodb.update(params).promise();
}

// Function to update item counts
async function updateItemCounts(restaurantPhone, orderedItems, upsoldItems) {
  // Build update expression
  let updateExpression = 'ADD #total_orders :inc SET #last_updated = :timestamp';
  const expressionAttributeNames = {
    '#total_orders': 'total_orders',
    '#last_updated': 'last_updated'
  };
  const expressionAttributeValues = {
    ':inc': 1,
    ':timestamp': new Date().toISOString()
  };

  // Add ordered items
  for (const item of orderedItems) {
    const sanitizedKey = sanitizeKey(item.name);
    const attrName = `#ordered_${sanitizedKey}`;
    const valueName = `:ordered_${sanitizedKey}`;
    const zeroValueName = `:zero_ordered_${sanitizedKey}`;
    
    updateExpression += `, #total_items_ordered.${attrName} = if_not_exists(#total_items_ordered.${attrName}, ${zeroValueName}) + ${valueName}`;
    expressionAttributeNames['#total_items_ordered'] = 'total_items_ordered';
    expressionAttributeNames[attrName] = sanitizedKey;
    expressionAttributeValues[valueName] = item.quantity;
    expressionAttributeValues[zeroValueName] = 0;
  }

  // Add upsold items
  for (const item of upsoldItems) {
    const sanitizedKey = sanitizeKey(item.name);
    const attrName = `#upsold_${sanitizedKey}`;
    const valueName = `:upsold_${sanitizedKey}`;
    const zeroValueName = `:zero_upsold_${sanitizedKey}`;
    
    updateExpression += `, #total_items_upsold.${attrName} = if_not_exists(#total_items_upsold.${attrName}, ${zeroValueName}) + ${valueName}`;
    expressionAttributeNames['#total_items_upsold'] = 'total_items_upsold';
    expressionAttributeNames[attrName] = sanitizedKey;
    expressionAttributeValues[valueName] = item.quantity;
    expressionAttributeValues[zeroValueName] = 0;
  }

  const params = {
    TableName: TABLE_NAME,
    Key: {
      restaurant_phone: restaurantPhone
    },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW'
  };

  console.log('DynamoDB update params:', JSON.stringify(params, null, 2));

  const result = await dynamodb.update(params).promise();
  console.log('DynamoDB update successful:', result.Attributes);
}

// Function to sanitize keys for DynamoDB (replace special characters and normalize case)
function sanitizeKey(key) {
  return key.toLowerCase().replace(/[^a-zA-Z0-9]/g, '_');
} 