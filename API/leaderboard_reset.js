import admin from "firebase-admin";
import serviceAccount from "../../oggy-runner-firebase-adminsdk-fbsvc-95216f9496.json";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

export default async function handler(req, res) {
  const now = new Date();
  const bdTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Dhaka" }));
  const friday10PM = new Date(bdTime);
  friday10PM.setHours(22, 0, 0, 0);
  friday10PM.setDate(bdTime.getDate() - ((bdTime.getDay() + 2) % 7));

  const configRef = db.collection("config").doc("weekly_reset");
  const configSnap = await configRef.get();
  const lastReset = configSnap.exists ? configSnap.data().timestamp : 0;

  if (bdTime <= friday10PM || lastReset >= friday10PM.getTime()) {
    return res.status(200).json({ message: "Not time for reset yet" });
  }

  const usersSnap = await db.collection("users").orderBy("cockroach_coin", "desc").get();
  const rewardMap = [
    { min: 1, max: 1, usd: 0.5 },
    { min: 2, max: 15, usd: 0.05 },
    { min: 16, max: 2001, usd: 0.00005 }
  ];

  const getReward = (rank) => {
    for (const r of rewardMap) {
      if (rank >= r.min && rank <= r.max) return r.usd;
    }
    return 0;
  };

  let rank = 1;

  for (const docSnap of usersSnap.docs) {
    const data = docSnap.data();
    const uid = docSnap.id;
    const usd = getReward(rank);

    // Update user balance
    await db.collection("users").doc(uid).update({
      usd_balance: (data.usd_balance || 0) + usd,
      cockroach_coin: 0, // reset weekly
    });

    // Handle Oggy Coin conversion
    const total = data.total_cockroach_coin || 0;
    if (total >= 100000) {
      const extra = Math.floor(total / 100000);
      await db.collection("users").doc(uid).update({
        oggy_coin: (data.oggy_coin || 0) + extra,
        total_cockroach_coin: total % 100000,
      });

      // Referral % for Oggy Coin
      let parent = data.referred_by;
      const percent = [0.08, 0.04, 0.02, 0.01];
      for (let level = 0; level < percent.length && parent; level++) {
        const refDoc = await db.collection("users").doc(parent).get();
        if (refDoc.exists) {
          const refData = refDoc.data();
          await db.collection("users").doc(parent).update({
            oggy_coin: (refData.oggy_coin || 0) + (extra * percent[level]),
          });
          parent = refData.referred_by;
        } else break;
      }
    }

    // 7-day USD bonus
    const join = data.created_at || 0;
    const last = data.last_played || 0;
    const played7days = last - join > 6 * 24 * 60 * 60 * 1000;
    if (played7days && data.referred_by) {
      const refDoc = await db.collection("users").doc(data.referred_by).get();
      if (refDoc.exists) {
        const refData = refDoc.data();
        await db.collection("users").doc(data.referred_by).update({
          usd_balance: (refData.usd_balance || 0) + 0.2,
        });
      }
    }

    rank++;
  }

  await configRef.set({ timestamp: Date.now() });
  return res.status(200).json({ message: "Reset complete & rewards added" });
}
