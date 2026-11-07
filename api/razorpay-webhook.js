import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  try {
    const event = req.body.event;
    const payment = req.body.payload?.payment?.entity;

    if (!payment) return res.status(200).json({ received: true });

    if (event !== "payment.captured") {
      return res.status(200).json({ received: true, skipped: event });
    }

    if (payment.status !== "captured") {
      return res.status(200).json({ received: true, skipped: "not captured" });
    }

    if (payment.amount !== 9900) {
      console.log("Wrong amount, ignored:", payment.amount);
      return res.status(200).json({ received: true, skipped: "wrong amount" });
    }

    let userId = payment.notes?.userId || payment.notes?.uid || payment.notes?.firebaseUid || payment.notes?.user_id;

    let userRef;
    if (userId) {
      userRef = db.collection("users").doc(userId);
    } else if (payment.email) {
      const snap = await db.collection("users").where("email", "==", payment.email).limit(1).get();
      if (snap.empty) {
        return res.status(200).json({ received: true, error: "user not found" });
      }
      userRef = snap.docs[0].ref;
    } else {
      return res.status(200).json({ received: true, error: "no userId or email" });
    }

    const now = new Date();
    const expiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    await userRef.set({
      isPro: true,
      proExpiresAt: admin.firestore.Timestamp.fromDate(expiry),
      lastPaymentId: payment.id,
      lastPaymentAmount: payment.amount,
      lastPaymentAt: admin.firestore.Timestamp.fromDate(now),
      plan: "pro_30_days"
    }, { merge: true });

    return res.status(200).json({ received: true, pro: true });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
        }
