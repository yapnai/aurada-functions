# Toast POS API Integration

This integration provides functions to interact with the Toast POS system for menu retrieval and order creation.

**Integration Type:** Custom Integration

## Files

- **`getToastMenu.js`** - Functions for fetching and searching menu data
- **`createToastOrder.js`** - Functions for creating and managing orders
- **`toast-example.js`** - Usage examples and reference implementations

## Prerequisites

### Required Credentials

You'll need the following from Toast:

1. **Client ID** - Your Toast API client identifier
2. **Client Secret** - Your Toast API client secret
3. **Restaurant GUID** - The unique identifier for the restaurant
4. **Dining Option GUID** - GUID for delivery/takeout/dine-in option
5. **Payment Type GUID** - GUID for the payment method (for "OTHER" payment type)

### Getting Credentials (Custom Integration)

**Custom integrations** are created by the Toast integrations team after you have been approved for custom integration access.

**Process:**
1. Apply for custom integration access with Toast
2. After approval, Toast team creates your credentials
3. You receive `clientId` and `clientSecret` from Toast
4. Toast team provisions access to specific restaurant(s)

**Documentation:** See Toast's [Custom Integration Overview](https://doc.toasttab.com/doc/devguide/customIntegrationOverview.html)

### Custom Integration Access

**What is a Custom Integration?**
- Built for a specific restaurant or restaurant group
- Credentials provided by Toast integrations team after approval
- Access granted to specific restaurant location(s)
- Uses same authentication flow as Partner integrations
- Ideal for building custom tools for specific Toast customers

**Access Scope:**
- Your credentials work with restaurant(s) Toast has provisioned for you
- One set of credentials (`clientId` + `clientSecret`)
- One authentication token works across all provisioned restaurants
- Specify which restaurant per-request using `Toast-Restaurant-External-ID` header

### Environment Variables

It's recommended to store credentials as environment variables:

```bash
export TOAST_CLIENT_ID="your-client-id"
export TOAST_CLIENT_SECRET="your-client-secret"
export TOAST_RESTAURANT_GUID="your-restaurant-guid"
export TOAST_DINING_OPTION_GUID="your-dining-option-guid"
export TOAST_PAYMENT_TYPE_GUID="your-payment-type-guid"
export TOAST_API_BASE_URL="https://ws-api.toasttab.com" # or sandbox URL
```

**For Custom Integrations:**
- Store the credentials Toast provides you
- Get restaurant GUID(s) from Toast or the restaurant owner
- Toast team will provide access to sandbox environment for testing

## Custom Integration Setup

### Step 1: Get Approved by Toast
1. Contact Toast to request custom integration access
2. Provide details about your integration use case
3. Wait for Toast team approval

### Step 2: Receive Credentials
Toast will provide:
- **Client ID** - Your custom integration identifier
- **Client Secret** - Your authentication secret (keep this secure!)
- **Sandbox credentials** - For testing
- **Production credentials** - For live use

### Step 3: Get Restaurant Information
You'll need from the restaurant or Toast:
- **Restaurant GUID** - Unique ID for each restaurant location
- **Dining Option GUIDs** - IDs for delivery, takeout, dine-in options
- **Payment Type GUIDs** - IDs for payment methods

### Step 4: Test in Sandbox
- Use sandbox credentials and sandbox API URL
- Test menu fetching and order creation
- Verify all flows work correctly

### Step 5: Go Live
- Switch to production credentials
- Update `TOAST_API_BASE_URL` to production URL
- Monitor for errors and authentication issues

## Installation

Install required dependencies:

```bash
npm install axios
```

## Usage

### 1. Fetch Restaurant Menu

```javascript
const { getToastMenu, findMenuItems } = require('./getToastMenu');

async function fetchMenu() {
  // Get complete menu
  const menu = await getToastMenu(
    restaurantGuid,
    clientId,
    clientSecret
  );

  // Search for items
  const burgers = findMenuItems(menu, 'burger');
  console.log(`Found ${burgers.length} burger items`);
}
```

### 2. Create Delivery Order

```javascript
const { createDeliveryOrder } = require('./createToastOrder');

async function orderDelivery() {
  const result = await createDeliveryOrder({
    restaurantGuid: 'restaurant-guid',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    diningOptionGuid: 'delivery-dining-option-guid',
    paymentTypeGuid: 'payment-type-guid',
    customer: {
      firstName: 'John',
      lastName: 'Doe',
      phone: '5555555555',
      email: 'john@example.com'
    },
    items: [
      {
        guid: 'menu-item-guid',
        quantity: 2,
        price: 12.99
      }
    ],
    address: {
      street: '401 Park Drive',
      unit: 'Suite 801',
      city: 'Boston',
      state: 'MA',
      zipCode: '02215',
      notes: 'Ring the doorbell'
    }
  });

  if (result.success) {
    console.log(`Order created: ${result.orderGuid}`);
  }
}
```

### 3. Create Takeout Order

```javascript
const { createTakeoutOrder } = require('./createToastOrder');

async function orderTakeout() {
  // Schedule for 30 minutes from now
  const promisedDate = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const result = await createTakeoutOrder({
    restaurantGuid: 'restaurant-guid',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    diningOptionGuid: 'takeout-dining-option-guid',
    paymentTypeGuid: 'payment-type-guid',
    customer: {
      firstName: 'Jane',
      lastName: 'Smith',
      phone: '5555551234',
      email: 'jane@example.com'
    },
    items: [
      {
        guid: 'menu-item-guid',
        quantity: 1,
        price: 15.99
      }
    ],
    promisedDate: promisedDate
  });

  if (result.success) {
    console.log(`Takeout order created: ${result.orderGuid}`);
  }
}
```

### 4. Create Custom Order

```javascript
const { createToastOrder } = require('./createToastOrder');

async function createCustomOrder() {
  const result = await createToastOrder({
    restaurantGuid: 'restaurant-guid',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    diningOptionGuid: 'dining-option-guid',
    paymentTypeGuid: 'payment-type-guid',
    customer: {
      firstName: 'Bob',
      lastName: 'Johnson',
      phone: '5555559999',
      email: 'bob@example.com'
    },
    items: [
      {
        guid: 'item-1-guid',
        quantity: 2,
        price: 10.99
      },
      {
        guid: 'item-2-guid',
        quantity: 1,
        price: 5.99
      }
    ],
    externalId: 'MY-SYSTEM-ORDER-12345', // Track with your own ID
    deliveryInfo: {
      address1: '123 Main St',
      city: 'Boston',
      state: 'MA',
      zipCode: '02101',
      latitude: 42.3601,
      longitude: -71.0589,
      notes: 'Leave at door'
    }
  });

  return result;
}
```

## API Reference

### getToastMenu.js

#### `getToastMenu(restaurantGuid, clientId, clientSecret)`
Fetches complete menu data from Toast POS.

**Returns:** Promise<Object> - Complete menu structure

#### `findMenuItems(menuData, searchTerm)`
Searches menu for items matching the search term (case-insensitive).

**Returns:** Array of matching menu items

#### `getMenuItemByGuid(menuData, itemGuid)`
Finds a specific menu item by its GUID.

**Returns:** Menu item object or null

#### `getAllMenuItems(menuData)`
Returns all menu items as a flat array.

**Returns:** Array of all menu items

### createToastOrder.js

#### `createToastOrder(orderConfig)`
Creates a Toast order with full customization options.

**Parameters:**
- `orderConfig.restaurantGuid` - Restaurant GUID (required)
- `orderConfig.clientId` - API client ID (required)
- `orderConfig.clientSecret` - API client secret (required)
- `orderConfig.diningOptionGuid` - Dining option GUID (required)
- `orderConfig.customer` - Customer information (required)
- `orderConfig.items` - Array of items to order (required)
- `orderConfig.deliveryInfo` - Delivery information (optional)
- `orderConfig.paymentTypeGuid` - Payment type GUID (optional)
- `orderConfig.promisedDate` - Scheduled date/time (optional)
- `orderConfig.externalId` - External order ID (optional)

**Returns:** Promise<Object> with success status and order data

#### `createDeliveryOrder(config)`
Simplified function for creating delivery orders.

#### `createTakeoutOrder(config)`
Simplified function for creating takeout orders.

#### `getToastOrder(orderGuid, restaurantGuid, clientId, clientSecret)`
Retrieves an order by its Toast GUID.

#### `getToastOrderByExternalId(externalId, restaurantGuid, clientId, clientSecret)`
Retrieves an order by your external ID.

## Authentication

Authentication is handled automatically:
- Token is requested on first API call
- Token is cached and reused until expiration
- New token is automatically requested when expired
- Uses OAuth 2 client-credentials grant type

## Error Handling

All functions return structured responses:

```javascript
// Success
{
  success: true,
  order: {...},
  orderGuid: "...",
  displayNumber: "...",
  approvalStatus: "..."
}

// Failure
{
  success: false,
  error: {...},
  errorMessage: "..."
}
```

## Important Notes

### Tax Calculation
- Toast automatically calculates taxes based on item configuration
- You only need to provide item GUID and price
- Tax rates are configured in Toast POS settings

### Approval Status
- `NEEDS_APPROVAL` - Order requires staff approval
- `APPROVED` - Order is being fulfilled
- `FUTURE` - Scheduled for future date/time
- `NOT_APPROVED` - Staff did not approve in time

### Payment Types
- If `paymentTypeGuid` is not provided, order is created without payment
- Payment can be completed later through Toast POS
- For pre-paid orders, include payment information

### Dining Options
You'll need to determine the correct dining option GUID for:
- Delivery
- Takeout
- Dine-in
- Curbside pickup

These are configured in Toast and vary by restaurant.

## Testing

### Sandbox Environment

Use the sandbox URL for testing:
```bash
export TOAST_API_BASE_URL="https://ws-sandbox-api.toasttab.com"
```

### Test Mode

Toast restaurants can enable test mode. Orders created in test mode have `createdInTestMode: true`.

## Security

⚠️ **Important Security Guidelines:**

1. **Never commit credentials to version control**
2. Store credentials in environment variables or secret management service
3. Use `.gitignore` to exclude credential files
4. Rotate credentials if compromised
5. Don't display client secrets in logs or screen shares

## Troubleshooting

### Common Issues

**Authentication Failed**
- Verify clientId and clientSecret are correct
- Check that credentials haven't expired
- Ensure proper API scopes are granted

**Order Creation Failed**
- Verify all required GUIDs are valid
- Check that dining option supports the order type (delivery, takeout, etc.)
- Ensure menu items are available
- Verify customer information is complete

**Menu Not Found**
- Check restaurant GUID is correct
- Verify API credentials have menu read access
- Ensure restaurant has configured menus

## Support

For issues with:
- **API credentials**: Contact Toast support
- **Code/integration**: Refer to Toast API documentation
- **Restaurant configuration**: Contact restaurant admin

## API Endpoints Used

- `POST /authentication/v1/authentication/login` - Authentication
- `GET /menus/v2/menus` - Fetch menus
- `POST /orders/v2/orders` - Create order
- `GET /orders/v2/orders/{guid}` - Get order by GUID
- `GET /orders/v2/ordersByExternalId/{externalId}` - Get order by external ID

## References

- [Toast API Documentation](https://doc.toasttab.com/)
- [Toast Orders API](https://doc.toasttab.com/openapi/orders/operation/)
- [Toast Menus API](https://doc.toasttab.com/openapi/menus/operation/)
- [Toast Authentication](https://doc.toasttab.com/doc/devguide/apiAuthentication.html)

