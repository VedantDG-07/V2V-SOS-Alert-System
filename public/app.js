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
  getDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInAnonymously,
  signOut,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  linkWithCredential
} from "./firebase-config.js";
import { deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";



/* ================= GLOBAL CONFIG ================= */

const RADIUS_KM = 2;
const SOS_COOLDOWN = 30000;
const LOCATION_CACHE_TTL_MS = 120000;
const LOCATION_UPDATE_INTERVAL_MS = 10000;
const GEOLOCATION_OPTIONS = { timeout: 6000, maximumAge: 15000, enableHighAccuracy: false };

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
let hasStartedRealtimeListeners = false;

/* CLEANUP TRACKING */
let unsubscribers = [];
let locationInterval = null;
let locationWatchId = null;


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
  hydrateLocationFromCache();
  updateLocation();
  ensureRealtimeListenersStarted();

  const waitForLocation = setInterval(() => {
    if (currentLocation) {
      clearInterval(waitForLocation);
      ensureRealtimeListenersStarted();
    }
  }, 500);
  locationInterval = setInterval(updateLocation, LOCATION_UPDATE_INTERVAL_MS);
  startLocationWatch();
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

function hydrateLocationFromCache() {
  try {
    const cached = localStorage.getItem("lastKnownLocation");
    if (!cached) return;
    const parsed = JSON.parse(cached);
    if (!parsed || !isValidCoordinate(parsed.lat, parsed.lon)) return;
    if (Date.now() - parsed.ts > LOCATION_CACHE_TTL_MS) return;
    currentLocation = { lat: parsed.lat, lon: parsed.lon };
    updateLocationUI();
    updateMyMarker();
  } catch (e) {
    console.warn("Location cache parse error:", e);
  }
}

function updateLocationUI() {
  const myLocText = document.getElementById("myLocation");
  if (myLocText && currentLocation) {
    myLocText.textContent = `${currentLocation.lat.toFixed(5)}, ${currentLocation.lon.toFixed(5)}`;
  }
}

function applyLocation(lat, lon) {
  if (!isValidCoordinate(lat, lon)) return;
  currentLocation = { lat, lon };
  updateLocationUI();
  localStorage.setItem("lastKnownLocation", JSON.stringify({
    lat,
    lon,
    ts: Date.now()
  }));
  updateMyMarker();
}

async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { "Accept-Language": "en" } }
    );
    const data = await res.json();
    const a = data.address || {};
    // Build a short human name: suburb/neighbourhood + city/town
    const area = a.suburb || a.neighbourhood || a.village || a.hamlet || a.county || "";
    const city = a.city || a.town || a.state_district || a.state || "";
    if (area && city) return `${area}, ${city}`;
    if (city) return city;
    if (area) return area;
    return data.display_name?.split(",").slice(0, 2).join(", ") || null;
  } catch (e) {
    return null;
  }
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
      if (myLocText) {
        // Show coordinates immediately, then update with area name
        myLocText.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        reverseGeocode(lat, lon).then(name => {
          if (name && myLocText) myLocText.textContent = name;
        });
      }

      await setDoc(doc(db, "active_users", currentUser.uid), {
        lat: currentLocation.lat,
        lon: currentLocation.lon,
        updatedAt: serverTimestamp()
      }).catch(err => console.error("Location update error:", err));
    },
    (error) => {
      console.warn("Geolocation error:", error.message);
    },
    GEOLOCATION_OPTIONS
  );
}

function startLocationWatch() {
  if (!navigator.geolocation || locationWatchId !== null) return;
  locationWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      applyLocation(latitude, longitude);
    },
    (error) => {
      console.warn("Geolocation watch error:", error.message);
    },
    GEOLOCATION_OPTIONS
  );
}

function ensureRealtimeListenersStarted() {
  if (hasStartedRealtimeListeners || !currentLocation) return;
  listenForAccidents();
  listenForRoadMessages();
  hasStartedRealtimeListeners = true;
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

let sosCancelTimeout = null;
let sosCountdownInterval = null;

window.triggerSOS = async function () {

  if (!currentLocation || !isValidCoordinate(currentLocation.lat, currentLocation.lon)) {
    showFlash("Location not available. Please wait.", "warning");
    return;
  }

  const now = Date.now();
  if (now - lastSOS < SOS_COOLDOWN) {
    showFlash("Please wait before sending another SOS.", "warning");
    return;
  }

  // If a countdown is already running, cancel it
  if (sosCancelTimeout) {
    clearTimeout(sosCancelTimeout);
    clearInterval(sosCountdownInterval);
    sosCancelTimeout = null;
    sosCountdownInterval = null;
    const existing = document.getElementById("sosPanicModal");
    if (existing) existing.remove();
    const btn = document.querySelector(".sos-btn");
    if (btn) { btn.textContent = "SOS"; btn.innerHTML = 'SOS<div class="pulse"></div>'; }
    showFlash("SOS Cancelled", "warning");
    return;
  }

  // Show countdown modal
  let countdown = 10;

  const modal = document.createElement("div");
  modal.id = "sosPanicModal";
  modal.className = "sos-countdown-modal";
  modal.innerHTML = `
    <div class="sos-countdown-card">
      <div class="sos-countdown-icon">🆘</div>
      <h2 class="sos-countdown-title">SOS Sending in…</h2>
      <div class="sos-countdown-ring">
        <svg viewBox="0 0 100 100" class="sos-ring-svg">
          <circle cx="50" cy="50" r="44" class="sos-ring-track"/>
          <circle cx="50" cy="50" r="44" class="sos-ring-fill" id="sosRingFill"/>
        </svg>
        <span class="sos-countdown-number" id="sosCountdownNum">10</span>
      </div>
      <p class="sos-countdown-hint">Tap the button below to cancel</p>
      <button class="sos-cancel-btn" id="sosCancelBtn">✕ Cancel SOS</button>
    </div>
  `;
  document.body.appendChild(modal);

  // Vibrate to signal countdown started
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

  const numEl = document.getElementById("sosCountdownNum");
  const ringEl = document.getElementById("sosRingFill");
  const circumference = 2 * Math.PI * 44; // ≈ 276.46
  if (ringEl) {
    ringEl.style.strokeDasharray = circumference;
    ringEl.style.strokeDashoffset = 0;
  }

  sosCountdownInterval = setInterval(() => {
    countdown--;
    if (numEl) numEl.textContent = countdown;
    if (ringEl) {
      const progress = (10 - countdown) / 10;
      ringEl.style.strokeDashoffset = circumference * progress;
    }
    if (navigator.vibrate) navigator.vibrate(50);
  }, 1000);

  document.getElementById("sosCancelBtn").onclick = () => {
    clearTimeout(sosCancelTimeout);
    clearInterval(sosCountdownInterval);
    sosCancelTimeout = null;
    sosCountdownInterval = null;
    modal.classList.add("sos-modal-fade-out");
    setTimeout(() => modal.remove(), 300);
    showFlash("SOS Cancelled", "warning");
  };

  sosCancelTimeout = setTimeout(async () => {
    clearInterval(sosCountdownInterval);
    sosCancelTimeout = null;
    sosCountdownInterval = null;
    modal.classList.add("sos-modal-fade-out");
    setTimeout(() => modal.remove(), 300);

    // Fire the actual SOS
    lastSOS = Date.now();
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);

    let eventRef;
    try {
      eventRef = await addDoc(collection(db, "accident_events"), {
        lat: currentLocation.lat,
        lon: currentLocation.lon,
        senderId: currentUser.uid,
        createdAt: serverTimestamp(),
        clientTime: Date.now()
      });
    } catch(err) {
      console.error("SOS send error:", err);
      showFlash("Failed to send SOS. Check connection.", "error");
      return;
    }

    showFlash("🚨 SOS Sent Successfully", "success");

    // Send SMS to emergency contacts + log ER notification
    sendSOSNotifications(currentLocation.lat, currentLocation.lon, eventRef.id).catch(console.error);
  }, 10000);
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

function playEmergencySound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const beepPattern = [0, 150, 300, 450, 600];
    beepPattern.forEach(offset => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "square";
      osc.frequency.value = 880;
      gain.gain.value = 0.35;
      const start = ctx.currentTime + offset / 1000;
      osc.start(start);
      osc.stop(start + 0.12);
    });
  } catch (e) {
    // Audio not available
  }
}

function triggerVibration() {
  if (navigator.vibrate) {
    navigator.vibrate([300, 150, 300, 150, 600]);
  }
}

function showOverlay(data, eventId) {

  if (document.querySelector(".emergency-overlay-backdrop")) return;

  // Play sound + vibration for urgency
  playEmergencySound();
  triggerVibration();

  // Reverse-geocode the accident location
  let locationLabel = `${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}`;
  reverseGeocode(data.lat, data.lon).then(name => {
    const locEl = document.getElementById("emergencyLocationLabel");
    if (locEl && name) locEl.textContent = name;
  });

  const backdrop = document.createElement("div");
  backdrop.className = "emergency-overlay-backdrop";

  backdrop.innerHTML = `
    <div class="emergency-modal" role="alertdialog" aria-modal="true" aria-labelledby="emTitle">
      <div class="emergency-modal-icon">🚨</div>
      <h1 id="emTitle" class="emergency-modal-title">EMERGENCY ALERT</h1>
      <p class="emergency-modal-subtitle">A vehicle nearby has triggered an SOS signal</p>

      <div class="emergency-modal-info">
        <div class="emergency-info-row">
          <span class="emergency-info-label">📍 Location</span>
          <span class="emergency-info-value" id="emergencyLocationLabel">${locationLabel}</span>
        </div>
        <div class="emergency-info-row">
          <span class="emergency-info-label">📏 Distance</span>
          <span class="emergency-info-value" id="emergencyDistanceLabel">Calculating…</span>
        </div>
        <div class="emergency-info-row">
          <span class="emergency-info-label">⏱ Time</span>
          <span class="emergency-info-value">${new Date().toLocaleTimeString()}</span>
        </div>
      </div>

      <div class="emergency-modal-actions">
        <button id="ackBtn" class="emergency-ack-btn">✔ Acknowledge</button>
        <button id="viewMapBtn" class="emergency-map-btn">🗺 View on Map</button>
      </div>

      <p class="emergency-auto-close">Auto-dismisses in <span id="autoCloseTimer">20</span>s</p>
    </div>
  `;

  document.body.appendChild(backdrop);

  // Fill distance label
  if (currentLocation) {
    const dist = calculateDistance(currentLocation.lat, currentLocation.lon, data.lat, data.lon);
    const distEl = document.getElementById("emergencyDistanceLabel");
    if (distEl) distEl.textContent = `${dist.toFixed(2)} km away`;
  }

  // Countdown
  let secondsLeft = 20;
  const timerEl = document.getElementById("autoCloseTimer");
  const countdownInterval = setInterval(() => {
    secondsLeft--;
    if (timerEl) timerEl.textContent = secondsLeft;
  }, 1000);

  let closed = false;

  function closeOverlay() {
    if (closed) return;
    closed = true;
    clearInterval(countdownInterval);
    backdrop.classList.add("emergency-overlay-fade-out");
    setTimeout(() => backdrop.remove(), 300);
    hidePacket();
  }

  document.getElementById("ackBtn").onclick = () => {
    acknowledgedEvents.add(eventId);
    localStorage.setItem("acknowledgedEvents", JSON.stringify([...acknowledgedEvents]));
    closeOverlay();
  };

  document.getElementById("viewMapBtn").onclick = () => {
    acknowledgedEvents.add(eventId);
    localStorage.setItem("acknowledgedEvents", JSON.stringify([...acknowledgedEvents]));
    closeOverlay();
    if (map) {
      map.setView([data.lat, data.lon], 16);
    } else {
      window.location.href = `map.html`;
    }
  };

  setTimeout(() => {
    if (!closed) {
      if (map && emergencyMarker) {
        map.removeLayer(emergencyMarker);
        emergencyMarker = null;
      }
      closeOverlay();
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

function timeAgo(date) {
  if (!date) return "Unknown time";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

function createHistoryCard(data, distance, time) {
  const card = document.createElement("div");
  card.className = "history-card";

  const timeAgoStr = time ? timeAgo(time) : "Unknown time";
  const timeFullStr = time ? time.toLocaleString() : "Time unknown";
  const distBadgeClass = distance < 0.5 ? "dist-badge dist-close"
                       : distance < 1.5 ? "dist-badge dist-mid"
                       : "dist-badge dist-far";

  card.innerHTML = `
    <div class="history-card-header">
      <div class="history-card-title">🚨 Accident Alert</div>
      <span class="${distBadgeClass}">${distance.toFixed(2)} km</span>
    </div>
    <div class="history-card-body">
      <div class="history-card-row">
        <span class="history-card-label">📍 Location</span>
        <span class="history-card-value history-loc-label">${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}</span>
      </div>
      <div class="history-card-row">
        <span class="history-card-label">⏱ Time</span>
        <span class="history-card-value" title="${timeFullStr}">${timeAgoStr}</span>
      </div>
    </div>
    <div class="history-card-footer">
      <button class="history-map-btn" data-lat="${data.lat}" data-lon="${data.lon}">🗺 View on Map</button>
    </div>
  `;

  // Reverse-geocode for nicer location label
  const locEl = card.querySelector(".history-loc-label");
  if (locEl) {
    reverseGeocode(data.lat, data.lon).then(name => {
      if (name && locEl) locEl.textContent = name;
    });
  }

  card.querySelector(".history-map-btn").addEventListener("click", () => {
    window.location.href = `map.html#${data.lat},${data.lon}`;
  });

  return card;
}

function addToHistory(data, distance) {
  const list = document.getElementById("historyList");
  if (!list) return;

  const time = data.createdAt?.toDate?.() || (data.clientTime ? new Date(data.clientTime) : null);
  const card = createHistoryCard(data, distance, time);
  list.prepend(card);
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

    if (snapshot.empty) {
      list.innerHTML = `<p style="color:#94a3b8;font-size:14px;margin-top:16px;">No alerts recorded yet.</p>`;
      return;
    }

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      if (data.receiverId !== currentUser.uid) return;

      const now = Date.now();
      const created = data.createdAt?.toMillis?.();
      if (created && now - created > 24 * 60 * 60 * 1000) {
        deleteDoc(doc(db, "alert_history", docSnap.id));
        return;
      }

      const time = data.clientTime
        ? new Date(data.clientTime)
        : data.createdAt?.toDate?.();

      const card = createHistoryCard(data, data.distance, time);
      list.appendChild(card);
    });

    if (list.innerHTML === "") {
      list.innerHTML = `<p style="color:#94a3b8;font-size:14px;margin-top:16px;">No alerts recorded yet.</p>`;
    }
  });
  
  unsubscribers.push(unsubscribe);
}



async function initServices() {
  // Wait for location
  let waited = 0;
  while (!currentLocation && waited < 8000) {
    await new Promise(r => setTimeout(r, 300));
    waited += 300;
  }

  /* ── Nearby Hospitals via Overpass API ── */
  const hospitalList    = document.getElementById("hospitalList");
  const hospitalLoading = document.getElementById("hospitalLoading");
  const hospitalSubtitle = document.getElementById("hospitalSubtitle");

  const renderHospitals = (elements, lat, lon) => {
    const withDist = elements.map(el => ({
      ...el, dist: calculateDistance(lat, lon, el.lat, el.lon)
    })).sort((a, b) => a.dist - b.dist).slice(0, 6);

    if (hospitalLoading) hospitalLoading.style.display = "none";
    if (hospitalList) hospitalList.style.display = "flex";

    if (withDist.length === 0) {
      if (hospitalList) hospitalList.innerHTML = `<li style="color:#64748b;font-size:13px;">No hospitals found within 5 km</li>`;
      if (hospitalSubtitle) hospitalSubtitle.textContent = "None found nearby";
      return;
    }

    if (hospitalSubtitle) hospitalSubtitle.textContent = `${withDist.length} found within 5 km`;
    if (hospitalList) hospitalList.innerHTML = "";

    withDist.forEach(h => {
      const name = h.tags?.name || h.tags?.["name:en"] || "Hospital";
      const phone = h.tags?.phone || h.tags?.["contact:phone"] || null;
      const distStr = h.dist < 1 ? `${Math.round(h.dist * 1000)} m` : `${h.dist.toFixed(1)} km`;
      const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lon}`;
      const li = document.createElement("li");
      li.className = "hospital-item";
      li.innerHTML = `
        <div class="hospital-info">
          <div class="hospital-name" title="${name}">${name}</div>
          <div class="hospital-dist">📍 ${distStr} away</div>
        </div>
        <div class="hospital-actions">
          ${phone ? `<a href="tel:${phone}" class="hospital-call-btn">📞 Call</a>` : ""}
          <a href="${mapsUrl}" target="_blank" class="hospital-nav-btn">🗺 Go</a>
        </div>
      `;
      if (hospitalList) hospitalList.appendChild(li);
      if (map && isValidCoordinate(h.lat, h.lon)) {
        const icon = L.divIcon({ html: "🏥", className: "", iconSize: [28,28], iconAnchor: [14,14] });
        L.marker([h.lat, h.lon], { icon }).addTo(map).bindPopup(`<strong>${name}</strong><br>${distStr} away`);
      }
    });
  };

  if (currentLocation && hospitalList) {
    const { lat, lon } = currentLocation;
    const CACHE_KEY = "hospitalCache";
    const CACHE_TTL = 60 * 60 * 1000; // 1 hour

    // Try cache first — show instantly
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        // Check cache is for roughly same location (within ~1km)
        const locDiff = calculateDistance(lat, lon, cached.lat, cached.lon);
        if (locDiff < 1) {
          if (hospitalSubtitle) hospitalSubtitle.textContent = "Loaded from cache";
          renderHospitals(cached.elements, lat, lon);
          return; // skip fetch entirely
        }
      }
    } catch(e) {}

    // Fetch fresh
    try {
      const radius = 5000;
      const query_str = `[out:json][timeout:15];(node["amenity"="hospital"](around:${radius},${lat},${lon});node["amenity"="clinic"](around:${radius},${lat},${lon}););out body;`;
      const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query_str)}`);
      const data = await res.json();
      const elements = data.elements || [];

      // Save to cache
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), lat, lon, elements })); } catch(e) {}

      renderHospitals(elements, lat, lon);
    } catch(e) {
      if (hospitalLoading) hospitalLoading.style.display = "none";
      if (hospitalList) { hospitalList.style.display = "flex"; hospitalList.innerHTML = `<li style="color:#64748b;font-size:13px;">Could not load hospitals. Check connection.</li>`; }
    }
  } else {
    if (hospitalLoading) hospitalLoading.style.display = "none";
    if (hospitalList) { hospitalList.style.display = "flex"; hospitalList.innerHTML = `<li style="color:#64748b;font-size:13px;">Location unavailable — enable GPS</li>`; }
  }

  if (!map) return;

  /* ── Live SOS events ── */
  const sosList = document.getElementById("activeSosList");
  const sosQ = query(collection(db, "accident_events"));
  const unsubSos = onSnapshot(sosQ, (snapshot) => {
    const now = Date.now();
    const items = [];

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const eventId = docSnap.id;
      if (!isValidCoordinate(data.lat, data.lon)) return;

      const createdTime = data.clientTime || data.createdAt?.toMillis?.();
      if (!createdTime || now - createdTime > 10 * 60 * 1000) return; // 10min expiry

      const dist = currentLocation
        ? calculateDistance(currentLocation.lat, currentLocation.lon, data.lat, data.lon)
        : null;

      if (dist !== null && dist > 5) return; // only within 5km

      items.push({ data, eventId, dist, createdTime });

      // Map marker
      if (!activeAccidentMarkers.has(eventId)) {
        const redIcon = L.icon({ iconUrl: "https://maps.google.com/mapfiles/ms/icons/red-dot.png", iconSize:[32,32], iconAnchor:[16,32] });
        const marker = L.marker([data.lat, data.lon], { icon: redIcon })
          .addTo(map)
          .bindPopup("🚨 Active SOS");
        activeAccidentMarkers.set(eventId, marker);
      }
    });

    if (sosList) {
      if (items.length === 0) {
        sosList.innerHTML = `<li class="sos-empty">No active SOS events nearby</li>`;
      } else {
        sosList.innerHTML = "";
        items.sort((a, b) => b.createdTime - a.createdTime).forEach(({ data, eventId, dist, createdTime }) => {
          const distStr = dist !== null ? `${dist.toFixed(1)} km away` : "";
          const timeAgoStr = timeAgo(new Date(createdTime));
          const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${data.lat},${data.lon}`;
          const li = document.createElement("li");
          li.className = "active-sos-item";
          li.innerHTML = `
            <div class="active-sos-info">
              <div class="active-sos-loc">🚨 SOS Alert ${distStr ? "· " + distStr : ""}</div>
              <div class="active-sos-time">${timeAgoStr}</div>
            </div>
            <a href="${mapsUrl}" target="_blank" class="active-sos-nav">🗺 Go</a>
          `;
          sosList.appendChild(li);
        });
      }
    }
  });
  unsubscribers.push(unsubSos);

  /* ── Road messages ── */
  const roadList = document.getElementById("roadMsgList");
  const roadQ = query(collection(db, "road_messages"));
  const unsubRoad = onSnapshot(roadQ, (snapshot) => {
    const now = Date.now();
    const msgs = [];
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const createdTime = data.clientTime || data.createdAt?.toMillis?.();
      if (!createdTime || now - createdTime > 12 * 60 * 60 * 1000) return;
      if (!isValidCoordinate(data.lat, data.lon)) return;
      const dist = currentLocation
        ? calculateDistance(currentLocation.lat, currentLocation.lon, data.lat, data.lon)
        : null;
      if (dist !== null && dist > 5) return;
      msgs.push({ data, dist, createdTime, id: docSnap.id });
    });

    if (roadList) {
      if (msgs.length === 0) {
        roadList.innerHTML = `<li class="road-msg-empty">No road alerts nearby</li>`;
      } else {
        roadList.innerHTML = "";
        msgs.sort((a,b) => b.createdTime - a.createdTime).forEach(({ data, dist, createdTime, id }) => {
          const distStr = dist !== null ? `${dist.toFixed(1)} km` : "";
          const timeStr = timeAgo(new Date(createdTime));
          const li = document.createElement("li");
          li.className = "road-msg-item";
          li.innerHTML = `
            <div class="road-msg-text">⚠️ ${data.text}</div>
            <div class="road-msg-meta">${distStr ? distStr + " · " : ""}${timeStr}</div>
          `;
          li.onclick = () => {
            if (map) map.setView([data.lat, data.lon], 16);
            if (activeRoadMarkers.has(id)) activeRoadMarkers.get(id).openPopup();
          };
          roadList.appendChild(li);

          // Map marker
          if (!activeRoadMarkers.has(id)) {
            const yIcon = L.icon({ iconUrl: "https://maps.google.com/mapfiles/ms/icons/yellow-dot.png", iconSize:[32,32], iconAnchor:[16,32] });
            const m = L.marker([data.lat, data.lon], { icon: yIcon }).addTo(map).bindPopup(`⚠ ${data.text}`);
            activeRoadMarkers.set(id, m);
          }
        });
      }
    }
  });
  unsubscribers.push(unsubRoad);

  /* ── SOS Notification Log (own sent alerts) ── */
  const erLog = document.getElementById("erNotifLog");
  if (erLog) {
    (() => {
      const nQ = query(
        collection(db, "sos_notifications"),
        where("senderId", "==", currentUser.uid),
        orderBy("clientTime", "desc")
      );
      const unsubN = onSnapshot(nQ, (snap) => {
        if (snap.empty) { erLog.innerHTML = `<p class="notif-empty">No SOS alerts sent yet</p>`; return; }
        erLog.innerHTML = "";
        snap.forEach(docSnap => {
          const d = docSnap.data();
          const card = document.createElement("div");
          card.className = "notif-card";
          const timeStr = d.clientTime ? new Date(d.clientTime).toLocaleString() : "Unknown";

          const smsRows = (d.smsResults || []).map(r => `
            <div class="notif-row">
              <span class="notif-label">📱 ${r.name} (${r.phone})</span>
              <span class="${r.success ? "notif-badge-ok" : "notif-badge-fail"}">${r.success ? "Sent ✓" : "Failed ✗"}</span>
            </div>`).join("") || `<div class="notif-row"><span class="notif-label" style="color:#64748b">No contacts saved</span></div>`;

          const erRows = (d.erServices || []).map(s => `
            <div class="notif-row">
              <span class="notif-label">${s.emoji} ${s.name} (${s.number})</span>
              <span class="notif-badge-demo">Demo ✓</span>
            </div>`).join("");

          card.innerHTML = `
            <div class="notif-header">
              <span class="notif-title">🚨 SOS by ${d.senderName || "You"}</span>
              <span class="notif-time">${timeStr}</span>
            </div>
            <div class="notif-row">
              <span class="notif-label">📍 Location</span>
              <a class="notif-maps-link" href="${d.mapsLink}" target="_blank">View on Maps ↗</a>
            </div>
            <div class="notif-section">Emergency Contacts (Real SMS)</div>
            ${smsRows}
            <div class="notif-section">ER Services (Demo)</div>
            ${erRows}
          `;
          erLog.appendChild(card);
        });
      });
      unsubscribers.push(unsubN);
    })();
  }
}


async function initSettings() {
  /* ── Account info ── */
  const accountTypeEl  = document.getElementById("accountType");
  const setupSection   = document.getElementById("setupAccountSection");
  const contactSection = document.getElementById("contactSection");
  const lockMsg        = document.getElementById("contactLockMsg");
  const emailEl        = document.getElementById("accountEmail");
  const uid            = currentUser.uid;

  if (!currentUser.isAnonymous) {
    if (accountTypeEl)  accountTypeEl.textContent  = "Registered ✅";
    if (emailEl)        emailEl.textContent        = currentUser.email || "---";
    if (setupSection)   setupSection.style.display = "none";
    if (contactSection) contactSection.classList.remove("hidden");
    if (lockMsg)        lockMsg.style.display      = "none";
  } else {
    if (accountTypeEl) accountTypeEl.textContent = "Guest";
    if (emailEl)       emailEl.textContent       = "Not set";
  }

  /* ── Load Profile ── */
  const profileRef = doc(db, "user_profiles", uid);
  try {
    const snap = await getDoc(profileRef);
    if (snap.exists()) {
      const d = snap.data();
      const n = document.getElementById("profileName");
      const v = document.getElementById("profileVehicle");
      const p = document.getElementById("profilePlate");
      const t = document.getElementById("profileVehicleType");
      if (n) n.value = d.name    || "";
      if (v) v.value = d.vehicle || "";
      if (p) p.value = d.plate   || "";
      if (t && d.vehicleType) t.value = d.vehicleType;
    }
  } catch(e) { console.error("Profile load error:", e); }

  /* ── Save Profile ── */
  document.getElementById("saveProfileBtn")?.addEventListener("click", async () => {
    const name    = document.getElementById("profileName")?.value.trim();
    const vehicle = document.getElementById("profileVehicle")?.value.trim();
    const plate   = document.getElementById("profilePlate")?.value.trim().toUpperCase();
    const vtype   = document.getElementById("profileVehicleType")?.value;
    if (!name) { showFlash("Please enter your name", "warning"); return; }
    try {
      await setDoc(profileRef, { name, vehicle, plate, vehicleType: vtype, updatedAt: serverTimestamp() }, { merge: true });
      showFlash("Profile saved ✅", "success");
    } catch(e) { showFlash("Failed to save profile", "error"); }
  });

  /* ── Alert preferences (localStorage) ── */
  const prefs       = JSON.parse(localStorage.getItem("alertPrefs") || "{}");
  const soundToggle = document.getElementById("toggleSound");
  const vibToggle   = document.getElementById("toggleVibration");
  const flashToggle = document.getElementById("toggleFlash");

  if (soundToggle) soundToggle.checked = prefs.sound     !== false;
  if (vibToggle)   vibToggle.checked   = prefs.vibration !== false;
  if (flashToggle) flashToggle.checked = prefs.flash     !== false;

  document.getElementById("saveAlertsBtn")?.addEventListener("click", () => {
    localStorage.setItem("alertPrefs", JSON.stringify({
      sound:     soundToggle?.checked ?? true,
      vibration: vibToggle?.checked   ?? true,
      flash:     flashToggle?.checked ?? true,
    }));
    showFlash("Alert preferences saved ✅", "success");
  });

  /* ── Emergency contacts (3 slots) ── */
  if (!currentUser.isAnonymous) {
    const contactsRef = doc(db, "emergency_contacts", uid);

    try {
      const snap = await getDoc(contactsRef);
      const contacts = snap.exists() ? (snap.data().contacts || []) : [];
      [0, 1, 2].forEach(i => {
        const c = contacts[i] || null;
        const nameInput  = document.querySelector(`.contact-name-input[data-slot="${i}"]`);
        const phoneInput = document.querySelector(`.contact-phone-input[data-slot="${i}"]`);
        const clearBtn   = document.querySelector(`.contact-clear-btn[data-slot="${i}"]`);
        const slot       = document.getElementById(`slot${i}`);
        if (c && c.name) {
          if (nameInput)  nameInput.value  = c.name;
          if (phoneInput) phoneInput.value = c.phone;
          if (clearBtn)   clearBtn.classList.remove("hidden");
          if (slot)       slot.classList.add("filled");
        }
      });
    } catch(e) { console.error("Contacts load error:", e); }

    document.querySelectorAll(".save-contact-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const i         = parseInt(btn.dataset.slot);
        const nameInput  = document.querySelector(`.contact-name-input[data-slot="${i}"]`);
        const phoneInput = document.querySelector(`.contact-phone-input[data-slot="${i}"]`);
        const name  = nameInput?.value.trim();
        const phone = phoneInput?.value.trim();
        if (!name || !phone) { showFlash("Enter both name and phone number", "warning"); return; }
        if (!/^[0-9+\-\s]{7,15}$/.test(phone)) { showFlash("Enter a valid phone number", "warning"); return; }
        try {
          const snap = await getDoc(contactsRef);
          const existing = snap.exists() ? (snap.data().contacts || []) : [];
          while (existing.length < 3) existing.push(null);
          existing[i] = { name, phone };
          await setDoc(contactsRef, { contacts: existing, updatedAt: serverTimestamp() }, { merge: true });
          showFlash(`Contact ${i+1} saved ✅`, "success");
          const clearBtn = document.querySelector(`.contact-clear-btn[data-slot="${i}"]`);
          const slot = document.getElementById(`slot${i}`);
          if (clearBtn) clearBtn.classList.remove("hidden");
          if (slot)     slot.classList.add("filled");
        } catch(e) { showFlash("Failed to save contact", "error"); }
      });
    });

    document.querySelectorAll(".contact-clear-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const i = parseInt(btn.dataset.slot);
        try {
          const snap = await getDoc(contactsRef);
          const existing = snap.exists() ? (snap.data().contacts || []) : [];
          while (existing.length < 3) existing.push(null);
          existing[i] = null;
          await setDoc(contactsRef, { contacts: existing, updatedAt: serverTimestamp() }, { merge: true });
          const nameInput  = document.querySelector(`.contact-name-input[data-slot="${i}"]`);
          const phoneInput = document.querySelector(`.contact-phone-input[data-slot="${i}"]`);
          if (nameInput)  nameInput.value  = "";
          if (phoneInput) phoneInput.value = "";
          btn.classList.add("hidden");
          const slot = document.getElementById(`slot${i}`);
          if (slot) slot.classList.remove("filled");
          showFlash(`Contact ${i+1} removed`, "success");
        } catch(e) { showFlash("Failed to remove contact", "error"); }
      });
    });
  }

  /* ── Upgrade guest account ── */
  document.getElementById("completeSetupBtn")?.addEventListener("click", async () => {
    const email    = document.getElementById("setupEmail")?.value.trim();
    const password = document.getElementById("setupPassword")?.value;
    const name     = document.getElementById("setupName")?.value.trim();
    if (!email || !password) { showFlash("Enter email and password", "warning"); return; }
    if (password.length < 6) { showFlash("Password must be at least 6 characters", "warning"); return; }
    const credential = EmailAuthProvider.credential(email, password);
    try {
      await linkWithCredential(currentUser, credential);
      if (name) await setDoc(doc(db, "user_profiles", uid), { name, updatedAt: serverTimestamp() }, { merge: true });
      showFlash("Account upgraded successfully ✅", "success");
      setTimeout(() => location.reload(), 1200);
    } catch(err) {
      showFlash("Failed: " + err.message, "error");
    }
  });

  /* ── PWA install ── */
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById("installPwaBtn");
    if (btn) btn.style.display = "block";
  });
  document.getElementById("installPwaBtn")?.addEventListener("click", () => {
    deferredPrompt?.prompt();
    deferredPrompt = null;
  });

  /* ── Clear cache ── */
  document.getElementById("clearCacheBtn")?.addEventListener("click", async () => {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    showFlash("Cache cleared!", "success");
    setTimeout(() => location.reload(true), 800);
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

/* ================= SOS NOTIFICATIONS ================= */

async function sendSOSNotifications(lat, lon, eventId) {
  const uid = currentUser.uid;
  const mapsLink = `https://maps.google.com/?q=${lat},${lon}`;
  const timestamp = new Date().toLocaleString();

  /* 1. Fetch emergency contacts from Firestore */
  let contacts = [];
  try {
    const snap = await getDoc(doc(db, "emergency_contacts", uid));
    if (snap.exists()) {
      contacts = (snap.data().contacts || []).filter(c => c && c.phone);
    }
  } catch(e) { console.error("Contacts fetch error:", e); }

  /* 2. Fetch sender profile for name */
  let senderName = "A V2V user";
  try {
    const pSnap = await getDoc(doc(db, "user_profiles", uid));
    if (pSnap.exists() && pSnap.data().name) senderName = pSnap.data().name;
  } catch(e) {}

  const smsBody = `🚨 SOS ALERT from ${senderName}! They need emergency help at: ${mapsLink} — Sent via V2V Emergency App`;

  /* 3. Send REAL SMS to each emergency contact via Twilio server */
  const smsResults = [];
  for (const contact of contacts) {
    try {
      const res = await fetch("http://localhost:5000/send-sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: contact.phone, message: smsBody })
      });
      const json = await res.json();
      smsResults.push({ name: contact.name, phone: contact.phone, success: json.success });
    } catch(e) {
      smsResults.push({ name: contact.name, phone: contact.phone, success: false, error: e.message });
    }
  }

  /* 4. Log DEMO ER notification to Firestore (not real, just for display) */
  const erServices = [
    { name: "Ambulance Control", number: "102", emoji: "🚑" },
    { name: "Police Dispatch",   number: "100", emoji: "🚓" },
    { name: "Fire Brigade",      number: "101", emoji: "🚒" }
  ];

  await setDoc(doc(db, "sos_notifications", eventId), {
    eventId,
    senderId: uid,
    senderName,
    lat, lon,
    mapsLink,
    timestamp,
    clientTime: Date.now(),
    smsResults,          // real contact SMS results
    erServices,          // demo — not actually called
    erNotified: true     // demo flag
  }, { merge: true }).catch(console.error);

  /* 5. Flash result to user */
  const sentCount = smsResults.filter(r => r.success).length;
  if (contacts.length === 0) {
    showFlash("⚠️ No emergency contacts set — add them in Settings", "warning");
  } else if (sentCount === contacts.length) {
    showFlash(`📱 SMS sent to ${sentCount} emergency contact${sentCount > 1 ? "s" : ""}`, "success");
  } else {
    showFlash(`📱 SMS sent to ${sentCount}/${contacts.length} contacts`, "warning");
  }
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

  try {
    await addDoc(collection(db, "road_messages"), {
      lat: currentLocation.lat,
      lon: currentLocation.lon,
      text: message,
      senderId: currentUser.uid,
      createdAt: serverTimestamp(),
      clientTime: Date.now()
    });
  } catch (err) {
    console.error("Road message error:", err);
    showFlash("Failed to send message. Check connection.", "error");
    return;
  }

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
    .bindPopup(`⚠ Road Info:<br>${escapeHtml(data.text)}`);

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
  if (!list || !currentLocation) return;

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
    <strong>⚠ ${escapeHtml(data.text)}</strong><br/>
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
  if (locationWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
  }
  hasStartedRealtimeListeners = false;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

  /* ── Sidebar / Hamburger ── */
  const hamburger   = document.getElementById("hamburger");
  const navMenu     = document.getElementById("navMenu");
  const navOverlay  = document.getElementById("navOverlay");
  const sidebarClose = document.getElementById("sidebarClose");

  function openSidebar() {
    navMenu?.classList.add("open");
    navOverlay?.classList.add("active");
    hamburger?.classList.add("open");
    hamburger?.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
  }

  function closeSidebar() {
    navMenu?.classList.remove("open");
    navOverlay?.classList.remove("active");
    hamburger?.classList.remove("open");
    hamburger?.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";
  }

  hamburger?.addEventListener("click", () => {
    const isOpen = navMenu?.classList.contains("open");
    isOpen ? closeSidebar() : openSidebar();
  });

  sidebarClose?.addEventListener("click", closeSidebar);
  navOverlay?.addEventListener("click", closeSidebar);

  // Close sidebar on link click
  navMenu?.querySelectorAll("a").forEach(link => {
    link.addEventListener("click", closeSidebar);
  });

  // Close on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSidebar();
  });

  /* ── Inject desktop nav into header ── */
  const headerLeft = document.querySelector(".header-left");
  if (headerLeft && navMenu) {
    const desktopNav = document.createElement("nav");
    desktopNav.className = "desktop-nav";
    navMenu.querySelectorAll("a").forEach(a => {
      const link = document.createElement("a");
      link.href = a.href;
      link.textContent = a.textContent.trim();
      if (a.classList.contains("active")) link.classList.add("active");
      desktopNav.appendChild(link);
    });
    headerLeft.appendChild(desktopNav);
  }

  /* ── PWA Service Worker ── */
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

});
