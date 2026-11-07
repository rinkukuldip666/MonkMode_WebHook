import crypto from 'crypto';
import admin from 'firebase-admin';

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// TERA PLAN - ₹99 = 9900 paise me
const EXPECTED_AMOUNT = 9900; 

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];
    const body = JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    if (signature !== expected) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = req.body.event;
    const sub = req.body.payload?.subscription?.entity;
    const payment = req.body.payload?.payment?.entity;

    if (!sub) {
      return res.status(200).json({ received: true });
    }

    // --- NAYA LOCK 1: AMOUNT CHECK ---
    // Agar payment aaya hai, to uska amount check karo
    // Agar payment ₹99 (9900) ka nahi hai, to Pro MAT banao
    if (event === 'subscription.charged' || event === 'subscription.activated') {
      if (payment) {
        // Payment fail hua to bhi Pro mat banao
        if (payment.status !== 'captured' && payment.status !== 'authorized') {
          console.log('Payment not captured, ignoring. Status:', payment.status);
          return res.status(200).json({ received: true, reason: 'payment not captured' });
        }
        // Amount galat hai to Pro mat banao - YAHI ASLI FIX HAI
        if (payment.amount !== EXPECTED_AMOUNT) {
          console.log('Wrong amount:', payment.amount, 'Expected:', EXPECTED_AMOUNT);
          return res.status(200).json({ received: true, reason: 'wrong amount' });
        }
      }
    }

    const usersRef = db.collection('users');
    const snapshot = await usersRef.where('subscriptionId', '==', sub.id).get();
    if (snapshot.empty) {
      return res.status(200).json({ received: true });
    }

    let updateData = {};
    if (event === 'subscription.activated' || event === 'subscription.charged') {
      updateData = { isPro: true, proExpiry: sub.current_end_at, lastPaymentAt: admin.firestore.FieldValue.serverTimestamp() };
    }
    if (event === 'subscription.cancelled' || event === 'subscription.halted' || event === 'subscription.paused') {
      updateData = { isPro: false };
    }

    for (const doc of snapshot.docs) {
      await doc.ref.update(updateData);
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
