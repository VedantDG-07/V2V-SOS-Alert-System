/**
 * V2V Direction Engine — direction-engine.js
 * ============================================
 * Adds to the existing V2V-SOS system:
 *   1. Continuous GPS tracking (2-3s cycle, 5m noise filter)
 *   2. Heading calculation + smoothing (avg of last 3)
 *   3. OSRM map-matching (snap to road, triggered every 20-30m)
 *   4. Road bearing from OSRM geometry
 *   5. Vehicle-road alignment detection
 *   6. Direction-based nearby vehicle filtering (heading diff < 45°)
 *   7. Directional arrow markers on Leaflet map
 *
 * Usage:
 *   import { DirectionEngine } from "./direction-engine.js";
 *   DirectionEngine.init({ map, db, currentUser, setCurrentLocation });
 */

export const DirectionEngine = (() => {

  /* ── Internal State ── */
  const state = {
    prevPosition: null,       // { lat, lon }
    currentPosition: null,    // { lat, lon }
    recentHeadings: [],       // last 3 raw headings
    smoothedHeading: 0,       // averaged heading
    snappedPosition: null,    // { lat, lon } — OSRM snapped coords
    roadBearing: null,        // bearing from OSRM road geometry
    aligned: false,           // is vehicle aligned with road?
    distanceSinceOSRM: 0,     // metres moved since last OSRM call
    lastOSRMSnap: null,       // last snapped { lat, lon }
    recentGPSPoints: [],      // last 5 raw GPS points for OSRM
    trackInterval: null,      // setInterval handle
    nearbyMarkers: new Map(), // uid → Leaflet marker
    mapRef: null,
    dbRef: null,
    userRef: null,
    onLocationUpdate: null,   // callback(lat, lon, heading, snappedLat, snappedLon)
  };

  /* ── Constants ── */
  const TRACK_INTERVAL_MS      = 2500;   // 2-3 seconds
  const NOISE_THRESHOLD_M      = 5;      // ignore moves < 5m
  const OSRM_TRIGGER_M         = 25;     // call OSRM every ~25m
  const HEADING_HISTORY_LEN    = 3;      // smooth over 3 readings
  const DIRECTION_FILTER_DEG   = 45;     // max heading diff for "same direction"
  const OSRM_ENDPOINT          = "https://router.project-osrm.org/match/v1/driving/";

  /* ═══════════════════════════════════════════
     SECTION 1 — GEOMETRY UTILITIES
  ═══════════════════════════════════════════ */

  /**
   * Haversine distance in metres between two lat/lon points.
   */
  function distanceMetres(lat1, lon1, lat2, lon2) {
    const R   = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a   = Math.sin(dLat / 2) ** 2
              + Math.cos(lat1 * Math.PI / 180)
              * Math.cos(lat2 * Math.PI / 180)
              * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Bearing (0-360°) from point A to point B.
   */
  function bearing(lat1, lon1, lat2, lon2) {
    const φ1  = lat1 * Math.PI / 180;
    const φ2  = lat2 * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y   = Math.sin(dLon) * Math.cos(φ2);
    const x   = Math.cos(φ1) * Math.sin(φ2)
              - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }

  /**
   * Smallest angular difference between two headings (0–180°).
   */
  function headingDiff(a, b) {
    const diff = Math.abs(a - b) % 360;
    return diff > 180 ? 360 - diff : diff;
  }

  /* ═══════════════════════════════════════════
     SECTION 2 — HEADING CALCULATION & SMOOTHING
  ═══════════════════════════════════════════ */

  /**
   * Calculate heading from prev → current, add to rolling buffer,
   * return smoothed average.
   */
  function updateHeading(lat1, lon1, lat2, lon2) {
    const raw = bearing(lat1, lon1, lat2, lon2);
    state.recentHeadings.push(raw);
    if (state.recentHeadings.length > HEADING_HISTORY_LEN) {
      state.recentHeadings.shift();
    }
    // Circular mean to handle 359°→1° wrap correctly
    let sinSum = 0, cosSum = 0;
    for (const h of state.recentHeadings) {
      sinSum += Math.sin(h * Math.PI / 180);
      cosSum += Math.cos(h * Math.PI / 180);
    }
    state.smoothedHeading = ((Math.atan2(sinSum, cosSum) * 180 / Math.PI) + 360) % 360;
    return state.smoothedHeading;
  }

  /* ═══════════════════════════════════════════
     SECTION 3 — OSRM MAP MATCHING
  ═══════════════════════════════════════════ */

  /**
   * Call OSRM Match API with last 2-5 GPS points.
   * Returns { snappedLat, snappedLon, roadBearing } or null on failure.
   */
  async function callOSRM(points) {
    if (points.length < 2) return null;

    // OSRM expects: lng,lat;lng,lat;...
    const coords = points.map(p => `${p.lon},${p.lat}`).join(";");
    const url    = `${OSRM_ENDPOINT}${coords}?geometries=geojson&overview=full`;

    try {
      const res  = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = await res.json();

      if (!data.matchings || data.matchings.length === 0) return null;

      const geometry   = data.matchings[0].geometry;
      const snappedCoords = geometry.coordinates; // [lng, lat] pairs

      if (!snappedCoords || snappedCoords.length < 2) return null;

      // Last snapped point = our current snapped position
      const last = snappedCoords[snappedCoords.length - 1];
      const prev = snappedCoords[snappedCoords.length - 2];

      const snappedLat  = last[1];
      const snappedLon  = last[0];

      // Road bearing = direction of last two snapped points
      const roadBear = bearing(prev[1], prev[0], last[1], last[0]);

      return { snappedLat, snappedLon, roadBearing: roadBear };
    } catch (err) {
      console.warn("[DirectionEngine] OSRM error:", err.message);
      return null;
    }
  }

  /* ═══════════════════════════════════════════
     SECTION 4 — VEHICLE-ROAD ALIGNMENT
  ═══════════════════════════════════════════ */

  /**
   * Compare vehicle heading vs road bearing.
   * Allows ±45° as "aligned" (accounts for slight GPS jitter).
   */
  function checkAlignment(vehicleHeading, roadBearing) {
    const diff = headingDiff(vehicleHeading, roadBearing);
    // Also check opposite direction (diff ~180°)
    const oppositeAligned = headingDiff(vehicleHeading, (roadBearing + 180) % 360) < 45;
    return {
      aligned: diff < 45 || oppositeAligned,
      sameDirection: diff < 45,
      diff
    };
  }

  /* ═══════════════════════════════════════════
     SECTION 5 — FIREBASE LOCATION WRITE
  ═══════════════════════════════════════════ */

  /**
   * Write enriched location (snapped coords + heading) to Firestore active_users.
   * Merges into existing doc so it doesn't break other fields.
   */
  async function writeEnrichedLocation(lat, lon, heading, aligned) {
    if (!state.dbRef || !state.userRef) return;
    try {
      const { setDoc, doc, serverTimestamp } = await import("./firebase-config.js");
      await setDoc(
        doc(state.dbRef, "active_users", state.userRef.uid),
        {
          lat,
          lon,
          heading: Math.round(heading),
          aligned,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    } catch (e) {
      console.warn("[DirectionEngine] Firebase write error:", e.message);
    }
  }

  /* ═══════════════════════════════════════════
     SECTION 6 — DIRECTION-BASED FILTERING
  ═══════════════════════════════════════════ */

  /**
   * Decide if a nearby vehicle (with known heading) is relevant.
   * Returns { relevant: bool, riskLevel: 'high'|'medium'|'low' }
   *
   * Existing 2km distance check is done in app.js.
   * This adds heading-based classification on top.
   */
  function classifyVehicle(myHeading, theirHeading) {
    // If other vehicle has no heading data, default to medium
    if (theirHeading === undefined || theirHeading === null) {
      return { relevant: true, riskLevel: "medium" };
    }

    const diff = headingDiff(myHeading, theirHeading);

    if (diff < 45) {
      // Same direction → potential rear-end collision risk
      return { relevant: true, riskLevel: "high" };
    } else if (diff < 90) {
      // Angled → intersection risk
      return { relevant: true, riskLevel: "medium" };
    } else if (diff > 135) {
      // Opposite direction → oncoming, still relevant
      return { relevant: true, riskLevel: "medium" };
    } else {
      // Perpendicular or diverging → low relevance
      return { relevant: false, riskLevel: "low" };
    }
  }

  /* ═══════════════════════════════════════════
     SECTION 7 — LEAFLET ARROW MARKERS
  ═══════════════════════════════════════════ */

  const RISK_COLORS = {
    high:   "#ef4444",  // red
    medium: "#f59e0b",  // yellow
    low:    "#6b7280",  // grey
  };

  /**
   * Build an SVG arrow icon that rotates to the given heading.
   * Returns a Leaflet DivIcon.
   */
  function buildArrowIcon(heading, riskLevel, isMe = false) {
    const color  = isMe ? "#38bdf8" : RISK_COLORS[riskLevel] || "#6b7280";
    const size   = isMe ? 36 : 30;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 36 36"
           style="transform: rotate(${heading}deg); display:block;">
        <polygon points="18,2 28,32 18,25 8,32"
                 fill="${color}" stroke="white" stroke-width="2" opacity="0.92"/>
      </svg>`;

    return L.divIcon({
      html:        svg,
      className:   "",           // no default Leaflet styles
      iconSize:    [size, size],
      iconAnchor:  [size / 2, size / 2],
    });
  }

  /**
   * Update or create an arrow marker for a nearby vehicle on the map.
   * @param {string} uid
   * @param {number} lat
   * @param {number} lon
   * @param {number} heading
   * @param {string} riskLevel   'high' | 'medium' | 'low'
   * @param {string} popupText
   */
  function upsertVehicleMarker(uid, lat, lon, heading, riskLevel, popupText) {
    if (!state.mapRef) return;

    const icon = buildArrowIcon(heading, riskLevel);

    if (state.nearbyMarkers.has(uid)) {
      const m = state.nearbyMarkers.get(uid);
      m.setLatLng([lat, lon]);
      m.setIcon(icon);
      m.getPopup()?.setContent(popupText);
    } else {
      const marker = L.marker([lat, lon], { icon })
        .addTo(state.mapRef)
        .bindPopup(popupText);
      state.nearbyMarkers.set(uid, marker);
    }
  }

  /**
   * Remove markers for UIDs no longer in the nearby set.
   */
  function pruneStaleMarkers(activeUids) {
    for (const [uid, marker] of state.nearbyMarkers) {
      if (!activeUids.has(uid)) {
        state.mapRef?.removeLayer(marker);
        state.nearbyMarkers.delete(uid);
      }
    }
  }

  /* ═══════════════════════════════════════════
     SECTION 8 — MY OWN MARKER (ARROW)
  ═══════════════════════════════════════════ */

  let myArrowMarker = null;

  /**
   * Update the user's own marker to show as a directional arrow.
   */
  function updateMyArrow(lat, lon, heading) {
    if (!state.mapRef) return;

    const icon = buildArrowIcon(heading, null, true);

    if (!myArrowMarker) {
      myArrowMarker = L.marker([lat, lon], { icon })
        .addTo(state.mapRef)
        .bindPopup(`🚗 My Vehicle<br>Heading: ${Math.round(heading)}°`);
    } else {
      myArrowMarker.setLatLng([lat, lon]);
      myArrowMarker.setIcon(icon);
      myArrowMarker.getPopup()?.setContent(`🚗 My Vehicle<br>Heading: ${Math.round(heading)}°`);
    }
  }

  /* ═══════════════════════════════════════════
     SECTION 9 — MAIN TRACKING LOOP
  ═══════════════════════════════════════════ */

  /**
   * Single iteration: get GPS → heading → OSRM → Firebase → notify.
   */
  async function trackingCycle() {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;

        // ── 1. Noise filter ──────────────────────────────────
        if (state.currentPosition) {
          const moved = distanceMetres(
            state.currentPosition.lat, state.currentPosition.lon, lat, lon
          );
          if (moved < NOISE_THRESHOLD_M) return; // ignore micro-jitter
        }

        // ── 2. Heading ───────────────────────────────────────
        let heading = state.smoothedHeading;
        if (state.currentPosition) {
          heading = updateHeading(
            state.currentPosition.lat, state.currentPosition.lon, lat, lon
          );
        }

        // ── 3. Shift position history ────────────────────────
        state.prevPosition    = state.currentPosition;
        state.currentPosition = { lat, lon };

        // Keep last 5 raw GPS points for OSRM
        state.recentGPSPoints.push({ lat, lon });
        if (state.recentGPSPoints.length > 5) state.recentGPSPoints.shift();

        // ── 4. OSRM (only every ~25m moved) ──────────────────
        if (state.prevPosition) {
          state.distanceSinceOSRM += distanceMetres(
            state.prevPosition.lat, state.prevPosition.lon, lat, lon
          );
        }

        let snappedLat = lat;
        let snappedLon = lon;

        if (state.distanceSinceOSRM >= OSRM_TRIGGER_M && state.recentGPSPoints.length >= 2) {
          const result = await callOSRM(state.recentGPSPoints);
          if (result) {
            snappedLat          = result.snappedLat;
            snappedLon          = result.snappedLon;
            state.roadBearing   = result.roadBearing;
            state.snappedPosition = { lat: snappedLat, lon: snappedLon };
            state.lastOSRMSnap  = { lat: snappedLat, lon: snappedLon };
            const align         = checkAlignment(heading, result.roadBearing);
            state.aligned       = align.aligned;
          }
          state.distanceSinceOSRM = 0;
        } else if (state.lastOSRMSnap) {
          // Use last known snap until next OSRM call
          snappedLat = state.lastOSRMSnap.lat;
          snappedLon = state.lastOSRMSnap.lon;
        }

        // ── 5. Notify app.js via callback ─────────────────────
        // (app.js owns the vehicle marker — updateVehicleMarker())
        if (state.onLocationUpdate) {
          state.onLocationUpdate(snappedLat, snappedLon, heading, state.aligned);
        }

        // ── 7. Firebase write ─────────────────────────────────
        await writeEnrichedLocation(snappedLat, snappedLon, heading, state.aligned);
      },
      (err) => console.warn("[DirectionEngine] GPS error:", err.message),
      { timeout: 5000, maximumAge: 0, enableHighAccuracy: true }
    );
  }

  /* ═══════════════════════════════════════════
     SECTION 10 — NEARBY VEHICLES RENDERER
  ═══════════════════════════════════════════ */

  /**
   * Called by app.js when a Firestore nearby-vehicles snapshot fires.
   * Replaces the old circle-marker approach with direction-aware arrows.
   *
   * @param {Array} vehicles   Array of { uid, lat, lon, heading } objects
   */
  function renderNearbyVehicles(vehicles) {
    const activeUids = new Set();

    for (const v of vehicles) {
      if (!v.uid || !v.lat || !v.lon) continue;

      activeUids.add(v.uid);

      const { relevant, riskLevel } = classifyVehicle(state.smoothedHeading, v.heading);

      // Build popup
      const headingStr = v.heading !== undefined ? `${Math.round(v.heading)}°` : "Unknown";
      const riskLabel  = riskLevel === "high" ? "🔴 High Risk"
                       : riskLevel === "medium" ? "🟡 Medium Risk"
                       : "⚪ Low Risk";

      const popup = `
        🚗 Nearby Vehicle<br/>
        Heading: ${headingStr}<br/>
        ${riskLabel}
      `;

      // Skip low-relevance vehicles entirely
      if (!relevant) {
        // Remove if was previously shown
        if (state.nearbyMarkers.has(v.uid)) {
          state.mapRef?.removeLayer(state.nearbyMarkers.get(v.uid));
          state.nearbyMarkers.delete(v.uid);
        }
        continue;
      }

      upsertVehicleMarker(v.uid, v.lat, v.lon, v.heading || 0, riskLevel, popup);
    }

    pruneStaleMarkers(activeUids);
  }

  /* ═══════════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════════ */

  /**
   * Initialize the Direction Engine.
   *
   * @param {object} opts
   * @param {L.Map}    opts.map              - Leaflet map instance (can be null, assigned later)
   * @param {object}   opts.db               - Firestore db instance
   * @param {object}   opts.currentUser      - Firebase auth user
   * @param {Function} opts.onLocationUpdate - callback(lat, lon, heading, aligned)
   */
  function init({ map = null, db, currentUser, onLocationUpdate = null }) {
    state.mapRef          = map;
    state.dbRef           = db;
    state.userRef         = currentUser;
    state.onLocationUpdate = onLocationUpdate;

    // Start tracking loop
    if (state.trackInterval) clearInterval(state.trackInterval);
    state.trackInterval = setInterval(trackingCycle, TRACK_INTERVAL_MS);

    // Run once immediately
    trackingCycle();

    console.log("[DirectionEngine] Initialized ✓");
  }

  /** Assign (or reassign) the Leaflet map after it's created */
  function setMap(mapInstance) {
    state.mapRef = mapInstance;
  }

  /** Stop tracking cleanly */
  function stop() {
    if (state.trackInterval) {
      clearInterval(state.trackInterval);
      state.trackInterval = null;
    }
  }

  /** Read current smoothed heading (0-360°) */
  function getHeading() { return state.smoothedHeading; }

  /** Read current snapped (road-aligned) position */
  function getSnappedPosition() { return state.snappedPosition || state.currentPosition; }

  /** Read alignment status */
  function isAligned() { return state.aligned; }

  /** Expose classifyVehicle for use in app.js alert logic */
  function classify(myHeading, theirHeading) {
    return classifyVehicle(myHeading, theirHeading);
  }

  return {
    init,
    setMap,
    stop,
    getHeading,
    getSnappedPosition,
    isAligned,
    renderNearbyVehicles,
    classify,
    headingDiff,   // exported for custom use in app.js
  };

})();