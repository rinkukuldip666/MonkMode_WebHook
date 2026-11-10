import crypto from 'crypto';
import admin from 'firebase-admin';

export const config = { api: { bodyParser: false } };

if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('✅ Firebase Admin Initialized');
  } catch (error) {
    console.error('❌ Firebase Init Error:', error.message);
  }
}
const db = admin.firestore();

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const rawBody = await getRawBody(req);
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    if (!secret) return res.status(500).json({ error: 'Server config error' });

    const expectedSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (expectedSignature !== signature) {
      console.error('❌ Signature Mismatch!');
      return res.status(400).json({ error: 'Invalid Signature' });
    }

    const payload = JSON.parse(rawBody);
    const event = payload.event;
    console.log(`📩 Event: ${event}`);

    if (event === 'payment.captured') {
      const payment = payload.payload?.payment?.entity;
      if (!payment) return res.status(400).json({ error: 'Invalid Payload' });

      const paymentId = payment.id;
      const amountInRupees = (payment.amount || 0) / 100;
      const userId = payment.notes?.userId;
      const userEmail = payment.notes?.userEmail || payment.email || 'N/A';
      const deviceId = payment.notes?.deviceId || 'UNKNOWN_DEVICE';

      console.log(`💳 Payment: ₹${amountInRupees}, User: ${userId}`);
      if (!userId) return res.status(400).json({ error: 'Missing userId' });

      // LIVE PRICE - Sirf 99 ya usse zyada pe PRO ON hoga
      if (amountInRupees >= 99) {
        const now = Date.now();
        const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
        await db.collection('users').doc(userId).set({
          userId: userId, deviceId: deviceId, email: userEmail,
          isPremiumActive: true, premiumExpiresAt: expiresAt,
          paymentStatus: 'SUCCESS', lastPaymentId: paymentId, lastUpdated: now
        }, { merge: true });

        await db.collection('payments').doc(paymentId).set({
          paymentId: paymentId, userId: userId, deviceId: deviceId,
          userEmail: userEmail, amountRupees: amountInRupees,
          status: 'SUCCESS', provider: 'RAZORPAY_WEBHOOK', createdAtTimestamp: now
        }, { merge: true });
        console.log(`🎉 PRO ON for ${userId}`);
      }
    }
    return res.status(200).json({ status: 'SUCCESS' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
    }
