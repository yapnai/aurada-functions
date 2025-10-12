// Sync production Square catalog to clientMenu DynamoDB table
require('dotenv').config();
const AWS = require('aws-sdk');
const { SquareClient, SquareEnvironment } = require('square');

// Configure AWS
AWS.config.update({ region: 'us-east-1' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

// Table names - HARDCODED FOR DEV
const CLIENT_MENU_TABLE = 'clientMenu-dev';
const MERCHANTS_TABLE = 'square-merchants';

// Table is managed by CloudFormation, no need to create it here

// Function to convert BigInt values to Numbers recursively
function convertBigIntToNumber(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj === 'bigint') {
    return Number(obj);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(convertBigIntToNumber);
  }
  
  if (typeof obj === 'object') {
    const converted = {};
    for (const [key, value] of Object.entries(obj)) {
      converted[key] = convertBigIntToNumber(value);
    }
    return converted;
  }
  
  return obj;
}

async function syncProductionCatalog(restaurantId = 'redbird-prod') {
  try {
    console.log('🚀 Starting production catalog sync...');
    
    // 1. Using existing table created by CloudFormation
    console.log(`📋 Using table: ${CLIENT_MENU_TABLE}`);
    
    // 2. Get credentials from square-merchants table
    console.log(`📊 Retrieving credentials for restaurant: ${restaurantId}`);
    
    const params = {
      TableName: MERCHANTS_TABLE,
      Key: {
        PK: restaurantId
      }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      throw new Error(`Restaurant credentials not found in square-merchants table. PK: ${restaurantId}`);
    }
    
    const merchantData = result.Item;
    const ACCESS_TOKEN = merchantData.access_token;
    const restaurantName = merchantData.business_name;
    
    console.log(`🏪 Found restaurant: ${restaurantName}`);
    console.log(`🔑 Token length: ${ACCESS_TOKEN?.length || 'undefined'}`);
    console.log(`🔑 Token starts with: ${ACCESS_TOKEN?.substring(0, 10) || 'undefined'}...`);
    console.log(`📍 Locations in merchant data: ${merchantData.locations?.length || 0}`);
    
    // 3. Initialize Square client for production
    console.log('🔌 Connecting to Square Production API...');
    const squareClient = new SquareClient({
      token: ACCESS_TOKEN,
      environment: SquareEnvironment.Production
    });
    
    console.log('🌍 Environment check:', SquareEnvironment.Production);
    
    // 4. Get all merchant locations
    console.log('📍 Fetching merchant locations...');
    const locationsResponse = await squareClient.locations.list();
    const allLocations = locationsResponse.locations || [];
    console.log(`📍 Found ${allLocations.length} total locations`);
    
    // Filter to only merchant's locations (if specified in merchant data)
    let targetLocations = [];
    if (merchantData.locations && merchantData.locations.length > 0) {
      const merchantLocationIds = merchantData.locations.map(loc => loc.id);
      targetLocations = allLocations.filter(loc => merchantLocationIds.includes(loc.id));
      console.log(`📍 Using ${targetLocations.length} merchant-specific locations`);
    } else {
      // Fallback to all locations if no specific locations in merchant data
      targetLocations = allLocations;
      console.log(`📍 Using all ${targetLocations.length} available locations`);
    }
    
    if (targetLocations.length === 0) {
      throw new Error('No locations found for this merchant!');
    }
    
    targetLocations.forEach(loc => {
      console.log(`📍 Will sync location: ${loc.name} (${loc.id})`);
    });
    
    // 5. First, fetch ALL modifier lists separately to ensure we get them all
    console.log('🎛️ Fetching ALL modifier lists from Square...');
    const modifierListsResponse = await squareClient.catalog.search({
      objectTypes: ['MODIFIER_LIST'],
      includeRelatedObjects: true,
      limit: 1000
    });
    
    console.log('🎛️ Raw modifier lists response structure:', Object.keys(modifierListsResponse));
    
    // 6. Get all modifier lists and individual modifiers
    const allModifierListObjects = modifierListsResponse.objects || [];
    const allModifierObjects = modifierListsResponse.relatedObjects || [];
    
    console.log(`🎛️ Found ${allModifierListObjects.length} modifier lists`);
    console.log(`🎛️ Found ${allModifierObjects.length} individual modifier objects`);
    
    // 7. Create lookup maps for ALL modifier lists and modifiers
    const modifierLists = {};
    const modifiers = {};
    
    // Add modifier lists
    allModifierListObjects.forEach(obj => {
      if (obj.type === 'MODIFIER_LIST') {
        modifierLists[obj.id] = obj;
      }
    });
    
    // Add individual modifiers  
    allModifierObjects.forEach(obj => {
      if (obj.type === 'MODIFIER') {
        modifiers[obj.id] = obj;
      }
    });
    
    console.log(`🎛️ Loaded ${Object.keys(modifierLists).length} modifier lists into lookup`);
    console.log(`🎛️ Loaded ${Object.keys(modifiers).length} individual modifiers into lookup`);
    
    // 8. Now fetch catalog items
    console.log('📋 Fetching catalog items from Square...');
    const catalogResponse = await squareClient.catalog.search({
      objectTypes: ['ITEM'],
      includeRelatedObjects: false, // We already have all modifiers
      limit: 1000
    });
    
    console.log('📋 Raw catalog response structure:', Object.keys(catalogResponse));
    console.log('📋 catalogResponse.objects:', catalogResponse.objects?.length || 'undefined');
    
    // 9. Get items from response
    const items = catalogResponse.objects || [];
    
    console.log(`📋 Found ${items.length} menu items`);
    
    // 10. Process items for all target locations
    const locationMenus = {};
    let itemsProcessed = 0;
    
    // Initialize menu objects for each location
    targetLocations.forEach(location => {
      locationMenus[location.id] = {
        locationData: location,
        menu: {}
      };
    });
    
    for (const item of items) {
      const itemData = item.itemData;
      if (!itemData || !itemData.name) {
        console.log('⚠️ Item missing itemData or name, skipping');
        continue;
      }
      
      // Debug the first few items to see structure
      if (itemsProcessed < 3) {
        console.log(`🔍 DEBUGGING ITEM ${itemsProcessed + 1} (${itemData.name}):`);
        console.log('🔍 item keys:', Object.keys(item));
        console.log('🔍 itemData keys:', Object.keys(itemData));
        console.log('🔍 item.presentAtAllLocations:', item.presentAtAllLocations);
        console.log('🔍 item.presentAtLocationIds:', item.presentAtLocationIds);
        console.log('🔍 itemData.presentAtAllLocations:', itemData.presentAtAllLocations);
        console.log('🔍 itemData.presentAtLocationIds:', itemData.presentAtLocationIds);
      }
      
      // Check which locations this item is available at
      const availableAtLocations = [];
      
      if (item.presentAtAllLocations === true) {
        // Available at all locations
        availableAtLocations.push(...targetLocations);
        console.log(`📍 Item "${itemData.name}" present at ALL locations`);
      } else if (item.presentAtLocationIds && Array.isArray(item.presentAtLocationIds)) {
        // Available at specific locations
        const itemLocationIds = item.presentAtLocationIds;
        const matchingLocations = targetLocations.filter(loc => itemLocationIds.includes(loc.id));
        availableAtLocations.push(...matchingLocations);
        if (matchingLocations.length > 0) {
          console.log(`📍 Item "${itemData.name}" present at: ${matchingLocations.map(l => l.name).join(', ')}`);
        }
      } else {
        // No location restrictions specified - assume available everywhere
        if (!item.presentAtAllLocations && (!item.presentAtLocationIds || item.presentAtLocationIds.length === 0)) {
          availableAtLocations.push(...targetLocations);
          console.log(`📍 Item "${itemData.name}" has no location restrictions (assuming available everywhere)`);
        }
      }
      
      if (availableAtLocations.length === 0) {
        console.log(`⚠️ Item "${itemData.name}" not available at any target locations, skipping`);
        itemsProcessed++;
        continue;
      }
      
      // Process modifiers for this item
      const itemModifiers = {};
      if (itemData.modifierListInfo && itemData.modifierListInfo.length > 0) {
        console.log(`🎛️ Item "${itemData.name}" has ${itemData.modifierListInfo.length} modifier lists:`);
        
        itemData.modifierListInfo.forEach(modListInfo => {
          const modifierList = modifierLists[modListInfo.modifierListId];
          if (modifierList) {
            const listData = modifierList.modifierListData;
            console.log(`  ✅ "${listData.name}" (${modifierList.id})`);
            
            itemModifiers[modifierList.id] = {
              name: listData.name,
              selectionType: listData.selectionType || 'SINGLE',
              allowQuantities: listData.allowQuantities || false,
              minSelected: modListInfo.minSelectedModifiers || 0,
              maxSelected: modListInfo.maxSelectedModifiers || 1,
              options: []
            };
            
            // Add individual modifier options
            if (listData.modifiers) {
              listData.modifiers.forEach(modifier => {
                const modData = modifier.modifierData;
                itemModifiers[modifierList.id].options.push({
                  id: modifier.id,
                  name: modData.name,
                  price: modData.priceMoney?.amount || 0,
                  currency: modData.priceMoney?.currency || 'USD',
                  onByDefault: modData.onByDefault || false,
                  ordinal: modData.ordinal || 0
                });
              });
              
              // Sort options by ordinal
              itemModifiers[modifierList.id].options.sort((a, b) => a.ordinal - b.ordinal);
            }
          } else {
            console.log(`  ❌ Modifier list ${modListInfo.modifierListId} not found in lookup!`);
          }
        });
      } else {
        console.log(`🎛️ Item "${itemData.name}" has no modifier lists`);
      }
      
      // Convert BigInt values to Numbers
      const processedItem = convertBigIntToNumber({
        name: itemData.name,
        description: itemData.description || '',
        price: itemData.variations?.[0]?.itemVariationData?.priceMoney?.amount || 0,
        currency: itemData.variations?.[0]?.itemVariationData?.priceMoney?.currency || 'USD',
        categoryId: itemData.categoryId || '',
        isTaxable: itemData.isTaxable || false,
        productType: itemData.productType || '',
        isArchived: itemData.isArchived || false,
        modifiers: itemModifiers,
        skipModifierScreen: itemData.skipModifierScreen || false,
        variations: itemData.variations || []
      });
      
      const modifierCount = Object.keys(itemModifiers).length;
      const totalOptions = Object.values(itemModifiers).reduce((sum, mod) => sum + mod.options.length, 0);
      
      // Add this item to all locations where it's available
      availableAtLocations.forEach(location => {
        locationMenus[location.id].menu[processedItem.name] = processedItem;
      });
      
      console.log(`🍽️ Added "${processedItem.name}" (Price: $${(processedItem.price/100).toFixed(2)}) to ${availableAtLocations.length} location(s) - ${modifierCount} modifier lists, ${totalOptions} total options`);
      itemsProcessed++;
    }
    
    // 9. Store all location menus in DynamoDB
    let totalLocationsStored = 0;
    let totalItemsStored = 0;
    
    for (const [locationId, locationData] of Object.entries(locationMenus)) {
      const location = locationData.locationData;
      const menu = locationData.menu;
      const itemCount = Object.keys(menu).length;
      
      console.log(`📊 ${location.name} menu has ${itemCount} items`);
      
      if (itemCount > 0) {
        console.log(`💾 Storing ${location.name} menu with ${itemCount} items`);
        
        const dbItem = {
          restaurantName: restaurantName,
          locationID: location.id,
          locationName: location.name,
          lastUpdated: new Date().toISOString(),
          itemCount: itemCount,
          ...menu // Spread all menu items as individual attributes
        };
        
        const params = {
          TableName: CLIENT_MENU_TABLE,
          Item: dbItem
        };
        
        try {
          await dynamodb.put(params).promise();
          console.log(`✅ Successfully stored ${location.name} menu!`);
          totalLocationsStored++;
          totalItemsStored += itemCount;
        } catch (error) {
          console.error(`❌ Error storing ${location.name} menu:`, error);
        }
      } else {
        console.log(`⚠️ No items found for ${location.name} location`);
      }
    }
    
    console.log(`🎉 ${restaurantName} catalog sync completed successfully!`);
    console.log(`📊 Final Summary: ${totalLocationsStored} locations synced with ${totalItemsStored} total menu items`);
    
  } catch (error) {
    console.error('❌ Error syncing catalog:', error);
    throw error;
  }
}

// Run the sync (you can pass a different restaurantId if needed)
syncProductionCatalog('The Red Bird Hot Chicken & Fries'); 