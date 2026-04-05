const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Haversine distance function
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

exports.onAccidentCreated = functions.firestore
  .document("accident_events/{eventId}")
  .onCreate(async (snap) => {
    const accident = snap.data();
    const users = await db.collection("active_users").get();

    const batch = db.batch();

    users.forEach((doc) => {
      const u = doc.data();
      const distance = getDistance(accident.lat, accident.lon, u.lat, u.lon);

      if (distance <= 5) {
        const alertRef = db
          .collection("user_alerts")
          .doc(doc.id)
          .collection("alerts")
          .doc();

        batch.set(alertRef, {
          lat: accident.lat,
          lon: accident.lon,
          type: accident.type,
          time: admin.firestore.FieldValue.serverTimestamp(),
          distance_km: distance
        });
      }
    });

    await batch.commit();
  });
