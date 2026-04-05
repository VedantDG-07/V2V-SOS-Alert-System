/******************************************************************
 V2V SOS – FINAL MASTER LOGIC
******************************************************************/

import {
  db,
  auth,
  collection,
  doc,
  setDoc,
  addDoc,
  onSnapshot,
  query,
  serverTimestamp,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInAnonymously,
  signOut,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  linkWithCredential
} from "./firebase-config.js";
import { orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";



/* ================= GLOBAL CONFIG ================= */

const RADIUS_KM = 2;
const SOS_COOLDOWN = 30000;

let currentUser = null;
let currentLocation = null;
let lastSOS = 0;
let isGuestMode = false;

let map = null;
let myMarker = null;
let emergencyMarker = null;
let hospitalMarkers = [];
let emergencyCircle = null;
let userRadiusCircle = null;

let acknowledgedEvents = new Set();
let seenEvents = new Set();
let listenerStartTime = Date.now();
let shownRoadMessages = new Set();
let activeAccidentMarkers = new Map();
let activeRoadMarkers = new Map();

/* CLEANUP TRACKING */
let unsubscribers = [];
let locationInterval = null;


/* ================= AUTH HANDLING ================= */

onAuthStateChanged(auth, async (user) => {
  const path = window.location.pathname;
  const isAuthPage = path.includes("login") || path.includes("register");
  
  if (!user) {
    // No user logged in
    if (!isAuthPage) {
      // Redirect to login if not already there
      window.location.href = "login.html";
    }
    return;
  }

  // User is logged in
  currentUser = user;
  
  // Redirect from login/register to dashboard if already logged in
  if (isAuthPage) {
    window.location.href = "index.html";
    return;
  }
  
  // Initialize app on dashboard/map/services/history/settings pages
  if (!path.includes("login") && !path.includes("register")) {
    initApp();
  }
});
const savedAcks = localStorage.getItem("acknowledgedEvents");
if (savedAcks) {
  acknowledgedEvents = new Set(JSON.parse(savedAcks));
}
/* ================= INIT ================= */

function initApp() {
  setVehicleId();
  detectPage();
  updateLocation();
  const waitForLocation = setInterval(() => {
    if (currentLocation) {
      clearInterval(waitForLocation);
      listenForAccidents();
      listenForRoadMessages();
    }
  }, 500);
  locationInterval = setInterval(updateLocation, 20000);
}



/* ================= FLASH ================= */

function showFlash(message, type = "success") {

  const flash = document.getElementById("flashMessage");
  if (!flash) return;

  flash.className = `flash-message flash-${type}`;
  flash.textContent = message;

  flash.classList.add("show");

  setTimeout(() => {
    flash.classList.remove("show");
  }, 3000);
}

/* ================= VEHICLE ID ================= */

function setVehicleId() {
  const el = document.getElementById("vehicleId");
  if (el && currentUser) {
    el.textContent = currentUser.uid.slice(0, 8);
  }
}

/* ================= PAGE DETECTION ================= */

function detectPage() {
  const path = window.location.pathname;

  if (path.includes("settings")) initSettings();
  if (path.includes("history")) loadHistory();
  if (path.includes("services")) {
    initMap();
    initServices();
  }
  if (document.getElementById("map")) initMap();
}

function isAuthPage() {
  const path = window.location.pathname;
  return path.includes("login") || path.includes("register");
}

/* ================= GPS ================= */

function isValidCoordinate(lat, lon) {
  return !isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function updateLocation() {
  if (!navigator.geolocation || !currentUser) return;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      
      if (!isValidCoordinate(lat, lon)) {
        console.warn("Invalid coordinates received");
        return;
      }

      currentLocation = { lat, lon };

      const myLocText = document.getElementById("myLocation");
      if (myLocText)
        myLocText.textContent = `${currentLocation.lat.toFixed(5)}, ${currentLocation.lon.toFixed(5)}`;

      await setDoc(doc(db, "active_users", currentUser.uid), {
        lat: currentLocation.lat,
        lon: currentLocation.lon,
        updatedAt: serverTimestamp()
      }).catch(err => console.error("Location update error:", err));

      updateMyMarker();
    },
    (error) => {
      console.warn("Geolocation error:", error.message);
    },
    { timeout: 10000, maximumAge: 0, enableHighAccuracy: false }
  );
}

/* ================= MAP ================= */

function initMap() {
  map = L.map("map").setView([19.0760, 72.8777], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19
  }).addTo(map);
  map.whenReady(() => {
    updateLocation();
  });
  addMyLocationButton();
}

function updateMyMarker() {

  if (!map || !currentLocation) return;

  if (!myMarker) {
    myMarker = L.marker([currentLocation.lat, currentLocation.lon])
      .addTo(map)
      .bindPopup("My Vehicle");
  } else {
    myMarker.setLatLng([currentLocation.lat, currentLocation.lon]);
  }

  // 🔵 USER RADIUS CIRCLE (always around user)
  if (!userRadiusCircle) {
    userRadiusCircle = L.circle(
      [currentLocation.lat, currentLocation.lon],
      {
        color: "#0060fb",
        fillColor: "#1865e0",
        fillOpacity: 0.1,
        weight: 2,
        radius: RADIUS_KM * 1000
      }
    ).addTo(map);
  } else {
    userRadiusCircle.setLatLng([
      currentLocation.lat,
      currentLocation.lon
    ]);
  }
}



/* ================= SOS ================= */

window.triggerSOS = async function () {

  if (!currentLocation || !isValidCoordinate(currentLocation.lat, currentLocation.lon)) return;

  const now = Date.now();
  if (now - lastSOS < SOS_COOLDOWN) {
    showFlash("Please wait before sending another SOS.", "warning");
    return;
  }

  lastSOS = now;

  await addDoc(collection(db, "accident_events"), {
    lat: currentLocation.lat,
    lon: currentLocation.lon,
    senderId: currentUser.uid,
    createdAt: serverTimestamp(),      
    clientTime: Date.now()           
  }).catch(err => {
    console.error("SOS send error:", err);
    showFlash("Failed to send SOS. Check connection.", "error");
  });

  showFlash("SOS Sent Successfully", "success");
};

function addMyLocationButton() {

  if (!map) return;

  const control = L.control({ position: "topright" });

  control.onAdd = function () {
    const btn = L.DomUtil.create("button", "locate-btn");
    btn.innerHTML = "📍My location";
    btn.style.background = "#00000084";
    btn.style.color = "white";
    btn.style.border = "none";
    btn.style.padding = "8px 12px";
    btn.style.borderRadius = "6px";
    btn.style.cursor = "pointer";
    btn.style.fontSize = "12px";
    btn.style.boxShadow = "0 8px 6px rgba(6, 6, 6, 0.3)";

    btn.onclick = function () {
      if (!currentLocation) return;
      map.setView([currentLocation.lat, currentLocation.lon], 16);
      if (myMarker) myMarker.openPopup();
    };

    return btn;
  };

  control.addTo(map);
}


/* ================= ACCIDENT LISTENER ================= */

function listenForAccidents() {

  const q = query(collection(db, "accident_events"));

  const unsubscribe = onSnapshot(q, (snapshot) => {

    const page = getCurrentPage();
    const now = Date.now();

    snapshot.forEach((docSnap) => {

      const data = docSnap.data();
      const eventId = docSnap.id;
      if (data.senderId === currentUser.uid) return;

      const created = data.createdAt?.toMillis?.();
      // if (!created || created < listenerStartTime) return; 
      const createdTime = data.clientTime || created;
      if (!createdTime) return;

      // 🔴 10 min expiry
      if (now - createdTime > 10 * 60 * 1000) {
        deleteDoc(doc(db, "accident_events", eventId));
        return;
      }

      if (!currentLocation) return;

      if (!isValidCoordinate(data.lat, data.lon)) return;

      const distance = calculateDistance(
        currentLocation.lat,
        currentLocation.lon,
        data.lat,
        data.lon
      );

      /* ================= PAGE LOGIC ================= */

      // 🔹 INCIDENT PAGE → only pinpoint
      if (page === "incident") {
        showEmergencyMarker(data.lat, data.lon, eventId);

        return;
      }

      // 🔹 MAP PAGE → always show (10min valid)
      if (page === "map") {
        showEmergencyMarker(data.lat, data.lon, eventId);

      }

      // 🔹 DASHBOARD → show marker always,
      // but ALERT only inside radius
      if (page === "dashboard") {
        showEmergencyMarker(data.lat, data.lon, eventId);

        if (distance <= RADIUS_KM) {
          if (!acknowledgedEvents.has(eventId)) {
            showEmergency(data, eventId);
            addToHistory(data, distance);
            saveAlertToHistory(data, distance, eventId);
          }

        }
      }
    });
  });
  
  unsubscribers.push(unsubscribe);
}



/* ================= EMERGENCY ================= */
function showEmergency(data, eventId) {

  if (data.senderId === currentUser.uid) return;
  if (acknowledgedEvents.has(eventId)) return;

  showPacket(data);
  showOverlay(data, eventId);
}

function showEmergencyMarker(lat, lon, eventId) {

  if (!map) {
    const waitForMap = setInterval(() => {
      if (map) {
        clearInterval(waitForMap);
        showEmergencyMarker(lat, lon, eventId);
      }
    }, 300);
    return;
  }

  // 🔒 Prevent duplicate marker
  if (activeAccidentMarkers.has(eventId)) return;

  const redIcon = L.icon({
    iconUrl: "https://maps.google.com/mapfiles/ms/icons/red-dot.png",
    iconSize: [32, 32],
    iconAnchor: [16, 32]
  });

  const marker = L.marker([lat, lon], { icon: redIcon })
    .addTo(map)
    .bindPopup(`
      🚨 <strong>Emergency Vehicle</strong><br/>
      Lat: ${lat.toFixed(5)}<br/>
      Lon: ${lon.toFixed(5)}
    `);

  activeAccidentMarkers.set(eventId, marker);

  // ⏳ Auto remove after 10 minutes
  setTimeout(() => {
    if (map && activeAccidentMarkers.has(eventId)) {
      map.removeLayer(marker);
      activeAccidentMarkers.delete(eventId);
    }
  }, 10 * 60 * 1000);
}

function showPacket(data) {
  const box = document.getElementById("packetBox");
  const packet = document.getElementById("packetData");

  if (!box || !packet) return;

  packet.textContent =
    `SOS|LAT:${data.lat.toFixed(5)}|LON:${data.lon.toFixed(5)}|TYPE:ACCIDENT`;

  box.classList.remove("hidden");
}

function showOverlay(data, eventId) {

  if (document.querySelector(".emergency-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "emergency-overlay";
  overlay.innerHTML = `
    🚨 EMERGENCY ALERT 🚨
    <div style="font-size:18px;margin-top:15px;">
      LAT: ${data.lat.toFixed(5)}<br/>
      LON: ${data.lon.toFixed(5)}
    </div>
    <button id="ackBtn">Acknowledge</button>
  `;

  document.body.appendChild(overlay);

  let closed = false;

  document.getElementById("ackBtn").onclick = () => {
    closed = true;
    acknowledgedEvents.add(eventId);
    localStorage.setItem(
      "acknowledgedEvents",
      JSON.stringify([...acknowledgedEvents])
    );
    overlay.remove();
    hidePacket();

  };

  setTimeout(() => {
    if (!closed && document.body.contains(overlay)) {
      overlay.remove();
      hidePacket();
      if (map && emergencyMarker) {
        map.removeLayer(emergencyMarker);
        emergencyMarker = null;
}
    }
  }, 20000);
}

function hidePacket() {
  const box = document.getElementById("packetBox");
  if (box) box.classList.add("hidden");
}


function removeEmergencyMarker(eventId) {
  if (activeAccidentMarkers.has(eventId)) {
    const marker = activeAccidentMarkers.get(eventId);
    map.removeLayer(marker);
    activeAccidentMarkers.delete(eventId);
  }
}


/* ================= HISTORY ================= */

function addToHistory(data, distance) {
  const list = document.getElementById("historyList");
  if (!list) return;

  const time = data.createdAt?.toDate?.();
  const timeStr = time
    ? time.toLocaleString()
    : "Time unknown";

  const li = document.createElement("li");
  li.innerHTML = `
    <strong>🚨 ACCIDENT</strong><br/>
    Location: ${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}<br/>
    Distance: ${distance.toFixed(2)} km<br/>
    Time: ${timeStr}
  `;
  list.prepend(li);
}



function loadHistory() {
  const list = document.getElementById("historyList");
  if (!list) return;

  const q = query(
    collection(db, "alert_history"),
    orderBy("createdAt", "desc")
  );

  const unsubscribe = onSnapshot(q, (snapshot) => {
    list.innerHTML = "";

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      if (data.receiverId !== currentUser.uid) return;

      const time = data.clientTime
        ? new Date(data.clientTime)
        : data.createdAt?.toDate?.();

      const timeStr = time
        ? time.toLocaleString()
        : "Time unknown";

      const li = document.createElement("li");
      li.innerHTML = `
        <strong>🚨 ACCIDENT</strong><br/>
        Location: ${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}<br/>
        Distance: ${data.distance.toFixed(2)} km<br/>
        Time: ${timeStr}
      `;
      const now = Date.now();
      const created = data.createdAt?.toMillis?.();

      if (created && now - created > 24 * 60 * 60 * 1000) {
        deleteDoc(doc(db, "alert_history", docSnap.id));
        return;
      }
      list.appendChild(li);
    });
  });
  
  unsubscribers.push(unsubscribe);
}



function initServices() {

  const hospitalList = document.getElementById("hospitalList");
  if (hospitalList) {
    hospitalList.innerHTML = `
      <li>City Hospital – 2.1 km</li>
      <li>Metro Trauma Center – 3.4 km</li>
    `;
  }

  if (!map) return;

  const q = query(collection(db, "accident_events"));

  const unsubscribe = onSnapshot(q, (snapshot) => {
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const eventId = docSnap.id;

      if (!isValidCoordinate(data.lat, data.lon)) return;

      const redIcon = L.icon({
        iconUrl: "https://maps.google.com/mapfiles/ms/icons/red-dot.png",
        iconSize: [32, 32],
        iconAnchor: [16, 32]
      });

      L.marker([data.lat, data.lon], { icon: redIcon })
        .addTo(map)
        .bindPopup("🚨 Accident Location")
        .openPopup();
    });
  });
  
  unsubscribers.push(unsubscribe);
}


function initSettings() {
  const accountTypeEl = document.getElementById("accountType");
  const setupSection = document.getElementById("setupAccountSection");
  const contactSection = document.getElementById("contactSection");
  const lockMsg = document.getElementById("contactLockMsg");

  if (!currentUser.isAnonymous) {
    accountTypeEl.textContent = "Registered";
    setupSection.style.display = "none";
    contactSection.classList.remove("hidden");
    lockMsg.style.display = "none";
  }

  document.getElementById("completeSetupBtn")?.addEventListener("click", async () => {
    const email = document.getElementById("setupEmail").value;
    const password = document.getElementById("setupPassword").value;
    
    if (!email || !password) {
      showFlash("Please enter email and password", "warning");
      return;
    }
    
    const credential = EmailAuthProvider.credential(email, password);
    await linkWithCredential(currentUser, credential).catch(err => {
      console.error("Account link error:", err);
      showFlash("Failed to upgrade account. " + err.message, "error");
    });
    showFlash("Account upgraded successfully", "success");
    location.reload();
  });

  document.getElementById("logoutBtn")?.addEventListener("click", async () => {
    cleanupListeners();
    isGuestMode = false;
    localStorage.removeItem("isGuest");
    await signOut(auth);
    showFlash("Logged out successfully", "success");
    window.location.href = "login.html";
  });
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return 6371 * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/* ================= SAVE HISTORY (NEW) ================= */

async function saveAlertToHistory(data, distance, eventId) {
  try {
    await setDoc(doc(db, "alert_history", eventId + "_" + currentUser.uid), {
      lat: data.lat,
      lon: data.lon,
      distance: distance,
      senderId: data.senderId,
      receiverId: currentUser.uid,
      createdAt: data.createdAt || serverTimestamp(),
      clientTime: Date.now()
    });
  } catch (e) {
    console.error("History save error:", e);
  }
}

window.sendRoadMessageUI = async function () {

  if (!currentLocation || !isValidCoordinate(currentLocation.lat, currentLocation.lon)) return;

  const input = document.getElementById("roadText");
  if (!input) return;

  const message = input.value.trim();
  if (!message) {
    showFlash("Please enter road message", "warning");
    return;
  }

  await addDoc(collection(db, "road_messages"), {
    lat: currentLocation.lat,
    lon: currentLocation.lon,
    text: message,
    senderId: currentUser.uid,
    createdAt: serverTimestamp(),
    clientTime: Date.now()
  }).catch(err => {
    console.error("Road message error:", err);
    showFlash("Failed to send message. Check connection.", "error");
  });

  // close modal after send
  closeRoadModal();

  showFlash("Road message sent", "success");
};


function listenForRoadMessages() {

  const q = query(collection(db, "road_messages"));

  const unsubscribe = onSnapshot(q, (snapshot) => {

    const page = getCurrentPage();
    const now = Date.now();

    snapshot.forEach((docSnap) => {

      const data = docSnap.data();
      const id = docSnap.id;

      if (data.senderId === currentUser.uid) return;

      const created = data.createdAt?.toMillis?.();
      const createdTime = data.clientTime || created;
      if (!createdTime) return;

      // 🟡 12 hour expiry
      if (now - createdTime > 12 * 60 * 60 * 1000) return;

      /* ================= PAGE LOGIC ================= */

      // 🔹 INCIDENT PAGE → no road info
      if (page === "incident") return;

      if (page === "dashboard") {
        if (!currentLocation) return;

        const distance = calculateDistance(
          currentLocation.lat,
          currentLocation.lon,
          data.lat,
          data.lon
        );

        if (distance <= RADIUS_KM) {
          showRoadMarker(data, id);
        }
        return;
      }

      // 🔹 MAP PAGE → always show
      if (page === "map") {
        showRoadMarker(data, id);
        addRoadInfoToList(data, id);
        return;
      }

    });
  });
  
  unsubscribers.push(unsubscribe);
}



function showRoadMarker(data, id) {

  if (!map) return;

  if (activeRoadMarkers.has(id)) return;

  const yellowIcon = L.icon({
    iconUrl: "https://maps.google.com/mapfiles/ms/icons/yellow-dot.png",
    iconSize: [32, 32],
    iconAnchor: [16, 32]
  });

  const marker = L.marker([data.lat, data.lon], { icon: yellowIcon })
    .addTo(map)
    .bindPopup(`⚠ Road Info:<br>${data.text}`);

  activeRoadMarkers.set(id, marker);

  // ⏳ Remove after 12 hours
  setTimeout(() => {
    if (map && activeRoadMarkers.has(id)) {
      map.removeLayer(marker);
      activeRoadMarkers.delete(id);
    }
  }, 12 * 60 * 60 * 1000);

  const listItem = document.getElementById("road-item-" + id);
  if (listItem) listItem.remove();

}

window.openRoadModal = function () {
  document.getElementById("roadModal")?.classList.remove("hidden");
};

function addRoadInfoToList(data, id) {

  const list = document.getElementById("roadInfoList");
  if (!list) return;

  // prevent duplicate entry
  if (document.getElementById("road-item-" + id)) return;

  const created = data.clientTime
    ? new Date(data.clientTime)
    : data.createdAt?.toDate?.();

  const timeStr = created
    ? created.toLocaleString()
    : "Time unknown";

  const li = document.createElement("li");
  li.id = "road-item-" + id;
  li.style.cursor = "pointer";
  li.style.padding = "10px";
  li.style.borderBottom = "1px solid #eee";
  const distance = calculateDistance(
                    currentLocation.lat,
                    currentLocation.lon,
                    data.lat,
                    data.lon
                  );
  li.innerHTML = `
    <strong>⚠ ${data.text}</strong><br/>
    ${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}<br/>
    ${timeStr}
    ${distance}
  `;

  li.onclick = () => {
    if (map) {
      map.setView([data.lat, data.lon], 17);
    }

    if (activeRoadMarkers.has(id)) {
      activeRoadMarkers.get(id).openPopup();
    }
  };

  list.prepend(li);
}


window.closeRoadModal = function () {
  const modal = document.getElementById("roadModal");
  if (!modal) return;
  modal.classList.add("hidden");
  document.getElementById("roadText").value = "";
};

function getCurrentPage() {
  const path = window.location.pathname;

  if (path.includes("map")) return "map";
  if (path.includes("incident")) return "incident";
  return "dashboard";
}

/* ================= CLEANUP ================= */
function cleanupListeners() {
  unsubscribers.forEach(unsub => unsub());
  unsubscribers = [];
  if (locationInterval) {
    clearInterval(locationInterval);
    locationInterval = null;
  }
}
function initLogin() {
  const loginBtn = document.getElementById("loginBtn");
  if (!loginBtn) return;
  loginBtn.addEventListener("click", async () => {
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    if (!email || !password) {
      showFlash("Please enter email and password", "warning");
      return;
    }
    try {
      await signInWithEmailAndPassword(auth, email, password);
      showFlash("Login successful", "success");
      // Redirect happens automatically via onAuthStateChanged
    } catch (err) {
      showFlash("Login failed: " + err.message, "error");
    }
  });
}

window.logoutUser = async function () {
  try {
    cleanupListeners(); // stop Firestore listeners
    acknowledgedEvents.clear();
    localStorage.removeItem("acknowledgedEvents");
    localStorage.removeItem("isGuest");
    await deleteDoc(doc(db, "active_users", currentUser.uid));
    await signOut(auth);

    showFlash("Logged out successfully", "success");

    setTimeout(() => {
      window.location.href = "login.html";
    }, 1000);

  } catch (err) {
    console.error("Logout error:", err);
    showFlash("Logout failed: " + err.message, "error");
  }
};

function initRegister() {
  const registerBtn = document.getElementById("registerBtn");
  if (!registerBtn) return;
  registerBtn.addEventListener("click", async () => {
    const email = document.getElementById("regEmail").value.trim();
    const password = document.getElementById("regPassword").value;
    if (!email || !password) {
      showFlash("Please enter email and password", "warning");
      return;
    }
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      showFlash("Account created successfully", "success");
      // Redirect happens automatically via onAuthStateChanged
    } catch (err) {
      showFlash("Registration failed: " + err.message, "error");
    }
  });
}


/* ================= CLEANUP ON PAGE UNLOAD ================= */
window.addEventListener('beforeunload', async () => {
  if (isGuestMode && currentUser) {
    // Delete guest user data from Firestore
    try {
      deleteDoc(doc(db, "active_users", currentUser.uid));
      deleteDoc(doc(db, "alert_history", currentUser.uid));
    } catch (e) {
      console.log("Guest cleanup error:", e);
    }
  }
});
function initGuest() {
  const guestBtn = document.getElementById("guestBtn");
  if (!guestBtn) return;
  guestBtn.addEventListener("click", async () => {
    try {
      await signInAnonymously(auth);
      isGuestMode = true;
      localStorage.setItem("isGuest", "true");
      showFlash("Entered as Guest", "success");
      // Redirect happens automatically via onAuthStateChanged
    } catch (err) {
      showFlash("Guest mode error: " + err.message, "error");
    }
  });
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAuthPages);
} else {
  initAuthPages();
}

function initAuthPages() {
  if (isAuthPage()) {
    const path = window.location.pathname;
    if (path.includes('login')) {
      initLogin();
      initGuest();
    }
    if (path.includes('register')) initRegister();
  }
}

// Restore guest mode flag if returning from refresh
if (localStorage.getItem("isGuest") === "true") {
  isGuestMode = true;
}

document.addEventListener("DOMContentLoaded", () => {

  const hamburger = document.getElementById("hamburger");
  const navMenu = document.getElementById("navMenu");

  if(hamburger && navMenu){

    hamburger.addEventListener("click", () => {
      navMenu.classList.toggle("active");
    });

    // Close sidebar when clicking a link
    navMenu.querySelectorAll("a").forEach(link => {
      link.addEventListener("click", () => {
        navMenu.classList.remove("active");
      });
    });

  }

});