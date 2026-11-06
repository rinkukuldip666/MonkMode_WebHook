import crypto from 'crypto';
import admin from 'firebase-admin';

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

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
    if (!sub) {
      return res.status(200).json({ received: true });
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
