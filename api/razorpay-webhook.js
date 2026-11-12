import crypto from 'crypto';
import admin from 'firebase-admin';

export const config = { api: { bodyParser: false } };

// 1. Initialize Firebase Admin SDK
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

    // 2. HMAC SHA256 Signature Security Check
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

      console.log(`💳 Payment Captured: ₹${amountInRupees}, User: ${userId}`);
      if (!userId) return res.status(400).json({ error: 'Missing userId' });

      // FIX 2: Duplicate Payment Check - Agar Razorpay 2 baar bhejega to yahi ruk jayega
      const existingPay = await db.collection('payments').doc(paymentId).get();
      if (existingPay.exists) {
        console.log(`ℹ️ Payment ${paymentId} already processed. Skipping.`);
        return res.status(200).json({ status: 'ALREADY_PROCESSED' });
      }

      // 3. LIVE PRICE CHECK (Sirf ₹99 ya usse zyada pe PRO ON hoga)
      if (amountInRupees >= 99) {
        const now = Date.now();
        const expiresAt = now + 30 * 24 * 60 * 60 * 1000;

        // A) Activate User Pro Pass in Firestore
        await db.collection('users').doc(userId).set({
          userId: userId, uid: userId, deviceId: deviceId, email: userEmail,
          isPremiumActive: true, planType: 'PRO_MONTHLY', premiumStartedAt: now,
          premiumExpiresAt: expiresAt, paymentStatus: 'SUCCESS',
          lastPaymentId: paymentId, lastUpdated: now
        }, { merge: true });

        // B) Save Payment Log
        await db.collection('payments').doc(paymentId).set({
          paymentId: paymentId, userId: userId, deviceId: deviceId,
          userEmail: userEmail, amountRupees: amountInRupees,
          status: 'SUCCESS', provider: 'RAZORPAY_WEBHOOK',
          createdAtTimestamp: now, expiresAtTimestamp: expiresAt
        }, { merge: true });

        console.log(`🎉 PRO ON for ${userId}`);

        // C) IDEMPOTENCY CHECK: Duplicate crediting prevent karta hai
        const commDocId = `${paymentId}_COMM`;
        const commRef = db.collection('commissions').doc(commDocId);
        const commSnap = await commRef.get();

        if (!commSnap.exists) {
          const userDoc = await db.collection('users').doc(userId).get();
          if (userDoc.exists) {
            const userData = userDoc.data();
            const referrerUid = userData?.referredBy;
            const payingDeviceId = userData?.deviceId || deviceId;

            // ANTI-CHEAT 1: User cannot refer themselves!
            if (referrerUid && typeof referrerUid === 'string' && referrerUid.trim() !== '' && referrerUid !== userId) {
              const referrerRef = db.collection('users').doc(referrerUid);
              const referrerSnap = await referrerRef.get();

              if (referrerSnap.exists) {
                const referrerData = referrerSnap.data();
                const referrerDeviceId = referrerData?.deviceId || '';

                // ANTI-CHEAT 2: User cannot refer another account on the SAME physical phone!
                if (!referrerDeviceId || referrerDeviceId !== payingDeviceId) {
                  // FIX 1: Flat ₹20 - 30% hataya, ab koi decimal nahi aayega
                  const commissionAmount = 20;

                  // Atomically increment Referrer Wallet
                  await referrerRef.update({
                    walletBalance: admin.firestore.FieldValue.increment(commissionAmount),
                    totalEarnings: admin.firestore.FieldValue.increment(commissionAmount),
                    pendingPayout: admin.firestore.FieldValue.increment(commissionAmount),
                    totalReferralsCount: admin.firestore.FieldValue.increment(1)
                  });

                  // Log commission audit transaction
                  await commRef.set({
                    paymentId: paymentId,
                    referrerUid: referrerUid,
                    referredUserId: userId,
                    referredUserEmail: userEmail,
                    amountPaid: amountInRupees,
                    commissionRate: 'FLAT_20',
                    commissionAmount: commissionAmount,
                    status: 'CREDITED',
                    timestamp: now
                  }, { merge: true });

                  console.log(`🎁 Referrer ${referrerUid} credited with ₹${commissionAmount} (Flat ₹20)`);
                } else {
                  console.log(`🛡️ Anti-Cheat Triggered: Blocked referral commission on SAME device (${payingDeviceId})`);
                }
              }
            }
          }
        } else {
          console.log(`ℹ️ Commission for payment ${paymentId} already credited. Skipping duplicate.`);
        }
      }
    }
    return res.status(200).json({ status: 'SUCCESS' });
  } catch (error) {
    console.error('❌ Webhook Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
