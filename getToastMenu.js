const axios = require('axios');

/**
 * Toast Menu API Integration
 * Fetches menu data from Toast POS system
 * 
 * Integration Type: Custom Integration
 * - Requires clientId and clientSecret from Toast integrations team
 * - Access provisioned to specific restaurant location(s)
 * - Uses OAuth 2 client-credentials grant type
 */

// Toast API Configuration
const TOAST_API_BASE_URL = process.env.TOAST_API_BASE_URL || 'https://ws-api.toasttab.com';

// Token cache to avoid re-authenticating on every request
let cachedToken = null;
let tokenExpiry = null;

/**
 * Authenticate with Toast API and get access token
 * @param {string} clientId - Toast API client ID
 * @param {string} clientSecret - Toast API client secret
 * @returns {Promise<string>} Access token
 */
async function authenticateToast(clientId, clientSecret) {
  try {
    // Check if we have a valid cached token
    if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
      console.log('Using cached Toast authentication token');
      return cachedToken;
    }

    console.log('Authenticating with Toast API...');
    
    const response = await axios.post(
      `${TOAST_API_BASE_URL}/authentication/v1/authentication/login`,
      {
        clientId: clientId,
        clientSecret: clientSecret,
        userAccessType: 'TOAST_MACHINE_CLIENT'
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.status === 'SUCCESS') {
      cachedToken = response.data.token.accessToken;
      // Set expiry with 60 second buffer to avoid edge cases
      tokenExpiry = Date.now() + ((response.data.token.expiresIn - 60) * 1000);
      
      console.log('Toast authentication successful');
      console.log(`Token expires in ${response.data.token.expiresIn} seconds`);
      
      return cachedToken;
    } else {
      throw new Error('Authentication failed: ' + JSON.stringify(response.data));
    }
  } catch (error) {
    console.error('Toast authentication error:', error.response?.data || error.message);
    throw new Error(`Failed to authenticate with Toast API: ${error.message}`);
  }
}

/**
 * Fetch complete menu from Toast POS
 * @param {string} restaurantGuid - Toast restaurant GUID
 * @param {string} clientId - Toast API client ID
 * @param {string} clientSecret - Toast API client secret
 * @returns {Promise<Object>} Complete menu data
 */
async function getToastMenu(restaurantGuid, clientId, clientSecret) {
  try {
    console.log(`Fetching menu for restaurant: ${restaurantGuid}`);

    // Get authentication token
    const token = await authenticateToast(clientId, clientSecret);

    // Fetch menu
    const response = await axios.get(
      `${TOAST_API_BASE_URL}/menus/v2/menus`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Toast-Restaurant-External-ID': restaurantGuid
        }
      }
    );

    console.log('Menu fetched successfully');
    console.log(`Restaurant timezone: ${response.data.restaurantTimeZone}`);
    console.log(`Last updated: ${response.data.lastUpdated}`);
    console.log(`Number of menus: ${response.data.menus?.length || 0}`);

    return response.data;
  } catch (error) {
    console.error('Error fetching Toast menu:', error.response?.data || error.message);
    throw new Error(`Failed to fetch menu: ${error.message}`);
  }
}

/**
 * Find menu items by name (case-insensitive search)
 * @param {Object} menuData - Complete menu data from getToastMenu
 * @param {string} searchTerm - Item name to search for
 * @returns {Array} Array of matching menu items
 */
function findMenuItems(menuData, searchTerm) {
  const results = [];
  const searchLower = searchTerm.toLowerCase();

  if (!menuData.menus) {
    return results;
  }

  // Recursive function to search through nested menu groups
  function searchMenuGroup(menuGroup) {
    // Search items in this group
    if (menuGroup.menuItems) {
      menuGroup.menuItems.forEach(item => {
        if (
          item.name?.toLowerCase().includes(searchLower) ||
          item.description?.toLowerCase().includes(searchLower) ||
          item.plu?.toLowerCase().includes(searchLower)
        ) {
          results.push({
            guid: item.guid,
            name: item.name,
            description: item.description,
            price: item.price,
            plu: item.plu,
            sku: item.sku,
            taxInclusion: item.taxInclusion,
            groupName: menuGroup.name
          });
        }
      });
    }

    // Recursively search nested menu groups
    if (menuGroup.menuGroups) {
      menuGroup.menuGroups.forEach(subGroup => searchMenuGroup(subGroup));
    }
  }

  // Search all menus
  menuData.menus.forEach(menu => {
    if (menu.menuGroups) {
      menu.menuGroups.forEach(group => searchMenuGroup(group));
    }
  });

  return results;
}

/**
 * Get menu item by GUID
 * @param {Object} menuData - Complete menu data from getToastMenu
 * @param {string} itemGuid - Item GUID to find
 * @returns {Object|null} Menu item or null if not found
 */
function getMenuItemByGuid(menuData, itemGuid) {
  if (!menuData.menus) {
    return null;
  }

  // Recursive function to search through nested menu groups
  function searchMenuGroup(menuGroup) {
    // Search items in this group
    if (menuGroup.menuItems) {
      const item = menuGroup.menuItems.find(i => i.guid === itemGuid);
      if (item) {
        return {
          ...item,
          groupName: menuGroup.name
        };
      }
    }

    // Recursively search nested menu groups
    if (menuGroup.menuGroups) {
      for (const subGroup of menuGroup.menuGroups) {
        const found = searchMenuGroup(subGroup);
        if (found) return found;
      }
    }

    return null;
  }

  // Search all menus
  for (const menu of menuData.menus) {
    if (menu.menuGroups) {
      for (const group of menu.menuGroups) {
        const found = searchMenuGroup(group);
        if (found) return found;
      }
    }
  }

  return null;
}

/**
 * Get all menu items as a flat array
 * @param {Object} menuData - Complete menu data from getToastMenu
 * @returns {Array} Array of all menu items
 */
function getAllMenuItems(menuData) {
  const items = [];

  if (!menuData.menus) {
    return items;
  }

  // Recursive function to collect all items
  function collectItems(menuGroup) {
    if (menuGroup.menuItems) {
      menuGroup.menuItems.forEach(item => {
        items.push({
          guid: item.guid,
          name: item.name,
          description: item.description,
          price: item.price,
          plu: item.plu,
          sku: item.sku,
          taxInclusion: item.taxInclusion,
          groupName: menuGroup.name
        });
      });
    }

    if (menuGroup.menuGroups) {
      menuGroup.menuGroups.forEach(subGroup => collectItems(subGroup));
    }
  }

  menuData.menus.forEach(menu => {
    if (menu.menuGroups) {
      menu.menuGroups.forEach(group => collectItems(group));
    }
  });

  return items;
}

module.exports = {
  getToastMenu,
  findMenuItems,
  getMenuItemByGuid,
  getAllMenuItems,
  authenticateToast // Exported for use in createToastOrder.js
};

