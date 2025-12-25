/**
 * Example Usage of Toast API Integration
 * 
 * This file shows how to use the Toast menu and order APIs
 * 
 * Note: These examples won't work without valid credentials
 * You'll need to set up environment variables or pass actual credentials
 */

const { getToastMenu, findMenuItems, getMenuItemByGuid } = require('./getToastMenu');
const { createToastOrder, createDeliveryOrder, createTakeoutOrder } = require('./createToastOrder');

// ========================================
// Configuration (Replace with actual values)
// ========================================
const config = {
  clientId: process.env.TOAST_CLIENT_ID || 'your-client-id-here',
  clientSecret: process.env.TOAST_CLIENT_SECRET || 'your-client-secret-here',
  restaurantGuid: process.env.TOAST_RESTAURANT_GUID || 'your-restaurant-guid-here',
  diningOptionGuid: process.env.TOAST_DINING_OPTION_GUID || 'your-dining-option-guid-here',
  paymentTypeGuid: process.env.TOAST_PAYMENT_TYPE_GUID || 'your-payment-type-guid-here'
};

// ========================================
// Example 1: Fetch and Search Menu
// ========================================
async function exampleFetchMenu() {
  try {
    console.log('\n=== Example 1: Fetch Menu ===\n');

    // Fetch complete menu
    const menu = await getToastMenu(
      config.restaurantGuid,
      config.clientId,
      config.clientSecret
    );

    console.log(`Total menus: ${menu.menus.length}`);
    console.log(`Restaurant timezone: ${menu.restaurantTimeZone}`);

    // Search for specific items
    const burgers = findMenuItems(menu, 'burger');
    console.log(`\nFound ${burgers.length} burger items:`);
    burgers.forEach(item => {
      console.log(`  - ${item.name}: $${item.price}`);
    });

    return menu;
  } catch (error) {
    console.error('Example 1 failed:', error.message);
  }
}

// ========================================
// Example 2: Create Simple Delivery Order
// ========================================
async function exampleCreateDeliveryOrder() {
  try {
    console.log('\n=== Example 2: Create Delivery Order ===\n');

    // First, get menu to find items
    const menu = await getToastMenu(
      config.restaurantGuid,
      config.clientId,
      config.clientSecret
    );

    // Find a menu item
    const items = findMenuItems(menu, 'burger');
    if (items.length === 0) {
      console.log('No items found. Cannot create order.');
      return;
    }

    const burgerItem = items[0];
    console.log(`Ordering: ${burgerItem.name} - $${burgerItem.price}`);

    // Create delivery order
    const result = await createDeliveryOrder({
      restaurantGuid: config.restaurantGuid,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      diningOptionGuid: config.diningOptionGuid,
      paymentTypeGuid: config.paymentTypeGuid,
      customer: {
        firstName: 'John',
        lastName: 'Doe',
        phone: '5555555555',
        email: 'john.doe@example.com'
      },
      items: [
        {
          guid: burgerItem.guid,
          quantity: 2,
          price: burgerItem.price
        }
      ],
      address: {
        street: '401 Park Drive',
        unit: 'Suite 801',
        city: 'Boston',
        state: 'MA',
        zipCode: '02215',
        notes: 'Ring the doorbell please'
      }
    });

    if (result.success) {
      console.log('\n✅ Order created successfully!');
      console.log(`Order GUID: ${result.orderGuid}`);
      console.log(`Display Number: ${result.displayNumber}`);
    } else {
      console.log('\n❌ Order creation failed');
      console.log(`Error: ${result.errorMessage}`);
    }

    return result;
  } catch (error) {
    console.error('Example 2 failed:', error.message);
  }
}

// ========================================
// Example 3: Create Takeout Order
// ========================================
async function exampleCreateTakeoutOrder() {
  try {
    console.log('\n=== Example 3: Create Takeout Order ===\n');

    // First, get menu
    const menu = await getToastMenu(
      config.restaurantGuid,
      config.clientId,
      config.clientSecret
    );

    // Find multiple items
    const pizza = findMenuItems(menu, 'pizza')[0];
    const salad = findMenuItems(menu, 'salad')[0];

    if (!pizza || !salad) {
      console.log('Required items not found. Cannot create order.');
      return;
    }

    console.log(`Ordering:`);
    console.log(`  - ${pizza.name}: $${pizza.price}`);
    console.log(`  - ${salad.name}: $${salad.price}`);

    // Create takeout order for pickup in 30 minutes
    const promisedDate = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const result = await createTakeoutOrder({
      restaurantGuid: config.restaurantGuid,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      diningOptionGuid: config.diningOptionGuid,
      paymentTypeGuid: config.paymentTypeGuid,
      customer: {
        firstName: 'Jane',
        lastName: 'Smith',
        phone: '5555551234',
        email: 'jane.smith@example.com'
      },
      items: [
        {
          guid: pizza.guid,
          quantity: 1,
          price: pizza.price
        },
        {
          guid: salad.guid,
          quantity: 1,
          price: salad.price
        }
      ],
      promisedDate: promisedDate
    });

    if (result.success) {
      console.log('\n✅ Takeout order created successfully!');
      console.log(`Order GUID: ${result.orderGuid}`);
      console.log(`Pickup time: ${promisedDate}`);
    } else {
      console.log('\n❌ Order creation failed');
      console.log(`Error: ${result.errorMessage}`);
    }

    return result;
  } catch (error) {
    console.error('Example 3 failed:', error.message);
  }
}

// ========================================
// Example 4: Create Custom Order
// ========================================
async function exampleCreateCustomOrder() {
  try {
    console.log('\n=== Example 4: Create Custom Order ===\n');

    // Get menu item by GUID (if you already know it)
    const menu = await getToastMenu(
      config.restaurantGuid,
      config.clientId,
      config.clientSecret
    );

    const item = getMenuItemByGuid(menu, 'some-guid-here');
    
    if (!item) {
      console.log('Item not found');
      return;
    }

    // Create custom order with full control
    const result = await createToastOrder({
      restaurantGuid: config.restaurantGuid,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      diningOptionGuid: config.diningOptionGuid,
      paymentTypeGuid: config.paymentTypeGuid,
      customer: {
        firstName: 'Bob',
        lastName: 'Johnson',
        phone: '5555559999',
        email: 'bob@example.com'
      },
      items: [
        {
          guid: item.guid,
          quantity: 3,
          price: item.price
        }
      ],
      externalId: 'MY-SYSTEM-ORDER-12345', // Track with your own ID
      deliveryInfo: {
        address1: '123 Main St',
        city: 'Boston',
        state: 'MA',
        zipCode: '02101',
        notes: 'Leave at door'
      }
    });

    if (result.success) {
      console.log('\n✅ Custom order created!');
      console.log(`Order GUID: ${result.orderGuid}`);
    }

    return result;
  } catch (error) {
    console.error('Example 4 failed:', error.message);
  }
}

// ========================================
// Run Examples
// ========================================
async function runExamples() {
  console.log('Toast API Integration Examples');
  console.log('================================');
  console.log('Note: These will fail without valid credentials\n');

  // Uncomment the examples you want to run:
  
  // await exampleFetchMenu();
  // await exampleCreateDeliveryOrder();
  // await exampleCreateTakeoutOrder();
  // await exampleCreateCustomOrder();

  console.log('\n=== Examples Complete ===\n');
}

// Run if executed directly
if (require.main === module) {
  runExamples().catch(console.error);
}

module.exports = {
  exampleFetchMenu,
  exampleCreateDeliveryOrder,
  exampleCreateTakeoutOrder,
  exampleCreateCustomOrder
};

