const AWS = require('aws-sdk');

// Configure AWS region (Lambda uses IAM role for credentials)
AWS.config.update({ 
  region: process.env.AWS_REGION || 'us-east-1'
});
const dynamodb = new AWS.DynamoDB.DocumentClient();

const SESSION_CARTS_TABLE = process.env.SESSION_CARTS_TABLE || 'session-carts';
const PHONE_NUMBER_CLIENT_MAP_TABLE = process.env.PHONE_NUMBER_CLIENT_MAP_TABLE || 'phoneNumberClientMap';
const CLIENT_MENU_TABLE = process.env.CLIENT_MENU_TABLE || 'clientMenu';

// Session cart helper functions
function extractCallId(body) {
  return body.call?.call_id;
}

// Helper function to find and apply spice level modifiers
function findSpiceLevelModifier(menuItem, spiceLevel, isFirstItem, is2PcItem) {
  if (!spiceLevel || !menuItem.modifiers) {
    return null;
  }

  let targetCategory = null;

  if (is2PcItem) {
    // For 2PC items, look for first/second sandwich mod categories
    const categoryName = isFirstItem 
      ? "Choose Your First Sandwich Mods" 
      : "Choose Your Second Sandwich Mods";
    
    targetCategory = menuItem.modifiers.find(cat => cat.category === categoryName);
  } else {
    // For single items, look for categories containing "Spice Level"
    targetCategory = menuItem.modifiers.find(cat => 
      cat.category.toLowerCase().includes('spice level')
    );
  }

  if (!targetCategory || !targetCategory.options) {
    console.log(`No appropriate spice category found for ${isFirstItem ? 'first' : 'second'} item`);
    return null;
  }

  // Find the spice level option in the category
  const spiceOption = targetCategory.options.find(option => 
    option.name.trim().toLowerCase() === spiceLevel.toLowerCase()
  );

  if (!spiceOption) {
    console.log(`Spice level "${spiceLevel}" not found in category "${targetCategory.category}"`);
    return null;
  }

  return {
    category: targetCategory.category,
    optionId: spiceOption.id,
    optionName: spiceOption.name,
    price: spiceOption.price / 100, // Convert cents to dollars
    currency: spiceOption.currency
  };
}

// Helper function to find modifier in specific category
function findModifierInCategory(menuItem, modifierName, targetCategoryName) {
  if (!modifierName || !menuItem.modifiers) {
    return null;
  }

  // Find the target category
  const targetCategory = menuItem.modifiers.find(cat => cat.category === targetCategoryName);
  
  if (!targetCategory || !targetCategory.options) {
    console.log(`Category "${targetCategoryName}" not found or has no options`);
    return null;
  }

  // Find the modifier option in the category
  const modifierOption = targetCategory.options.find(option => 
    option.name.trim() === modifierName.trim()
  );

  if (!modifierOption) {
    console.log(`Modifier "${modifierName}" not found in category "${targetCategoryName}"`);
    return null;
  }

  return {
    category: targetCategory.category,
    optionId: modifierOption.id,
    optionName: modifierOption.name,
    price: modifierOption.price / 100, // Convert cents to dollars
    currency: modifierOption.currency
  };
}

function extractPhoneNumber(body) {
  // Extract the restaurant phone number (the number customer called)
  // For phone calls: use to_number
  // For web calls: fallback to default restaurant number for testing
  return body.call?.to_number || '+17039120079';
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

async function getLocationMenu(restaurantName, locationId) {
  if (!restaurantName || !locationId) {
    throw new Error('Restaurant name and location ID are required');
  }

  const params = {
    TableName: CLIENT_MENU_TABLE,
    Key: { 
      restaurantName: restaurantName,
      locationID: locationId 
    }
  };

  try {
    console.log(`Getting menu for: ${restaurantName} at location: ${locationId}`);
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      throw new Error(`No menu found for ${restaurantName} at location ${locationId}`);
    }

    console.log(`Found menu with ${result.Item.itemCount || 'unknown'} items`);
    return result.Item;
  } catch (error) {
    console.error('Error getting location menu:', error);
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

async function saveSessionCart(callId, cartItems) {
  if (!callId) {
    throw new Error('Call ID required for session cart');
  }
  
  const params = {
    TableName: SESSION_CARTS_TABLE,
    Item: {
      call_id: callId,
      cart_items: cartItems,
      updated_at: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + (2 * 60 * 60) // 2 hours
    }
  };
  
  try {
    await dynamodb.put(params).promise();
    console.log(`Session cart saved for call: ${callId}`);
  } catch (error) {
    console.error('Error saving session cart:', error);
    throw error;
  }
}

// Helper function to convert technical modifier names to natural speech
function convertModifierToSpeech(modifierName) {
  // Spice levels
  if (modifierName === 'Original') return 'original';
  if (modifierName === 'Mild') return 'mild';
  if (modifierName === 'Medium') return 'medium';
  if (modifierName === 'Hot') return 'hot';
  if (modifierName === 'Extra Hot') return 'extra hot';
  if (modifierName === 'FCK YOU CRA') return 'f you cray';
  
  // Add/Remove modifiers (remove piece numbers)
  if (modifierName.includes('Add cheese')) return 'with cheese';
  if (modifierName.includes('No cheese')) return 'no cheese';
  if (modifierName.includes('No Pickles')) return 'no pickles';
  if (modifierName.includes('No Slaw')) return 'no slaw';
  if (modifierName.includes('No Big Bird Sauce')) return 'no sauce';
  if (modifierName === 'Add tender') return 'with extra tender';
  
  // Side options
  if (modifierName === 'Pickles on the side') return 'pickles on the side';
  if (modifierName === 'Slaw on the side') return 'slaw on the side';
  if (modifierName === 'Chicken & Bun Only') return 'chicken and bun only';
  
  // Substitutions
  if (modifierName === 'Substitute fries with mac & cheese') return 'substitute fries with mac and cheese';
  if (modifierName === 'Substitute fries with slaw') return 'substitute fries with slaw';
  if (modifierName.includes('Substitute Slaw with Lettuce')) return 'substitute slaw with lettuce';
  
  // Default: return cleaned up version
  return modifierName.toLowerCase().replace(/\d+$/, '').trim();
}

// Helper function to group modifiers by piece and create speech descriptions
function createModifierDescription(modifiers) {
  if (!modifiers || modifiers.length === 0) {
    return '';
  }
  
  // Group modifiers by piece number
  const piece1Modifiers = [];
  const piece2Modifiers = [];
  const wholeItemModifiers = [];
  
  modifiers.forEach(modifier => {
    const speechText = convertModifierToSpeech(modifier.optionName);
    
    // Extract piece number from modifier name
    if (modifier.optionName.endsWith(' 1')) {
      piece1Modifiers.push(speechText);
    } else if (modifier.optionName.endsWith(' 2')) {
      piece2Modifiers.push(speechText);
    } else {
      wholeItemModifiers.push(speechText);
    }
  });
  
  const descriptions = [];
  
  // Add piece-specific descriptions
  if (piece1Modifiers.length > 0) {
    descriptions.push(`first sandwich ${piece1Modifiers.join(' ')}`);
  }
  
  if (piece2Modifiers.length > 0) {
    descriptions.push(`second sandwich ${piece2Modifiers.join(' ')}`);
  }
  
  // Add whole-item descriptions
  if (wholeItemModifiers.length > 0) {
    descriptions.push(...wholeItemModifiers);
  }
  
  return descriptions.length > 0 ? ` - ${descriptions.join(', ')}` : '';
}

function createSpeechFriendlySummary(sessionCart, subtotal) {
  if (!sessionCart || sessionCart.length === 0) {
    return "Your cart is empty.";
  }

  // Create speech-friendly item descriptions with modifiers
  const speechItems = sessionCart.map(item => {
    let itemName = item.item_name || item.name || 'Unknown Item';
    
    // For SODA items, use the actual drink name from specialInstructions
    if (itemName.toUpperCase() === 'SODA' && item.specialInstructions) {
      itemName = item.specialInstructions;
    }
    
    // Apply speech transformations
    itemName = itemName.replace(/(\d+)pc\b/g, '$1 piece'); // 2pc -> 2 piece
    itemName = itemName.replace(/FCK YOU CRA/g, 'F.C.K.'); // FCK YOU CRA -> F You Cray
    
    const quantity = item.quantity || 1;
    
    // Add modifier description
    const modifierDescription = createModifierDescription(item.modifiers);
    
    return `${quantity} ${itemName}${modifierDescription}`;
  });

  // Create the summary message
  const itemsText = speechItems.join(', ');
  const formattedSubtotal = (subtotal || 0).toFixed(2);
  
  return `${itemsText}. Your total is $${formattedSubtotal} plus tax`;
}

// Add item to cart
module.exports.addToCart = async (event) => {
  console.log('[addToCart] Starting function...');
  
  try {
    // Parse the request body
    let body;
    if (typeof event.body === 'string') {
      body = JSON.parse(event.body);
    } else {
      body = event.body;
    }

    // Extract call ID and item data
    const callId = extractCallId(body);
    if (!callId) {
      return createErrorResponse(400, 'Missing call ID in request');
    }

    // Extract phone number from Retell payload
    const phoneNumber = extractPhoneNumber(body);
    if (!phoneNumber) {
      return createErrorResponse(400, 'Missing phone number in request - cannot determine location');
    }

    // Extract item data from args (preserve original order payload)
    const itemName = body.args?.itemName;
    const quantity = body.args?.quantity || 1;
    const specialInstructions = body.args?.specialInstructions || '';
    const firstItemSpiceLevel = body.args?.firstItemSpiceLevel;
    const secondItemSpiceLevel = body.args?.secondItemSpiceLevel;

    console.log(`[addToCart] Call ID: ${callId}, Args:`, { 
      phoneNumber, 
      itemName, 
      quantity, 
      specialInstructions,
      firstItemSpiceLevel,
      secondItemSpiceLevel
    });

    // Validate inputs
    if (!itemName) {
      return createErrorResponse(400, 'Missing required field: itemName');
    }

    if (quantity <= 0 || !Number.isInteger(quantity)) {
      return createErrorResponse(400, 'Quantity must be a positive integer');
    }

    // Step 1: Get location from phone number
    let locationData;
    try {
      locationData = await getLocationFromPhoneNumber(phoneNumber);
    } catch (error) {
      return createErrorResponse(404, `Location lookup failed: ${error.message}`);
    }

    // Step 2: Get location-specific menu
    let locationMenu;
    try {
      locationMenu = await getLocationMenu(locationData.restaurantName, locationData.locationId);
    } catch (error) {
      return createErrorResponse(404, `Menu lookup failed: ${error.message}`);
    }

    // Step 3: Find item in location menu (direct access by item name)
    const menuItem = locationMenu[itemName];
    if (!menuItem) {
      const availableItems = Object.keys(locationMenu).filter(key => 
        !['restaurantName', 'locationID'].includes(key)
      );
      return createErrorResponse(404, 
        `Item "${itemName}" not found in ${locationData.restaurantName} ${locationData.locationId} menu`, 
        { availableItems }
      );
    }

    // Get existing session cart
    const sessionCart = await getSessionCart(callId);

    // Determine if this is a 2PC item
    const is2PcItem = itemName.includes("(2pc)");

    // Create cart item using new menu structure
    const cartItem = {
      // Square-required fields
      variation_id: menuItem.variation_id,
      item_name: itemName,
      
      // Menu data
      price: menuItem.price,
      currency: menuItem.currency,
      description: menuItem.description || '',
      
      // Square payment processor expects this format
      price_money: {
        amount: menuItem.price,
        currency: menuItem.currency
      },
      
      // Cart-specific fields
      quantity: quantity,
      specialInstructions: specialInstructions,
      unitPrice: menuItem.price / 100, // Convert cents to dollars
      lineTotal: (menuItem.price / 100) * quantity,
      modifiers: [], // Initialize empty modifiers array
      
      // For backward compatibility
      itemId: menuItem.variation_id,
      name: itemName
    };

    // Auto-apply spice level modifiers
    let totalModifierPrice = 0;

    // Apply first item spice level
    if (firstItemSpiceLevel) {
      const firstSpiceModifier = findSpiceLevelModifier(menuItem, firstItemSpiceLevel, true, is2PcItem);
      if (firstSpiceModifier) {
        cartItem.modifiers.push(firstSpiceModifier);
        totalModifierPrice += firstSpiceModifier.price;
        console.log(`Applied first item spice level: ${firstSpiceModifier.optionName}`);
      } else {
        console.warn(`Could not apply first item spice level: ${firstItemSpiceLevel}`);
      }
    }

    // Apply second item spice level (only for 2PC items)
    if (secondItemSpiceLevel) {
      if (is2PcItem) {
        const secondSpiceModifier = findSpiceLevelModifier(menuItem, secondItemSpiceLevel, false, is2PcItem);
        if (secondSpiceModifier) {
          cartItem.modifiers.push(secondSpiceModifier);
          totalModifierPrice += secondSpiceModifier.price;
          console.log(`Applied second item spice level: ${secondSpiceModifier.optionName}`);
        } else {
          console.warn(`Could not apply second item spice level: ${secondItemSpiceLevel}`);
        }
      } else {
        console.warn(`Second item spice level ignored for non-2PC item: ${itemName}`);
      }
    }

    // Recalculate line total including modifier prices
    cartItem.lineTotal = (cartItem.unitPrice + totalModifierPrice) * quantity;

    // Check if item already exists in cart (same item + instructions + modifiers)
    const existingIndex = sessionCart.findIndex(item => {
      if (item.itemId !== cartItem.itemId || item.specialInstructions !== cartItem.specialInstructions) {
        return false;
      }
      
      // Compare modifiers (same modifiers = same item configuration)
      if (item.modifiers?.length !== cartItem.modifiers?.length) {
        return false;
      }
      
      // Check if all modifiers match
      const itemModifierIds = (item.modifiers || []).map(mod => mod.optionId).sort();
      const cartModifierIds = (cartItem.modifiers || []).map(mod => mod.optionId).sort();
      
      return JSON.stringify(itemModifierIds) === JSON.stringify(cartModifierIds);
    });

    if (existingIndex >= 0) {
      // Update existing item
      sessionCart[existingIndex].quantity += quantity;
      
      // Recalculate line total including modifiers
      const existingModifierTotal = (sessionCart[existingIndex].modifiers || [])
        .reduce((sum, mod) => sum + (mod.price || 0), 0);
      sessionCart[existingIndex].lineTotal = (sessionCart[existingIndex].unitPrice + existingModifierTotal) * sessionCart[existingIndex].quantity;
    } else {
      // Add new item
      sessionCart.push(cartItem);
    }

    // Save updated cart to session
    await saveSessionCart(callId, sessionCart);

    console.log('Item added successfully to session cart');

    return createSuccessResponse({
      message: `Added ${quantity} ${itemName} to cart for ${locationData.restaurantName} ${locationData.locationId}`
    });

  } catch (error) {
    console.error('Error adding to cart:', error);
    return createErrorResponse(500, 'Internal server error', { details: error.message });
  }
};

// Remove item from cart
module.exports.removeFromCart = async (event) => {
  console.log('[removeFromCart] Starting function...');
  
  try {
    // Parse the request body
    let body;
    if (typeof event.body === 'string') {
      body = JSON.parse(event.body);
    } else {
      body = event.body;
    }

    // Extract call ID and item data
    const callId = extractCallId(body);
    if (!callId) {
      return createErrorResponse(400, 'Missing call ID in request');
    }

    const itemName = body.args?.itemName;
    const quantityToRemove = body.args?.quantityToRemove;

    console.log(`[removeFromCart] Call ID: ${callId}, Args:`, { itemName, quantityToRemove });

    // Validate inputs
    if (!itemName) {
      return createErrorResponse(400, 'Missing required field: itemName');
    }

    // Get session cart
    const sessionCart = await getSessionCart(callId);

    if (!sessionCart.length) {
      return createErrorResponse(400, 'Cart is empty');
    }

    // Find item in cart (flexible matching)
    const cartIndex = sessionCart.findIndex(item => 
      item.name.toLowerCase().includes(itemName.toLowerCase()) ||
      itemName.toLowerCase().includes(item.name.toLowerCase())
    );

    if (cartIndex === -1) {
      const cartItemNames = sessionCart.map(item => item.name);
      return createErrorResponse(404, `Item "${itemName}" not found in cart`, { currentItems: cartItemNames });
    }

    const cartItem = sessionCart[cartIndex];
    const removeQty = quantityToRemove || cartItem.quantity; // Remove all if not specified

    if (removeQty >= cartItem.quantity) {
      // Remove entire item
      sessionCart.splice(cartIndex, 1);
    } else {
      // Reduce quantity
      sessionCart[cartIndex].quantity -= removeQty;
      sessionCart[cartIndex].lineTotal = sessionCart[cartIndex].unitPrice * sessionCart[cartIndex].quantity;
    }

    // Save updated cart to session
    await saveSessionCart(callId, sessionCart);

    console.log('Item removed successfully from session cart');

    return createSuccessResponse({
      message: `Removed ${removeQty} ${cartItem.name} from cart`
    });

  } catch (error) {
    console.error('Error removing from cart:', error);
    return createErrorResponse(500, 'Internal server error', { details: error.message });
  }
};

// Get cart summary with totals
module.exports.getCartSummary = async (event) => {
  console.log('[getCartSummary] Starting function...');
  
  try {
    // Parse the request body
    let body;
    if (typeof event.body === 'string') {
      body = JSON.parse(event.body);
    } else {
      body = event.body;
    }

    // Extract call ID
    const callId = extractCallId(body);
    if (!callId) {
      return createErrorResponse(400, 'Missing call ID in request');
    }

    console.log(`[getCartSummary] Call ID: ${callId}, Args: (no additional args)`);

    // Get session cart
    const sessionCart = await getSessionCart(callId);

    if (!sessionCart.length) {
      return createSuccessResponse({
        message: 'Your cart is empty'
      });
    }

    // Calculate totals
    const subtotal = sessionCart.reduce((sum, item) => sum + item.lineTotal, 0);
    const itemCount = sessionCart.reduce((sum, item) => sum + item.quantity, 0);

    // Create speech-friendly summary
    const speechSummary = createSpeechFriendlySummary(sessionCart, subtotal);

    console.log('Cart summary generated for session cart');

    return createSuccessResponse({
      message: speechSummary
    });

  } catch (error) {
    console.error('Error getting cart summary:', error);
    return createErrorResponse(500, 'Internal server error', { details: error.message });
  }
};

// Generate upsell suggestions based on current cart
module.exports.upsell = async (event) => {
  console.log('[upsell] Starting function...');
  
  try {
    // Parse the request body
    let body;
    if (typeof event.body === 'string') {
      body = JSON.parse(event.body);
    } else {
      body = event.body;
    }

    // Extract call ID
    const callId = extractCallId(body);
    if (!callId) {
      return createErrorResponse(400, 'Missing call ID in request');
    }

    console.log(`[upsell] Call ID: ${callId}, Args: (no additional args)`);

    // Get session cart
    const sessionCart = await getSessionCart(callId);

    // Check what's already in cart
    const cartItemNames = sessionCart.map(item => (item.item_name || item.name || '').toLowerCase());
    
    // Check for items in cart
    const hasFries = cartItemNames.some(item => item.includes('fries'));
    const hasMac = cartItemNames.some(item => item.includes('mac'));
    const hasSlaw = cartItemNames.some(item => item.includes('slaw'));
    const hasToffee = cartItemNames.some(item => item.includes('toffee'));

    // Start with base sentence and remove parts
    let message = "Before I confirm, would you like to add ";
    let parts = [];
    
    // Add fries if not in cart
    if (!hasFries) {
      parts.push("regular fries, cheese fries");
    }
    
    // Add mac & cheese if not in cart
    if (!hasMac) {
      parts.push("mac & cheese");
    }
    
    // Add slaw if not in cart
    if (!hasSlaw) {
      parts.push("slaw");
    }
    
    // Add dessert part if toffee cake not in cart
    let dessertPart = "";
    if (!hasToffee) {
      dessertPart = ", we also have toffee cake for dessert";
    }
    
    // Build final message
    if (parts.length === 0) {
      message = "";
    } else if (parts.length === 1) {
      message += parts[0] + dessertPart + "?";
    } else {
      // Join with commas and add "or" before the last item
      const lastItem = parts.pop();
      message += parts.join(", ") + ", or " + lastItem + dessertPart + "?";
    }

    console.log('Upsell suggestions generated');

    return createSuccessResponse({
      message: message
    });

  } catch (error) {
    console.error('Error generating upsell suggestions:', error);
    return createErrorResponse(500, 'Internal server error', { details: error.message });
  }
};

// Add modifier to cart
module.exports.addModifierToCart = async (event) => {
  console.log('[addModifierToCart] Starting function...');
  
  try {
    // Parse the request body
    let body;
    if (typeof event.body === 'string') {
      body = JSON.parse(event.body);
    } else {
      body = event.body;
    }

    // Extract call ID
    const callId = extractCallId(body);
    if (!callId) {
      return createErrorResponse(400, 'Missing call ID in request');
    }

    // Extract phone number from Retell payload
    const phoneNumber = extractPhoneNumber(body);
    if (!phoneNumber) {
      return createErrorResponse(400, 'Missing phone number in request - cannot determine location');
    }

    // Extract modifier data from args
    const itemName = body.args?.itemName;
    const firstSandwichMods = body.args?.firstSandwichMods || [];
    const secondSandwichMods = body.args?.secondSandwichMods || [];

    console.log(`[addModifierToCart] Call ID: ${callId}, Args:`, { 
      phoneNumber, 
      itemName, 
      firstSandwichMods,
      secondSandwichMods
    });

    // Validate inputs
    if (!itemName) {
      return createErrorResponse(400, 'Missing required field: itemName');
    }

    if (firstSandwichMods.length === 0 && secondSandwichMods.length === 0) {
      return createErrorResponse(400, 'At least one modifier array (firstSandwichMods or secondSandwichMods) must contain modifiers');
    }

    // Step 1: Get location from phone number
    let locationData;
    try {
      locationData = await getLocationFromPhoneNumber(phoneNumber);
    } catch (error) {
      return createErrorResponse(404, `Location lookup failed: ${error.message}`);
    }

    // Step 2: Get location-specific menu
    let locationMenu;
    try {
      locationMenu = await getLocationMenu(locationData.restaurantName, locationData.locationId);
    } catch (error) {
      return createErrorResponse(404, `Menu lookup failed: ${error.message}`);
    }

    // Step 3: Find item in location menu (direct access by item name)
    const menuItem = locationMenu[itemName];
    if (!menuItem) {
      const availableItems = Object.keys(locationMenu).filter(key => 
        !['restaurantName', 'locationID'].includes(key)
      );
      return createErrorResponse(404, 
        `Item "${itemName}" not found in ${locationData.restaurantName} menu`, 
        { availableItems }
      );
    }

    // Step 4: Determine item type and find modifiers
    const is2PcItem = itemName.includes("(2pc)");
    const modifiersToApply = [];
    const failedModifiers = [];

    // Apply first sandwich modifiers
    if (firstSandwichMods.length > 0) {
      for (const firstMod of firstSandwichMods) {
        let firstModifierDetails = null;
        
        if (is2PcItem) {
          // For 2PC items, look in "Choose Your First Sandwich Mods"
          firstModifierDetails = findModifierInCategory(menuItem, firstMod, "Choose Your First Sandwich Mods");
        } else {
          // For single items, search through all categories (existing behavior for single items)
          for (const modifierCategory of menuItem.modifiers || []) {
            if (!modifierCategory.options) continue;
            
            const option = modifierCategory.options.find(opt => opt.name.trim() === firstMod.trim());
            if (option) {
              firstModifierDetails = {
                category: modifierCategory.category,
                optionId: option.id,
                optionName: option.name,
                price: option.price / 100, // Convert cents to dollars
                currency: option.currency || 'USD'
              };
        break;
      }
    }
        }
        
        if (firstModifierDetails) {
          modifiersToApply.push(firstModifierDetails);
          console.log(`First modifier found: ${firstModifierDetails.optionName} in ${firstModifierDetails.category}`);
        } else {
          failedModifiers.push(`${firstMod} (first piece)`);
          console.warn(`First modifier "${firstMod}" not found for "${itemName}"`);
        }
      }
    }

    // Apply second sandwich modifiers (only for 2PC items)
    if (secondSandwichMods.length > 0) {
      if (is2PcItem) {
        for (const secondMod of secondSandwichMods) {
          const secondModifierDetails = findModifierInCategory(menuItem, secondMod, "Choose Your Second Sandwich Mods");
          
          if (secondModifierDetails) {
            modifiersToApply.push(secondModifierDetails);
            console.log(`Second modifier found: ${secondModifierDetails.optionName} in ${secondModifierDetails.category}`);
          } else {
            failedModifiers.push(`${secondMod} (second piece)`);
            console.warn(`Second modifier "${secondMod}" not found for "${itemName}"`);
          }
        }
      } else {
        console.warn(`Second modifiers ignored for non-2PC item: ${itemName}`);
        failedModifiers.push(...secondSandwichMods.map(mod => `${mod} (second piece - not applicable)`));
      }
    }

    if (modifiersToApply.length === 0) {
      return createErrorResponse(404, `No valid modifiers found for "${itemName}"`, { 
        failedModifiers,
        availableCategories: (menuItem.modifiers || []).map(cat => cat.category)
      });
    }

    // Step 6: Get session cart and find most recent matching item
    const sessionCart = await getSessionCart(callId);
    
    // Find the most recent cart item with matching name (reverse search)
    let targetCartItemIndex = -1;
    for (let i = sessionCart.length - 1; i >= 0; i--) {
      if (sessionCart[i].item_name === itemName || sessionCart[i].name === itemName) {
        targetCartItemIndex = i;
        break;
      }
    }

    if (targetCartItemIndex === -1) {
      return createErrorResponse(404, `No "${itemName}" found in cart to modify. Add the item first.`);
    }

    // Step 7: Add modifiers to cart item
    const cartItem = sessionCart[targetCartItemIndex];
    
    // Initialize modifiers array if it doesn't exist
    if (!cartItem.modifiers) {
      cartItem.modifiers = [];
    }

    const addedModifiers = [];
    const skippedModifiers = [];

    // Apply each modifier
    for (const modifierDetails of modifiersToApply) {
    // Check if this modifier already exists (prevent duplicates)
    const existingModifier = cartItem.modifiers.find(mod => 
      mod.optionId === modifierDetails.optionId
    );
    
    if (existingModifier) {
        skippedModifiers.push(modifierDetails.optionName);
        console.warn(`Modifier "${modifierDetails.optionName}" already applied to this item`);
        continue;
    }

    // Add the new modifier
    const newModifier = {
        category: modifierDetails.category,
      optionId: modifierDetails.optionId,
      optionName: modifierDetails.optionName,
        price: modifierDetails.price, // Already converted to dollars
      currency: modifierDetails.currency
    };

    cartItem.modifiers.push(newModifier);
      addedModifiers.push(newModifier);
      console.log(`Added modifier: ${newModifier.optionName} to ${itemName}`);
    }

    if (addedModifiers.length === 0) {
      return createErrorResponse(400, `All modifiers already applied to this item: ${skippedModifiers.join(', ')}`);
    }

    // Step 8: Recalculate total price
    const modifierTotal = cartItem.modifiers.reduce((sum, mod) => sum + (mod.price || 0), 0);
    cartItem.lineTotal = (cartItem.unitPrice + modifierTotal) * cartItem.quantity;

    // Step 9: Save updated cart
    await saveSessionCart(callId, sessionCart);

    console.log('Modifiers added successfully to cart item');

    // Create response message
    const addedNames = addedModifiers.map(mod => mod.optionName);
    const totalRequested = firstSandwichMods.length + secondSandwichMods.length;
    
    let message;
    if (addedNames.length === 1) {
      message = `Added "${addedNames[0]}" to ${itemName}`;
    } else if (addedNames.length === totalRequested) {
      message = `Added ${addedNames.length} modifiers to ${itemName}: ${addedNames.join(', ')}`;
    } else {
      message = `Added ${addedNames.length} of ${totalRequested} modifiers to ${itemName}: ${addedNames.join(', ')}`;
    }

    return createSuccessResponse({
      message: message,
      modifiersAdded: addedModifiers.map(mod => ({
        name: mod.optionName,
        price: mod.price,
        category: mod.category
      })),
      skippedModifiers: skippedModifiers,
      failedModifiers: failedModifiers,
      newItemTotal: cartItem.lineTotal
    });

  } catch (error) {
    console.error('Error adding modifier to cart:', error);
    return createErrorResponse(500, 'Internal server error', { details: error.message });
  }
};

// Remove modifier from cart
module.exports.removeModifierFromCart = async (event) => {
  console.log('[removeModifierFromCart] Starting function...');
  
  try {
    // Parse the request body
    let body;
    if (typeof event.body === 'string') {
      body = JSON.parse(event.body);
    } else {
      body = event.body;
    }

    // Extract call ID
    const callId = extractCallId(body);
    if (!callId) {
      return createErrorResponse(400, 'Missing call ID in request');
    }

    // Extract modifier data from args
    const itemName = body.args?.itemName;
    const firstSandwichMods = body.args?.firstSandwichMods || [];
    const secondSandwichMods = body.args?.secondSandwichMods || [];

    console.log(`[removeModifierFromCart] Call ID: ${callId}, Args:`, { 
      itemName, 
      firstSandwichMods,
      secondSandwichMods
    });

    // Validate inputs
    if (!itemName) {
      return createErrorResponse(400, 'Missing required field: itemName');
    }

    if (firstSandwichMods.length === 0 && secondSandwichMods.length === 0) {
      return createErrorResponse(400, 'At least one modifier array (firstSandwichMods or secondSandwichMods) must contain modifiers to remove');
    }

    // Get session cart
    const sessionCart = await getSessionCart(callId);

    if (!sessionCart.length) {
      return createErrorResponse(400, 'Cart is empty');
    }

    // Find the most recent cart item with matching name (same logic as addModifierToCart)
    let targetCartItemIndex = -1;
    for (let i = sessionCart.length - 1; i >= 0; i--) {
      if (sessionCart[i].item_name === itemName || sessionCart[i].name === itemName) {
        targetCartItemIndex = i;
        break;
      }
    }

    if (targetCartItemIndex === -1) {
      return createErrorResponse(404, `No "${itemName}" found in cart to modify`);
    }

    const cartItem = sessionCart[targetCartItemIndex];
    
    // Check if item has modifiers
    if (!cartItem.modifiers || cartItem.modifiers.length === 0) {
      return createErrorResponse(404, `No modifiers found on "${itemName}"`);
    }

    // Determine item type for piece-specific targeting
    const is2PcItem = itemName.includes("(2pc)");
    const removedModifiers = [];
    const failedModifiers = [];

    // Process first sandwich modifiers
    if (firstSandwichMods.length > 0) {
      for (const modToRemove of firstSandwichMods) {
        let modifierIndex = -1;
        
        if (is2PcItem) {
          // For 2PC items, only remove from "Choose Your First Sandwich Mods" category
          modifierIndex = cartItem.modifiers.findIndex(mod => 
            mod.optionName.trim() === modToRemove.trim() && 
            mod.category === "Choose Your First Sandwich Mods"
          );
        } else {
          // For single items, find any matching modifier
          modifierIndex = cartItem.modifiers.findIndex(mod => 
            mod.optionName.trim() === modToRemove.trim()
          );
        }

        if (modifierIndex !== -1) {
          const removedModifier = cartItem.modifiers.splice(modifierIndex, 1)[0];
          removedModifiers.push(removedModifier);
          console.log(`Removed first modifier: ${removedModifier.optionName} from ${removedModifier.category}`);
        } else {
          failedModifiers.push(`${modToRemove} (first piece)`);
          console.warn(`First modifier "${modToRemove}" not found on "${itemName}"`);
        }
      }
    }

    // Process second sandwich modifiers (only for 2PC items)
    if (secondSandwichMods.length > 0) {
      if (is2PcItem) {
        for (const modToRemove of secondSandwichMods) {
          // For 2PC items, only remove from "Choose Your Second Sandwich Mods" category
          const modifierIndex = cartItem.modifiers.findIndex(mod => 
            mod.optionName.trim() === modToRemove.trim() && 
            mod.category === "Choose Your Second Sandwich Mods"
          );

          if (modifierIndex !== -1) {
            const removedModifier = cartItem.modifiers.splice(modifierIndex, 1)[0];
            removedModifiers.push(removedModifier);
            console.log(`Removed second modifier: ${removedModifier.optionName} from ${removedModifier.category}`);
          } else {
            failedModifiers.push(`${modToRemove} (second piece)`);
            console.warn(`Second modifier "${modToRemove}" not found on "${itemName}"`);
          }
        }
      } else {
        console.warn(`Second modifiers ignored for non-2PC item: ${itemName}`);
        failedModifiers.push(...secondSandwichMods.map(mod => `${mod} (second piece - not applicable)`));
      }
    }

    if (removedModifiers.length === 0) {
      const availableModifiers = cartItem.modifiers.map(mod => `${mod.optionName} (${mod.category})`);
      return createErrorResponse(404, 
        `No specified modifiers found on "${itemName}"`, 
        { 
          failedModifiers,
          availableModifiers
        }
      );
    }

    // Recalculate total price
    const modifierTotal = cartItem.modifiers.reduce((sum, mod) => sum + (mod.price || 0), 0);
    cartItem.lineTotal = (cartItem.unitPrice + modifierTotal) * cartItem.quantity;

    // Save updated cart
    await saveSessionCart(callId, sessionCart);

    console.log('Modifiers removed successfully from cart item');

    // Create response message
    const removedNames = removedModifiers.map(mod => mod.optionName);
    const totalRequested = firstSandwichMods.length + secondSandwichMods.length;
    
    let message;
    if (removedNames.length === 1) {
      message = `Removed "${removedNames[0]}" from ${itemName}`;
    } else if (removedNames.length === totalRequested) {
      message = `Removed ${removedNames.length} modifiers from ${itemName}: ${removedNames.join(', ')}`;
    } else {
      message = `Removed ${removedNames.length} of ${totalRequested} modifiers from ${itemName}: ${removedNames.join(', ')}`;
    }

    return createSuccessResponse({
      message: message,
      modifiersRemoved: removedModifiers.map(mod => ({
        name: mod.optionName,
        price: mod.price,
        category: mod.category
      })),
      failedModifiers: failedModifiers,
      newItemTotal: cartItem.lineTotal
    });

  } catch (error) {
    console.error('Error removing modifier from cart:', error);
    return createErrorResponse(500, 'Internal server error', { details: error.message });
  }
};


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