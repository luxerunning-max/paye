const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const PAYMEGATE_KEY = process.env.PAYMEGATE_API_KEY;

let shopifyToken = null;
let tokenExpires = 0;

async function getShopifyToken() {
  if (shopifyToken && Date.now() < tokenExpires - 60000) {
    return shopifyToken;
  }

  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Impossible de récupérer le token Shopify: ' + JSON.stringify(data));
  }

  shopifyToken = data.access_token;
  tokenExpires = Date.now() + (data.expires_in || 86400) * 1000;
  return shopifyToken;
}

async function getOrder(orderId) {
  const token = await getShopifyToken();
  const res = await fetch(`https://${SHOP}/admin/api/2024-10/orders/${orderId}.json`, {
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    }
  });
  const data = await res.json();
  return data.order;
}

async function markOrderPaid(orderId) {
  const token = await getShopifyToken();
  const res = await fetch(`https://${SHOP}/admin/api/2024-10/orders/${orderId}/transactions.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      transaction: {
        kind: 'sale',
        status: 'success',
        source: 'external'
      }
    })
  });
  return res.json();
}

// Route principale : /pay?order_id=XXXX
app.get('/pay', async (req, res) => {
  try {
    const orderId = req.query.order_id;
    if (!orderId) return res.status(400).send('order_id manquant');

    const order = await getOrder(orderId);
    if (!order) return res.status(404).send('Commande introuvable');

    const amount = order.total_price;
    const currency = order.currency;
    const email = order.email || order.customer?.email || 'client@example.com';
    const name = order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : 'Client';

    const pmRes = await fetch('https://api.paymegate.com/v1/orders', {
      method: 'POST',
      headers: {
        'X-API-Key': PAYMEGATE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        externalId: String(orderId),
        amount: amount,
        currency: currency,
        paymentMethodsKeys: ['*'],
        backUrl: `https://${SHOP}/`,
        customer: {
          email: email,
          fullName: name
        },
        metadata: {
          shopify_order_id: String(orderId)
        }
      })
    });

    const pmData = await pmRes.json();
    const checkoutUrl = pmData?.data?.checkoutUrl || pmData?.checkoutUrl;

    if (!checkoutUrl) {
      console.error(pmData);
      return res.status(500).send('Erreur PayMeGate');
    }

    res.redirect(checkoutUrl);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur serveur');
  }
});

// Webhook PayMeGate
app.post('/webhook/paymegate', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook reçu:', JSON.stringify(body));

    if (body.type === 'order.paid' || body.status === 'PAID') {
      const orderId = body.externalId || body.metadata?.shopify_order_id;
      if (orderId) {
        await markOrderPaid(orderId);
        console.log('Commande marquée payée:', orderId);
      }
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error(err);
    res.status(200).send('ok');
  }
});

app.get('/', (req, res) => {
  res.send('PayMeGate Shopify bridge OK');
});

app.listen(PORT, () => {
  console.log('Serveur démarré sur le port', PORT);
});
