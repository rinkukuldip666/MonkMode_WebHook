import crypto from 'crypto';
import admin from 'firebase-admin';

export const config = { api: { bodyParser: false } };

// 1. Initialize Firebase Admin SDK
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('✅ Firebase Admin Initialized Successfully');
  } catch (error) {
    console.error('❌ Firebase Admin Init Error:', error.message);
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
      console.error('❌ Server Config Error: RAZORPAY_WEBHOOK_SECRET is missing!');
      return res.status(500).json({ error: 'Server config error: Webhook secret missing' });
    }

    // 2. HMAC SHA256 Signature Security Verification
    const expectedSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (expectedSignature !== signature) {
      console.error('❌ Signature Mismatch! Unauthorized request.');
      return res.status(400).json({ error: 'Invalid Signature' });
    }

    const payload = JSON.parse(rawBody);
    const event = payload.event;
    console.log(`📩 Webhook Event Received: ${event}`);

    if (event === 'payment.captured') {
      const payment = payload.payload?.payment?.entity;
      if (!payment) return res.status(400).json({ error: 'Invalid Payment Payload' });

      const paymentId = payment.id;
      const amountInRupees = (payment.amount || 0) / 100;
      const userId = payment.notes?.userId;
      const userEmail = payment.notes?.userEmail || payment.email || 'N/A';
      const deviceId = payment.notes?.deviceId || 'UNKNOWN_DEVICE';

      console.log(`💳 Payment Captured: ₹${amountInRupees}, PaymentId: ${paymentId}, User: ${userId}`);
      if (!userId) return res.status(400).json({ error: 'Missing userId in notes' });

      // Duplicate Payment Deduplication Check
      const existingPay = await db.collection('payments').doc(paymentId).get();
      if (existingPay.exists) {
        console.log(`ℹ️ Payment ${paymentId} already processed. Skipping duplicate processing.`);
        return res.status(200).json({ status: 'ALREADY_PROCESSED' });
      }

      // 3. LIVE PRICE CHECK (Activates Pro for ₹99 or higher)
      if (amountInRupees >= 99) {
        const now = Date.now();
        const expiresAt = now + 30 * 24 * 60 * 60 * 1000; // 30 Days

        // A) Activate User Pro Pass in Firestore (users collection)
        await db.collection('users').doc(userId).set({
          userId: userId,
          uid: userId,
          deviceId: deviceId,
          email: userEmail,
          isPremiumActive: true,
          planType: 'PRO_MONTHLY',
          premiumStartedAt: now,
          premiumExpiresAt: expiresAt,
          paymentStatus: 'SUCCESS',
          lastPaymentId: paymentId,
          lastUpdated: now
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
          expiresAtTimestamp: expiresAt
        }, { merge: true });

        console.log(`🎉 30-Day PRO Pass Activated for User: ${userId}`);

        // C) IDEMPOTENCY CHECK: Prevent duplicate commission crediting
        const commDocId = `${paymentId}_COMM`;
        const commRef = db.collection('commissions').doc(commDocId);
        const commSnap = await commRef.get();

        if (!commSnap.exists) {
          const userDoc = await db.collection('users').doc(userId).get();
          if (userDoc.exists) {
            const userData = userDoc.data();
            const referrerUid = userData?.referredBy;
            const payingDeviceId = userData?.deviceId || deviceId;

            // ANTI-CHEAT 1: User cannot refer themselves
            if (referrerUid && typeof referrerUid === 'string' && referrerUid.trim() !== '' && referrerUid !== userId) {
              const referrerRef = db.collection('users').doc(referrerUid);
              const referrerSnap = await referrerRef.get();

              if (referrerSnap.exists) {
                const referrerData = referrerSnap.data();
                const referrerDeviceId = referrerData?.deviceId || '';

                // ANTI-CHEAT 2: User cannot refer another account on the SAME physical phone!
                if (!referrerDeviceId || referrerDeviceId !== payingDeviceId) {

                  // DYNAMIC TIERED COMMISSION:
                  // Normal User Referrer -> ₹15
                  // Partner Referrer (isPartner === true) -> ₹30
                  const isPartner = referrerData?.isPartner === true;
                  const commissionAmount = isPartner ? 30 : 15;
                  const commissionRateLabel = isPartner ? 'PARTNER_30' : 'NORMAL_15';

                  const updates = {
                    walletBalance: admin.firestore.FieldValue.increment(commissionAmount),
                    totalEarnings: admin.firestore.FieldValue.increment(commissionAmount),
                    pendingPayout: admin.firestore.FieldValue.increment(commissionAmount),
                    totalReferralsCount: admin.firestore.FieldValue.increment(1)
                  };

                  // If referrer is an Official Partner, ALSO increment totalProUsers count!
                  if (isPartner) {
                    updates.totalProUsers = admin.firestore.FieldValue.increment(1);
                  }

                  // Atomically increment Referrer Wallet & Partner Stats in Firestore
                  await referrerRef.update(updates);

                  // Log commission audit transaction record for auditing & idempotency
                  await commRef.set({
                    paymentId: paymentId,
                    referrerUid: referrerUid,
                    referredUserId: userId,
                    referredUserEmail: userEmail,
                    amountPaid: amountInRupees,
                    commissionRate: commissionRateLabel,
                    commissionAmount: commissionAmount,
                    isPartnerReferral: isPartner,
                    status: 'CREDITED',
                    timestamp: now
                  }, { merge: true });

                  console.log(`🎁 Referrer ${referrerUid} credited with ₹${commissionAmount} (${commissionRateLabel})`);
                } else {
                  console.log(`🛡️ Anti-Cheat Triggered: Blocked referral commission on SAME device (${payingDeviceId})`);
                }
              }
            } else {
              console.log(`ℹ️ User ${userId} was not referred by anyone. No commission needed.`);
            }
          }
        } else {
          console.log(`ℹ️ Commission for payment ${paymentId} already credited. Skipping duplicate.`);
        }
      } else {
        console.warn(`⚠️ Payment amount ₹${amountInRupees} is less than required ₹99. Pro activation skipped.`);
      }
    }

    return res.status(200).json({ status: 'SUCCESS' });
  } catch (error) {
    console.error('❌ Webhook Processing Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
