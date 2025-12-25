# Toast Custom Integration Quick Start Guide

## What is a Custom Integration?

A **Custom Integration** is a Toast API integration built for a specific restaurant or restaurant group. Unlike Partner integrations (which serve many restaurants), custom integrations are typically built for:

- A single restaurant location
- A specific restaurant group/chain
- A custom solution for a particular Toast customer

## Getting Started

### 1. Apply for Custom Integration Access

**Contact Toast:**
- Reach out to Toast support or your Toast account representative
- Request custom integration access
- Explain your use case and what you're building

**What Toast Needs to Know:**
- What problem you're solving
- Which restaurant(s) need access
- What APIs you need (orders, menus, etc.)
- Whether this is for testing or production

### 2. Wait for Approval

Toast integrations team will:
- Review your request
- Approve your custom integration
- Create your API credentials
- Provision access to restaurant(s)

**Timeline:** Varies, but typically 1-2 weeks

### 3. Receive Your Credentials

Toast will provide you with:

#### Sandbox (Testing) Credentials:
```
Client ID: [provided by Toast]
Client Secret: [provided by Toast]
API Base URL: https://ws-sandbox-api.toasttab.com
Restaurant GUID(s): [test restaurant IDs]
```

#### Production Credentials:
```
Client ID: [provided by Toast]
Client Secret: [provided by Toast]
API Base URL: https://ws-api.toasttab.com
Restaurant GUID(s): [live restaurant IDs]
```

## Setting Up Your Environment

### Development/Testing Setup

```bash
# Sandbox credentials (for testing)
export TOAST_CLIENT_ID="sandbox-client-id"
export TOAST_CLIENT_SECRET="sandbox-client-secret"
export TOAST_API_BASE_URL="https://ws-sandbox-api.toasttab.com"
export TOAST_RESTAURANT_GUID="test-restaurant-guid"
```

### Production Setup

```bash
# Production credentials (for live use)
export TOAST_CLIENT_ID="production-client-id"
export TOAST_CLIENT_SECRET="production-client-secret"
export TOAST_API_BASE_URL="https://ws-api.toasttab.com"
export TOAST_RESTAURANT_GUID="live-restaurant-guid"
```

## How Custom Integration Authentication Works

### One Set of Credentials for All Your Restaurants

```
Your Custom Integration Credentials
              ↓
        Authenticate Once
              ↓
      Get Authentication Token
              ↓
    Use Token for ALL Restaurants
    (that Toast provisioned for you)
```

### Example Flow:

```javascript
// 1. Authenticate with your custom integration credentials
const token = await authenticateToast(
  process.env.TOAST_CLIENT_ID,
  process.env.TOAST_CLIENT_SECRET
);

// 2. Use same token for different restaurants (if you have access to multiple)
await createToastOrder({
  restaurantGuid: 'restaurant-1-guid',  // Restaurant A
  clientId: process.env.TOAST_CLIENT_ID,
  clientSecret: process.env.TOAST_CLIENT_SECRET,
  // ... order details
});

await createToastOrder({
  restaurantGuid: 'restaurant-2-guid',  // Restaurant B (if provisioned)
  clientId: process.env.TOAST_CLIENT_ID,
  clientSecret: process.env.TOAST_CLIENT_SECRET,
  // ... order details
});
```

## What You Need from the Restaurant

In addition to Toast credentials, you'll need these details from each restaurant:

### 1. Restaurant GUID
- Unique identifier for the restaurant location
- Toast can provide this, or restaurant admin can find it in Toast Web
- Format: `4721e7a9-b4ae-4fef-9230-b3dae186e0a4`

### 2. Dining Option GUIDs
Each restaurant has different dining options configured. You need the GUID for:
- **Delivery** dining option
- **Takeout** dining option  
- **Dine-in** dining option
- **Curbside** dining option (if applicable)

**How to get:** 
- Fetch from Toast configuration API (once you have credentials)
- Or have restaurant admin provide them

### 3. Payment Type GUIDs (Optional)
If creating orders with payment information, you need:
- GUID for "OTHER" payment type
- Or other payment method GUIDs

**How to get:**
- Fetch from Toast configuration API
- Or have restaurant admin provide them

## Testing Your Integration

### Step 1: Test Authentication

```javascript
const { authenticateToast } = require('./getToastMenu');

async function testAuth() {
  try {
    const token = await authenticateToast(
      process.env.TOAST_CLIENT_ID,
      process.env.TOAST_CLIENT_SECRET
    );
    console.log('✅ Authentication successful!');
    console.log('Token:', token.substring(0, 50) + '...');
  } catch (error) {
    console.error('❌ Authentication failed:', error.message);
  }
}

testAuth();
```

### Step 2: Test Menu Fetch

```javascript
const { getToastMenu } = require('./getToastMenu');

async function testMenu() {
  try {
    const menu = await getToastMenu(
      process.env.TOAST_RESTAURANT_GUID,
      process.env.TOAST_CLIENT_ID,
      process.env.TOAST_CLIENT_SECRET
    );
    console.log('✅ Menu fetched successfully!');
    console.log(`Found ${menu.menus.length} menus`);
  } catch (error) {
    console.error('❌ Menu fetch failed:', error.message);
  }
}

testMenu();
```

### Step 3: Test Order Creation

```javascript
const { createTakeoutOrder } = require('./createToastOrder');
const { getToastMenu, findMenuItems } = require('./getToastMenu');

async function testOrder() {
  try {
    // Get menu and find an item
    const menu = await getToastMenu(
      process.env.TOAST_RESTAURANT_GUID,
      process.env.TOAST_CLIENT_ID,
      process.env.TOAST_CLIENT_SECRET
    );
    
    const items = findMenuItems(menu, 'burger');
    if (items.length === 0) {
      console.log('❌ No items found to test with');
      return;
    }

    const testItem = items[0];
    
    // Create test order
    const result = await createTakeoutOrder({
      restaurantGuid: process.env.TOAST_RESTAURANT_GUID,
      clientId: process.env.TOAST_CLIENT_ID,
      clientSecret: process.env.TOAST_CLIENT_SECRET,
      diningOptionGuid: process.env.TOAST_DINING_OPTION_GUID,
      customer: {
        firstName: 'Test',
        lastName: 'Customer',
        phone: '5555555555',
        email: 'test@example.com'
      },
      items: [{
        guid: testItem.guid,
        quantity: 1,
        price: testItem.price
      }]
    });

    if (result.success) {
      console.log('✅ Order created successfully!');
      console.log('Order GUID:', result.orderGuid);
    } else {
      console.log('❌ Order creation failed:', result.errorMessage);
    }
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testOrder();
```

## Common Issues and Solutions

### Issue: "Authentication failed"
**Possible causes:**
- Wrong `clientId` or `clientSecret`
- Using sandbox credentials with production URL (or vice versa)
- Credentials not yet activated by Toast

**Solution:**
- Double-check credentials from Toast
- Verify you're using correct `TOAST_API_BASE_URL`
- Contact Toast if credentials don't work

### Issue: "Restaurant not found" or "Access denied"
**Possible causes:**
- Wrong restaurant GUID
- Toast hasn't provisioned access to that restaurant for your credentials
- Restaurant GUID is from different environment (sandbox vs production)

**Solution:**
- Verify restaurant GUID is correct
- Confirm Toast has granted your credentials access to this restaurant
- Make sure you're using matching environment (sandbox/production)

### Issue: "Dining option not found"
**Possible causes:**
- Wrong dining option GUID
- Dining option not configured for this restaurant
- GUID from different restaurant

**Solution:**
- Fetch dining options from Toast configuration API
- Have restaurant admin verify dining options are configured
- Use correct GUID for this specific restaurant

### Issue: Token expired (401 error)
**Cause:** Token is only valid for 24 hours

**Solution:**
- Code already handles this automatically
- New token is requested when old one expires
- If you see this repeatedly, check system clock

## Security Best Practices

### ✅ DO:
1. **Store credentials in environment variables**
   ```bash
   # .env file (add to .gitignore!)
   TOAST_CLIENT_ID=your-client-id
   TOAST_CLIENT_SECRET=your-client-secret
   ```

2. **Use a secret management service** (AWS Secrets Manager, Azure Key Vault, etc.)

3. **Mask client secret in logs**
   ```javascript
   console.log('Client ID:', clientId);
   console.log('Client Secret:', '*'.repeat(clientSecret.length)); // Masked
   ```

4. **Rotate credentials if compromised**

### ❌ DON'T:
1. **Never commit credentials to Git**
   ```bash
   # Add to .gitignore
   .env
   .env.local
   .env.production
   ```

2. **Never hardcode credentials in code**
   ```javascript
   // ❌ BAD
   const clientId = "my-client-id";
   
   // ✅ GOOD
   const clientId = process.env.TOAST_CLIENT_ID;
   ```

3. **Never send credentials via email/Slack in plain text**

4. **Never display secret on screen shares**

## Going to Production

### Pre-Production Checklist:

- [ ] All sandbox tests passing
- [ ] Restaurant staff trained on new integration
- [ ] Production credentials received from Toast
- [ ] Environment variables configured for production
- [ ] Error logging and monitoring set up
- [ ] Backup/rollback plan in place

### Production Deployment:

1. **Switch to production credentials:**
   ```bash
   export TOAST_CLIENT_ID="production-client-id"
   export TOAST_CLIENT_SECRET="production-client-secret"
   export TOAST_API_BASE_URL="https://ws-api.toasttab.com"
   ```

2. **Test with a real order** (small/test item)

3. **Monitor for errors:**
   - Authentication failures
   - Order creation failures
   - Menu fetch issues

4. **Have Toast support contact ready** in case of issues

## Getting Help

### Toast Support
- **Developer documentation:** https://doc.toasttab.com/
- **API reference:** https://doc.toasttab.com/openapi/
- **Contact:** Toast support or your account representative

### Common Resources
- **Authentication docs:** https://doc.toasttab.com/doc/devguide/apiAuthentication.html
- **Orders API:** https://doc.toasttab.com/openapi/orders/operation/
- **Menus API:** https://doc.toasttab.com/openapi/menus/operation/
- **Custom integration overview:** https://doc.toasttab.com/doc/devguide/customIntegrationOverview.html

## Summary: What You Need

### From Toast:
- ✅ Custom integration approval
- ✅ Client ID
- ✅ Client Secret
- ✅ Restaurant GUID(s)
- ✅ Sandbox credentials (for testing)
- ✅ Production credentials (for live)

### From Restaurant:
- ✅ Restaurant GUID confirmation
- ✅ Dining option GUIDs
- ✅ Payment type GUIDs (if needed)

### Your Setup:
- ✅ Environment variables configured
- ✅ Dependencies installed (`npm install axios`)
- ✅ Integration files (`getToastMenu.js`, `createToastOrder.js`)
- ✅ Tests passing in sandbox
- ✅ Production deployment plan

---

**You're now ready to build your Toast custom integration!** 🎉

