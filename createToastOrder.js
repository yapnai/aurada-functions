const axios = require('axios');
const { authenticateToast } = require('./getToastMenu');

/**
 * Toast Order Creation API Integration
 * Creates orders in Toast POS system
 * 
 * Integration Type: Custom Integration
 * - Requires clientId and clientSecret from Toast integrations team
 * - Access provisioned to specific restaurant location(s)
 * - Uses OAuth 2 client-credentials grant type
 */

// Toast API Configuration
const TOAST_API_BASE_URL = process.env.TOAST_API_BASE_URL || 'https://ws-api.toasttab.com';

/**
 * Create a Toast order
 * @param {Object} orderConfig - Order configuration
 * @param {string} orderConfig.restaurantGuid - Toast restaurant GUID
 * @param {string} orderConfig.clientId - Toast API client ID
 * @param {string} orderConfig.clientSecret - Toast API client secret
 * @param {string} orderConfig.diningOptionGuid - Dining option GUID (delivery, takeout, dine-in)
 * @param {Object} orderConfig.customer - Customer information
 * @param {string} orderConfig.customer.firstName - Customer first name
 * @param {string} orderConfig.customer.lastName - Customer last name
 * @param {string} orderConfig.customer.phone - Customer phone number
 * @param {string} orderConfig.customer.email - Customer email
 * @param {Array} orderConfig.items - Array of items to order
 * @param {string} orderConfig.items[].guid - Menu item GUID
 * @param {number} orderConfig.items[].quantity - Item quantity
 * @param {number} orderConfig.items[].price - Item price
 * @param {Object} [orderConfig.deliveryInfo] - Delivery information (required for delivery orders)
 * @param {string} [orderConfig.paymentTypeGuid] - Payment type GUID for OTHER payment type
 * @param {string} [orderConfig.promisedDate] - ISO 8601 date for scheduled orders
 * @param {string} [orderConfig.externalId] - External order ID for tracking
 * @returns {Promise<Object>} Created order data
 */
async function createToastOrder(orderConfig) {
  try {
    const {
      restaurantGuid,
      clientId,
      clientSecret,
      diningOptionGuid,
      customer,
      items,
      deliveryInfo,
      paymentTypeGuid,
      promisedDate,
      externalId
    } = orderConfig;

    // Validate required fields
    if (!restaurantGuid) throw new Error('restaurantGuid is required');
    if (!clientId) throw new Error('clientId is required');
    if (!clientSecret) throw new Error('clientSecret is required');
    if (!diningOptionGuid) throw new Error('diningOptionGuid is required');
    if (!customer) throw new Error('customer is required');
    if (!items || items.length === 0) throw new Error('items array is required and must not be empty');

    console.log(`Creating Toast order for restaurant: ${restaurantGuid}`);
    console.log(`Customer: ${customer.firstName} ${customer.lastName}`);
    console.log(`Items: ${items.length}`);

    // Get authentication token
    const token = await authenticateToast(clientId, clientSecret);

    // Calculate totals
    const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    // Build selections array
    const selections = items.map(item => ({
      item: {
        guid: item.guid
      },
      quantity: item.quantity,
      price: item.price,
      // Toast will calculate tax based on item configuration
      selectionType: 'NONE',
      unitOfMeasure: 'NONE'
    }));

    // Build check with customer and selections
    const check = {
      customer: {
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
        email: customer.email
      },
      selections: selections
    };

    // Add payment if payment type GUID is provided
    if (paymentTypeGuid) {
      check.payments = [{
        type: 'OTHER',
        amount: subtotal,
        otherPayment: {
          guid: paymentTypeGuid
        },
        paymentStatus: 'CAPTURED'
      }];
    }

    // Build order payload
    const orderPayload = {
      diningOption: {
        guid: diningOptionGuid
      },
      checks: [check]
    };

    // Add optional fields
    if (externalId) {
      orderPayload.externalId = externalId;
    }

    if (promisedDate) {
      orderPayload.promisedDate = promisedDate;
      orderPayload.approvalStatus = 'FUTURE';
    } else {
      orderPayload.approvalStatus = 'NEEDS_APPROVAL';
    }

    // Add delivery info if provided
    if (deliveryInfo) {
      orderPayload.deliveryInfo = {
        address1: deliveryInfo.address1,
        address2: deliveryInfo.address2 || null,
        city: deliveryInfo.city,
        state: deliveryInfo.state,
        zipCode: deliveryInfo.zipCode,
        latitude: deliveryInfo.latitude || null,
        longitude: deliveryInfo.longitude || null,
        notes: deliveryInfo.notes || null,
        deliveryState: 'PENDING'
      };
    }

    // Set number of guests
    orderPayload.numberOfGuests = 1;

    console.log('Submitting order to Toast API...');
    console.log(`Subtotal: $${subtotal.toFixed(2)}`);

    // Create order
    const response = await axios.post(
      `${TOAST_API_BASE_URL}/orders/v2/orders`,
      orderPayload,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Toast-Restaurant-External-ID': restaurantGuid,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Order created successfully!');
    console.log(`Order GUID: ${response.data.guid}`);
    console.log(`Order Number: ${response.data.displayNumber || 'N/A'}`);
    console.log(`Approval Status: ${response.data.approvalStatus}`);
    console.log(`Business Date: ${response.data.businessDate}`);

    return {
      success: true,
      order: response.data,
      orderGuid: response.data.guid,
      displayNumber: response.data.displayNumber,
      approvalStatus: response.data.approvalStatus,
      businessDate: response.data.businessDate
    };
  } catch (error) {
    console.error('Error creating Toast order:', error.response?.data || error.message);
    
    // Return structured error
    return {
      success: false,
      error: error.response?.data || error.message,
      errorMessage: error.message
    };
  }
}

/**
 * Create a simple delivery order with minimal configuration
 * @param {Object} config - Simplified order configuration
 * @returns {Promise<Object>} Created order data
 */
async function createDeliveryOrder(config) {
  const {
    restaurantGuid,
    clientId,
    clientSecret,
    diningOptionGuid,
    paymentTypeGuid,
    customer,
    items,
    address
  } = config;

  return createToastOrder({
    restaurantGuid,
    clientId,
    clientSecret,
    diningOptionGuid,
    paymentTypeGuid,
    customer,
    items,
    deliveryInfo: {
      address1: address.street,
      address2: address.unit || null,
      city: address.city,
      state: address.state,
      zipCode: address.zipCode,
      latitude: address.latitude || null,
      longitude: address.longitude || null,
      notes: address.notes || 'Please ring the doorbell.'
    }
  });
}

/**
 * Create a simple takeout order with minimal configuration
 * @param {Object} config - Simplified order configuration
 * @returns {Promise<Object>} Created order data
 */
async function createTakeoutOrder(config) {
  const {
    restaurantGuid,
    clientId,
    clientSecret,
    diningOptionGuid,
    paymentTypeGuid,
    customer,
    items,
    promisedDate
  } = config;

  return createToastOrder({
    restaurantGuid,
    clientId,
    clientSecret,
    diningOptionGuid,
    paymentTypeGuid,
    customer,
    items,
    promisedDate: promisedDate || null
  });
}

/**
 * Get order by GUID
 * @param {string} orderGuid - Toast order GUID
 * @param {string} restaurantGuid - Toast restaurant GUID
 * @param {string} clientId - Toast API client ID
 * @param {string} clientSecret - Toast API client secret
 * @returns {Promise<Object>} Order data
 */
async function getToastOrder(orderGuid, restaurantGuid, clientId, clientSecret) {
  try {
    console.log(`Fetching Toast order: ${orderGuid}`);

    // Get authentication token
    const token = await authenticateToast(clientId, clientSecret);

    // Fetch order
    const response = await axios.get(
      `${TOAST_API_BASE_URL}/orders/v2/orders/${orderGuid}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Toast-Restaurant-External-ID': restaurantGuid
        }
      }
    );

    console.log('Order fetched successfully');
    return response.data;
  } catch (error) {
    console.error('Error fetching Toast order:', error.response?.data || error.message);
    throw new Error(`Failed to fetch order: ${error.message}`);
  }
}

/**
 * Get order by external ID
 * @param {string} externalId - External order ID
 * @param {string} restaurantGuid - Toast restaurant GUID
 * @param {string} clientId - Toast API client ID
 * @param {string} clientSecret - Toast API client secret
 * @returns {Promise<Object>} Order data
 */
async function getToastOrderByExternalId(externalId, restaurantGuid, clientId, clientSecret) {
  try {
    console.log(`Fetching Toast order by external ID: ${externalId}`);

    // Get authentication token
    const token = await authenticateToast(clientId, clientSecret);

    // Fetch order by external ID
    const response = await axios.get(
      `${TOAST_API_BASE_URL}/orders/v2/ordersByExternalId/${encodeURIComponent(externalId)}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Toast-Restaurant-External-ID': restaurantGuid
        }
      }
    );

    console.log('Order fetched successfully');
    return response.data;
  } catch (error) {
    console.error('Error fetching Toast order by external ID:', error.response?.data || error.message);
    throw new Error(`Failed to fetch order: ${error.message}`);
  }
}

module.exports = {
  createToastOrder,
  createDeliveryOrder,
  createTakeoutOrder,
  getToastOrder,
  getToastOrderByExternalId
};

