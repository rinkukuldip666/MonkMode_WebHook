import crypto from 'crypto';
import admin from 'firebase-admin';

export const config = { api: { bodyParser: false } };

// 1. Initialize Firebase Admin SDK
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('âœ… Firebase Admin Initialized Successfully');
  } catch (error) {
    console.error('âŒ Firebase Admin Init Error:', error.message);
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

    if (!secret) {
      console.error('âŒ Server Config Error: RAZORPAY_WEBHOOK_SECRET is missing!');
      return res.status(500).json({ error: 'Server config error: Webhook secret missing' });
    }

    // 2. HMAC SHA256 Signature Security Verification
    const expectedSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (expectedSignature !== signature) {
      console.error('âŒ Signature Mismatch! Unauthorized request.');
      return res.status(400).json({ error: 'Invalid Signature' });
    }

    const payload = JSON.parse(rawBody);
    const event = payload.event;
    console.log(`ðŸ“© Webhook Event Received: ${event}`);

    if (event === 'payment.captured') {
      const payment = payload.payload?.payment?.entity;
      if (!payment) return res.status(400).json({ error: 'Invalid Payment Payload' });

      const paymentId = payment.id;
      const amountInRupees = (payment.amount || 0) / 100; // Razorpay sends amount in paise
      const userId = payment.notes?.userId || payment.notes?.buyerUid;
      const userEmail = payment.notes?.userEmail || payment.email || 'N/A';
      const deviceId = payment.notes?.deviceId || 'UNKNOWN_DEVICE';

      console.log(`ðŸ’³ Payment Captured: â‚¹${amountInRupees}, PaymentId: ${paymentId}, User: ${userId}`);

      if (!userId) {
        console.error('âŒ Missing userId in payment notes!');
        return res.status(400).json({ error: 'Missing userId in notes' });
      }

      // 3. Duplicate Payment Deduplication Check
      const existingPay = await db.collection('payments').doc(paymentId).get();
      if (existingPay.exists) {
        console.log(`â„¹ï¸ Payment ${paymentId} already processed. Skipping duplicate processing.`);
        return res.status(200).json({ status: 'ALREADY_PROCESSED' });
      }

      // 4. LIVE PRICE CHECK (Activates 30-Day PRO for â‚¹49 or higher)
      if (amountInRupees >= 49) {
        const now = Date.now();
        const expiresAt = now + (30 * 24 * 60 * 60 * 1000); // 30 Days in Milliseconds

        const userDocBefore = await db.collection('users').doc(userId).get();
        const userDataBefore = userDocBefore.exists ? userDocBefore.data() : {};
        const isFirstPaidPayment = userDataBefore?.hasPaidBefore !== true;

        // A) Activate User PRO Status & Expiry in Firestore (users collection)
        await db.collection('users').doc(userId).set({
          userId: userId,
          uid: userId,
          deviceId: deviceId,
          email: userEmail,
          isPro: true,                          // App reads 'isPro'
          proExpiryTimestamp: expiresAt,       // 30-Day Expiry Timestamp (Used by App)
          premiumExpiresAt: expiresAt,         // Backup Expiry field
          planType: 'PRO_MONTHLY',
          premiumStartedAt: now,
          paymentStatus: 'SUCCESS',
          lastPaymentId: paymentId,
          lastPaymentAmount: amountInRupees,
          lastUpdated: now,
          hasPaidBefore: true,
          totalPaidCount: admin.firestore.FieldValue.increment(1)
        }, { merge: true });

        // B) Save Verified Payment Log in Firestore (payments collection)
        await db.collection('payments').doc(paymentId).set({
          paymentId: paymentId,
          userId: userId,
          deviceId: deviceId,
          userEmail: userEmail,
          amountRupees: amountInRupees,
          status: 'SUCCESS',
          provider: 'RAZORPAY_WEBHOOK',
          createdAtTimestamp: now,
          expiresAtTimestamp: expiresAt,
          isFirstPaidPayment: isFirstPaidPayment
        }, { merge: true });

        console.log(`ðŸŽ‰ 30-Day PRO Pass Activated for User: ${userId} (UID) | Amount: â‚¹${amountInRupees} | Expires At: ${new Date(expiresAt).toISOString()}`);
      } else {
        console.warn(`âš ï¸ Payment amount â‚¹${amountInRupees} is less than required â‚¹49. PRO activation skipped.`);
      }
    }

    return res.status(200).json({ status: 'SUCCESS' });
  } catch (error) {
    console.error('âŒ Webhook Processing Error:', error);
    return res.status(500).json({ error: error.message });
  }
        }
