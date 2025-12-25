const AWS = require('aws-sdk');

// Configure AWS region (Lambda uses IAM role for credentials)
AWS.config.update({ 
  region: process.env.AWS_REGION || 'us-east-1'
});
const dynamodb = new AWS.DynamoDB.DocumentClient();

const PHONE_NUMBER_CLIENT_MAP_TABLE = process.env.PHONE_NUMBER_CLIENT_MAP_TABLE || 'phoneNumberClientMap';
const CLIENT_DATABASE_TABLE = process.env.CLIENT_DATABASE_TABLE || 'clientDatabase';
const CLIENT_MENU_TABLE = process.env.CLIENT_MENU_TABLE || 'clientMenu';

// Helper function to parse hours string (e.g., "11:00-22:00")
function parseHours(hoursString) {
  if (!hoursString) return null;
  
  const [openStr, closeStr] = hoursString.split('-');
  if (!openStr || !closeStr) return null;
  
  const [openHour, openMin] = openStr.split(':').map(Number);
  const [closeHour, closeMin] = closeStr.split(':').map(Number);
  
  const openTime = openHour * 60 + openMin;
  let closeTime = closeHour * 60 + closeMin;
  
  // Handle midnight: "00:00" should be treated as end of day (1440 minutes)
  if (closeTime === 0) {
    closeTime = 1440;
  }
  
  return { openTime, closeTime };
}

// Helper function to format time for speech (e.g., "11:00" -> "11:00 AM")
function formatTimeForSpeech(timeString) {
  if (!timeString) return '';
  
  const [hour, minute] = timeString.split(':').map(Number);
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  
  return `${displayHour}:${minute.toString().padStart(2, '0')} ${period}`;
}

// Helper function to format hours range for speech
function formatHoursForSpeech(hoursString) {
  if (!hoursString) return 'hours not available';
  
  const [openStr, closeStr] = hoursString.split('-');
  const openFormatted = formatTimeForSpeech(openStr);
  const closeFormatted = formatTimeForSpeech(closeStr);
  
  return `${openFormatted} to ${closeFormatted}`;
}

// Helper function to format all weekly hours for speech
function formatWeeklyHoursForSpeech(restaurantHours) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  const formattedHours = [];
  
  dayNames.forEach((dayName) => {
    const dayHours = restaurantHours[dayName];
    if (dayHours && dayHours.toUpperCase() !== 'CLOSED') {
      const formattedRange = formatHoursForSpeech(dayHours);
      formattedHours.push(`${dayName}: ${formattedRange}`);
    } else {
      formattedHours.push(`${dayName}: closed`);
    }
  });
  
  return formattedHours.join('\n');
}

// Helper function to get today's date in MM/DD format
function getTodayDateString(timeZone) {
  const now = new Date();
  const localTime = new Date(now.toLocaleString("en-US", {timeZone: timeZone}));
  const month = (localTime.getMonth() + 1).toString(); // No padding
  const day = localTime.getDate().toString(); // No padding
  return `${month}/${day}`;
}

// Helper function to find if today is a holiday
function findTodayHoliday(holidayHours, timeZone) {
  if (!holidayHours || !Array.isArray(holidayHours) || holidayHours.length === 0) {
    return null;
  }
  
  const todayDate = getTodayDateString(timeZone);
  const holiday = holidayHours.find(h => h.date === todayDate);
  
  return holiday || null;
}

// Helper function to format all holiday hours for speech
function formatHolidayHoursForSpeech(holidayHours) {
  if (!holidayHours || !Array.isArray(holidayHours) || holidayHours.length === 0) {
    return 'No special holiday hours';
  }
  
  const formattedHolidays = holidayHours.map(holiday => {
    const hoursText = holiday.hours.toUpperCase() === 'CLOSED' 
      ? 'CLOSED' 
      : formatHoursForSpeech(holiday.hours);
    
    return `${holiday.name} on ${holiday.date}: ${hoursText}`;
  });
  
  return formattedHolidays.join(', ');
}

// Helper function to get upcoming holidays within the next N days
function getUpcomingHolidays(holidayHours, timeZone, daysAhead = 14) {
  if (!holidayHours || !Array.isArray(holidayHours) || holidayHours.length === 0) {
    return [];
  }
  
  const now = new Date();
  const localTime = new Date(now.toLocaleString("en-US", {timeZone: timeZone}));
  
  const upcomingHolidays = [];
  
  // Check each day in the next daysAhead days
  for (let i = 0; i <= daysAhead; i++) {
    const checkDate = new Date(localTime);
    checkDate.setDate(localTime.getDate() + i);
    
    const month = (checkDate.getMonth() + 1).toString();
    const day = checkDate.getDate().toString();
    const dateString = `${month}/${day}`;
    
    // Find if this date is a holiday
    const holiday = holidayHours.find(h => h.date === dateString);
    
    if (holiday) {
      // Determine relative label with day name and date
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const dayName = dayNames[checkDate.getDay()];
      
      let relativeLabel;
      if (i === 0) {
        relativeLabel = `Today (${dayName} ${dateString})`;
      } else if (i === 1) {
        relativeLabel = `Tomorrow (${dayName} ${dateString})`;
      } else {
        relativeLabel = `${dayName} (${dateString})`;
      }
      
      // Format hours text
      const hoursText = holiday.hours.toUpperCase() === 'CLOSED' 
        ? 'CLOSED' 
        : `Special hours ${formatHoursForSpeech(holiday.hours)}`;
      
      upcomingHolidays.push({
        date: holiday.date,
        name: holiday.name,
        relativeLabel: relativeLabel,
        hoursText: hoursText,
        daysFromNow: i
      });
    }
  }
  
  return upcomingHolidays;
}

// Helper function to format upcoming holidays for inclusion in store_hours
function formatUpcomingHolidaysForStoreHours(holidayHours, timeZone) {
  const upcomingHolidays = getUpcomingHolidays(holidayHours, timeZone, 14);
  
  if (upcomingHolidays.length === 0) {
    return '';
  }
  
  const formattedLines = upcomingHolidays.map(holiday => {
    return `${holiday.relativeLabel}: ${holiday.hoursText} for ${holiday.name}`;
  });
  
  return 'UPCOMING CLOSURES AND SPECIAL HOURS:\n' + formattedLines.join('\n') + '\n\n';
}

// Helper function to calculate store status based on dynamic hours
function calculateDynamicStoreStatus(restaurantHours, holidayHours, timeZone) {
  try {
    // Get current time in restaurant's timezone
    const now = new Date();
    const localTime = new Date(now.toLocaleString("en-US", {timeZone: timeZone}));
    
    // PRIORITY 1: Check if today is a holiday
    const todayHoliday = findTodayHoliday(holidayHours, timeZone);
    
    if (todayHoliday) {
      console.log(`Today is a holiday: ${todayHoliday.name} with hours: ${todayHoliday.hours}`);
      
      // Format weekly hours
      const weeklyHoursFormatted = formatWeeklyHoursForSpeech(restaurantHours || {});
      
      // Prepend upcoming holidays to store hours
      const upcomingHolidaysSection = formatUpcomingHolidaysForStoreHours(holidayHours, timeZone);
      const fullStoreHours = upcomingHolidaysSection + weeklyHoursFormatted;
      
      if (todayHoliday.hours.toUpperCase() === 'CLOSED') {
        return {
          status: "store is closed. You cannot order at this time. Please call back when we are open to place an order.",
          allHours: fullStoreHours
        };
      }
      
      // Parse holiday hours
      const parsedHours = parseHours(todayHoliday.hours);
      if (!parsedHours) {
        return {
          status: "store hours not available.",
          allHours: fullStoreHours
        };
      }
      
      // Check if currently open using holiday hours
      const currentTimeInMinutes = localTime.getHours() * 60 + localTime.getMinutes();
      console.log(`Holiday: ${todayHoliday.name}, Hours: ${todayHoliday.hours}, Current: ${currentTimeInMinutes}`);
      const isOpen = currentTimeInMinutes >= parsedHours.openTime && currentTimeInMinutes < parsedHours.closeTime;
      
      const status = isOpen 
        ? "store is open." 
        : "store is closed. You cannot order at this time. Please call back when we are open to place an order.";
      
      return {
        status: status,
        allHours: fullStoreHours
      };
    }
    
    // PRIORITY 2: If not a holiday, continue with existing day-of-week logic
    const dayOfWeek = localTime.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayName = dayNames[dayOfWeek];
    
    // Get today's hours
    const todayHours = restaurantHours?.[todayName];
    if (!todayHours || todayHours.toUpperCase() === 'CLOSED') {
      return {
        status: "store is closed. You cannot order at this time. Please call back when we are open to place an order.",
        allHours: formatWeeklyHoursForSpeech(restaurantHours || {})
      };
    }
    
    // Parse hours
    const parsedHours = parseHours(todayHours);
    if (!parsedHours) {
      return {
        status: "store hours not available.",
        allHours: formatWeeklyHoursForSpeech(restaurantHours || {})
      };
    }
    
    // Check if currently open
    const currentTimeInMinutes = localTime.getHours() * 60 + localTime.getMinutes();
    console.log(`Day: ${todayName}, Hours string: ${todayHours}, Parsed: open=${parsedHours.openTime}, close=${parsedHours.closeTime}, Current: ${currentTimeInMinutes}`);
    const isOpen = currentTimeInMinutes >= parsedHours.openTime && currentTimeInMinutes < parsedHours.closeTime;
    
    const status = isOpen ? 
      "store is open." : 
      "store is closed. You cannot order at this time. Please call back when we are open to place an order.";
    
    // Format weekly hours
    const allHoursFormatted = formatWeeklyHoursForSpeech(restaurantHours || {});
    
    // Prepend upcoming holidays to store hours
    const upcomingHolidaysSection = formatUpcomingHolidaysForStoreHours(holidayHours, timeZone);
    const fullStoreHours = upcomingHolidaysSection + allHoursFormatted;
    
    return {
      status: status,
      allHours: fullStoreHours
    };
  } catch (error) {
    console.warn('Error calculating store status:', error.message);
    return {
      status: "store status unavailable.",
      allHours: "hours not available"
    };
  }
}

module.exports.handleInboundCall = async (event) => {
  console.log('Handling inbound call webhook...');
  
  try {
    // Parse the request body
    let body;
    if (typeof event.body === 'string') {
      body = JSON.parse(event.body);
    } else {
      body = event.body;
    }

    console.log('Inbound call payload:', JSON.stringify(body, null, 2));

    // Validate that this is a call_inbound event
    if (body.event !== 'call_inbound') {
      console.error('Invalid event type:', body.event);
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        body: JSON.stringify({
          error: 'Invalid event type. Expected call_inbound',
          received: body.event
        })
      };
    }

    // Extract the from_number (customer) and to_number (restaurant) from the call_inbound object
    const fromNumber = body.call_inbound?.from_number;
    const toNumber = body.call_inbound?.to_number;
    
    if (!fromNumber) {
      console.error('Missing from_number in call_inbound payload');
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        body: JSON.stringify({
          error: 'Missing from_number in call_inbound payload',
          received: body.call_inbound
        })
      };
    }

    if (!toNumber) {
      console.error('Missing to_number in call_inbound payload');
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        body: JSON.stringify({
          error: 'Missing to_number in call_inbound payload - cannot determine location',
          received: body.call_inbound
        })
      };
    }

    console.log('Extracted from_number (customer):', fromNumber);
    console.log('Extracted to_number (restaurant):', toNumber);

    // Step 1: Get location ID from phone number
    let locationData;
    try {
      locationData = await getLocationFromPhoneNumber(toNumber);
      console.log(`Found location ID: ${locationData.locationId}`);
    } catch (error) {
      console.warn('Location lookup failed:', error.message);
      locationData = { locationId: '' };
    }

    // Step 2: Get restaurant details from clientDatabase
    let restaurantData;
    try {
      restaurantData = await getRestaurantDetails(locationData.locationId);
      console.log(`Found restaurant: ${restaurantData.restaurantName} at ${restaurantData.address}`);
    } catch (error) {
      console.warn('Restaurant details lookup failed:', error.message);
      restaurantData = { restaurantName: 'Restaurant', address: 'Address not available', hours: {} };
    }

    // Step 3: Calculate dynamic store status using database hours
    const timeZone = restaurantData?.timeZone || "America/New_York";
    let storeInfo;
    try {
      storeInfo = calculateDynamicStoreStatus(restaurantData.hours, restaurantData.holidayHours, timeZone);
      console.log('Store status calculated:', storeInfo.status);
    } catch (error) {
      console.warn('Store status calculation failed:', error.message);
      storeInfo = { status: 'Store status unavailable', allHours: 'Hours not available' };
    }

    // Step 4: Get location-specific menu items
    let menuItemNames = [];
    try {
      menuItemNames = await getLocationSpecificMenuItems(restaurantData.restaurantName, locationData.locationId);
    } catch (error) {
      console.warn('Menu lookup failed, continuing without menu:', error.message);
      menuItemNames = [];
    }

    // Step 5: Format holiday hours for the dynamic variable
    let holidayHoursFormatted = 'No special holiday hours';
    try {
      holidayHoursFormatted = formatHolidayHoursForSpeech(restaurantData.holidayHours);
    } catch (error) {
      console.warn('Holiday hours formatting failed:', error.message);
    }

    // Return the response with enhanced dynamic variables
    const response = {
      call_inbound: {
        dynamic_variables: {
          caller_number: fromNumber,
          restaurant_name: restaurantData?.restaurantName || 'Restaurant',
          restaurant_address: restaurantData?.address || 'Address not available',
          location_id: locationData?.locationId || '',
          transfer_number: restaurantData?.transferNumber || '',
          greeting_phrase: restaurantData?.greetingPhrase || '',
          menu_item_names: menuItemNames?.join(', ') || 'Menu not available',
          store_status: storeInfo?.status || 'Store status unavailable',
          store_hours: storeInfo?.allHours || 'Hours not available',
          holiday_hours: holidayHoursFormatted
        },
        metadata: {
          request_timestamp: new Date().toISOString()
        }
      }
    };

    console.log('Final dynamic variables payload:', JSON.stringify(response.call_inbound.dynamic_variables, null, 2));
    console.log('Returning response with menu items:', JSON.stringify(response, null, 2));

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: JSON.stringify(response)
    };

  } catch (error) {
    console.error('Error handling inbound call:', error);
    
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

// Helper function to get location ID from phone number
async function getLocationFromPhoneNumber(phoneNumber) {
  try {
    console.log(`Looking up location for phone number: ${phoneNumber}`);
    
    const params = {
      TableName: PHONE_NUMBER_CLIENT_MAP_TABLE,
      Key: { phoneNumber: phoneNumber }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      throw new Error(`No location found for phone number: ${phoneNumber}`);
    }
    
    console.log(`Found location ID: ${result.Item.locationId}`);
    return {
      locationId: result.Item.locationId
    };
  } catch (error) {
    console.error('Error looking up location:', error);
    throw error;
  }
}

// Helper function to get restaurant details from clientDatabase
async function getRestaurantDetails(locationId) {
  try {
    console.log(`Getting restaurant details for location: ${locationId}`);
    
    const params = {
      TableName: CLIENT_DATABASE_TABLE,
      Key: { locationId: locationId }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      throw new Error(`No restaurant found for location ID: ${locationId}`);
    }
    
    console.log(`Found restaurant: ${result.Item.restaurantName}`);
    return result.Item;
  } catch (error) {
    console.error('Error getting restaurant details:', error);
    throw error;
  }
}

// Helper function to get location-specific menu items from clientMenu table
async function getLocationSpecificMenuItems(restaurantName, locationId) {
  try {
    console.log(`Getting menu for: ${restaurantName} at location: ${locationId}`);
    
    const params = {
      TableName: CLIENT_MENU_TABLE,
      Key: { 
        restaurantName: restaurantName,
        locationID: locationId 
      }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      console.warn(`No menu found for ${restaurantName} at location ${locationId}`);
      return [];
    }
    
    console.log(`Found menu with ${result.Item.itemCount || 'unknown'} items`);
    
    // Extract menu item names (skip metadata fields)
    const metadataFields = ['restaurantName', 'locationID', 'locationName', 'lastUpdated', 'itemCount'];
    const menuItemNames = Object.entries(result.Item)
      .filter(([key, value]) => !metadataFields.includes(key))
      .map(([itemName, itemData]) => {
        // Extract price from itemData
        const price = itemData.price || 0;
        const formattedPrice = (price / 100).toFixed(2); // Convert cents to dollars
        
        // Add description if available
        const description = itemData.description && itemData.description.trim() 
          ? ` - ${itemData.description}` 
          : '';
        
        return `${itemName} $${formattedPrice}${description}`;
      })
      .sort();
    
    console.log(`Retrieved ${menuItemNames.length} menu items`);
    return menuItemNames;
    
  } catch (error) {
    console.error('Error getting menu items:', error);
    throw error;
  }
} 
