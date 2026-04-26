/**
 * V2V Direction Engine — direction-engine.js
 * ============================================
 * Upgraded: Road-following smooth animation (Uber/Google Maps style)
 *
 * New in this version:
 *   - OSRM /route API for actual road geometry between snapped points
 *   - Path-based animation: marker follows road curves frame-by-frame
 *   - Continuous heading interpolation along polyline segments
 *   - Graceful fallback to straight-line if OSRM route fails
 *   - Animation blending: new GPS during active animation restarts from
 *     current visual position (no jumps)
 *   - Reduced OSRM snap trigger: 25m → 10m
 *   - Forced initial snap on first GPS fix
 */

export const DirectionEngine = (() => {

  /* ── Internal State ── */
  const state = {
    prevPosition:       null,   // { lat, lon }
    currentPosition:    null,   // { lat, lon }
    recentHeadings:     [],     // last 3 raw headings
    smoothedHeading:    0,      // averaged heading
    snappedPosition:    null,   // { lat, lon } last OSRM-snapped coords
    roadBearing:        null,
    aligned:            false,
    distanceSinceOSRM:  0,
    lastOSRMSnap:       null,   // { lat, lon }
    recentGPSPoints:    [],     // last 5 raw GPS points for /match
    trackInterval:      null,
    nearbyMarkers:      new Map(),
    mapRef:             null,
    dbRef:              null,
    userRef:            null,
    onLocationUpdate:   null,

    /* ── Animation state ── */
    animPath:           [],     // current polyline being animated [[lat,lon],...]
    animIndex:          0,      // index into animPath of "current segment start"
    animProgress:       0,      // 0..1 progress within current segment
    animFrame:          null,   // requestAnimationFrame handle
    animLastTime:       null,   // performance.now() at last frame
    animSpeedMps:       8,      // metres-per-second perceived speed (adjustable)
    visualLat:          null,   // current rendered marker lat
    visualLon:          null,   // current rendered marker lon
    visualHeading:      0,      // current rendered marker heading

    /* ── Route cache ── */
    lastRouteKey:       null,   // "lat1,lon1→lat2,lon2" cache key
    lastRouteGeom:      null,   // [[lat,lon],...] cached geometry
  };

  /* ── Constants ── */
  const TRACK_INTERVAL_MS    = 2500;
  const NOISE_THRESHOLD_M    = 5;
  const OSRM_TRIGGER_M       = 10;   // reduced from 25m → 10m
  const HEADING_HISTORY_LEN  = 3;
  const OSRM_MATCH_ENDPOINT  = "https://router.project-osrm.org/match/v1/driving/";
  const OSRM_ROUTE_ENDPOINT  = "https://router.project-osrm.org/route/v1/driving/";
  const ROUTE_CACHE_DIST_M   = 5;    // reuse cached route if endpoints haven't moved > 5m

  /* ═══════════════════════════════════════════
     SECTION 1 — GEOMETRY UTILITIES
  ═══════════════════════════════════════════ */

  function distanceMetres(lat1, lon1, lat2, lon2) {
    const R    = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2
               + Math.cos(lat1 * Math.PI / 180)
               * Math.cos(lat2 * Math.PI / 180)
               * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const φ1   = lat1 * Math.PI / 180;
    const φ2   = lat2 * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y    = Math.sin(dLon) * Math.cos(φ2);
    const x    = Math.cos(φ1) * Math.sin(φ2)
               - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }

  function headingDiff(a, b) {
    const diff = Math.abs(a - b) % 360;
    return diff > 180 ? 360 - diff : diff;
  }

  /** Linear interpolation between two lat/lon points at fraction t (0..1) */
  function lerpLatLon(lat1, lon1, lat2, lon2, t) {
    return { lat: lat1 + (lat2 - lat1) * t, lon: lon1 + (lon2 - lon1) * t };
  }

  /**
   * Shortest-path heading interpolation (handles 359°→1° wrap).
   */
  function lerpHeading(from, to, t) {
    let diff = ((to - from + 540) % 360) - 180;
    return (from + diff * t + 360) % 360;
  }

  /* ═══════════════════════════════════════════
     SECTION 2 — HEADING CALCULATION & SMOOTHING
  ═══════════════════════════════════════════ */

  function updateHeading(lat1, lon1, lat2, lon2) {
    const raw = bearing(lat1, lon1, lat2, lon2);
    state.recentHeadings.push(raw);
    if (state.recentHeadings.length > HEADING_HISTORY_LEN) state.recentHeadings.shift();

    // Circular mean
    let sinSum = 0, cosSum = 0;
    for (const h of state.recentHeadings) {
      sinSum += Math.sin(h * Math.PI / 180);
      cosSum += Math.cos(h * Math.PI / 180);
    }
    state.smoothedHeading = ((Math.atan2(sinSum, cosSum) * 180 / Math.PI) + 360) % 360;
    return state.smoothedHeading;
  }

  /* ═══════════════════════════════════════════
     SECTION 3 — OSRM MAP MATCHING (/match)
  ═══════════════════════════════════════════ */

  async function callOSRMMatch(points) {
    if (points.length < 2) return null;
    const coords = points.map(p => `${p.lon},${p.lat}`).join(";");
    const url    = `${OSRM_MATCH_ENDPOINT}${coords}?geometries=geojson&overview=full`;
    try {
      const res  = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.matchings?.length) return null;

      const coords2 = data.matchings[0].geometry.coordinates;
      if (!coords2 || coords2.length < 2) return null;

      const last = coords2[coords2.length - 1];
      const prev = coords2[coords2.length - 2];

      return {
        snappedLat:  last[1],
        snappedLon:  last[0],
        roadBearing: bearing(prev[1], prev[0], last[1], last[0]),
      };
    } catch (err) {
      console.warn("[DirectionEngine] OSRM match error:", err.message);
      return null;
    }
  }

  /* ═══════════════════════════════════════════
     SECTION 4 — OSRM ROUTE (/route) — NEW
  ═══════════════════════════════════════════ */

  /**
   * Fetch road geometry from OSRM route endpoint.
   * Returns array of [lat, lon] pairs following the actual road.
   * Falls back to straight-line [[fromLat,fromLon],[toLat,toLon]] on failure.
   *
   * Caches last result so repeated calls for the same segment are skipped.
   */
  async function fetchRouteGeometry(fromLat, fromLon, toLat, toLon) {
    const distM = distanceMetres(fromLat, fromLon, toLat, toLon);
    if (distM < 1) return [[fromLat, fromLon], [toLat, toLon]]; // trivial segment

    // ── Cache check ──────────────────────────────────────────────────
    const cacheKey = `${fromLat.toFixed(5)},${fromLon.toFixed(5)}→${toLat.toFixed(5)},${toLon.toFixed(5)}`;
    if (state.lastRouteKey === cacheKey && state.lastRouteGeom) {
      return state.lastRouteGeom;
    }

    // If endpoints haven't moved much vs cached route, reuse
    if (state.lastRouteGeom && state.lastRouteKey) {
      const [, cachedTo] = state.lastRouteKey.split("→");
      const [cLat, cLon] = cachedTo.split(",").map(Number);
      if (distanceMetres(toLat, toLon, cLat, cLon) < ROUTE_CACHE_DIST_M) {
        return state.lastRouteGeom;
      }
    }

    // ── Fetch from OSRM ──────────────────────────────────────────────
    const url = `${OSRM_ROUTE_ENDPOINT}${fromLon},${fromLat};${toLon},${toLat}?geometries=geojson&overview=full&steps=false`;
    try {
      const res  = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (!data.routes?.length || !data.routes[0].geometry?.coordinates?.length) {
        throw new Error("No route geometry");
      }

      // GeoJSON: [lon, lat] → convert to [lat, lon]
      const geom = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);

      state.lastRouteKey  = cacheKey;
      state.lastRouteGeom = geom;
      return geom;
    } catch (err) {
      console.warn("[DirectionEngine] OSRM route error:", err.message, "— falling back to straight line");
      // Straight-line fallback
      const fallback = [[fromLat, fromLon], [toLat, toLon]];
      state.lastRouteKey  = cacheKey;
      state.lastRouteGeom = fallback;
      return fallback;
    }
  }

  /* ═══════════════════════════════════════════
     SECTION 5 — PATH-BASED ANIMATION — NEW
  ═══════════════════════════════════════════ */

  /**
   * Start animating the vehicle marker along a polyline path.
   *
   * If animation is already running, we DON'T jump to the start of the new
   * path — instead we resume from the current visual position by prepending
   * it as the first node, ensuring seamless continuation.
   *
   * @param {Array}  path        [[lat,lon], ...] from OSRM or fallback
   * @param {number} speedMps    metres per second (default: state.animSpeedMps)
   */
  function animateAlongPath(path, speedMps = state.animSpeedMps) {
    if (!path || path.length < 2) return;

    // ── If already animating, start new path from current visual pos ──
    if (state.animFrame !== null) {
      cancelAnimationFrame(state.animFrame);
      state.animFrame = null;

      // Splice current visual position as first node of new path
      // so the marker never teleports
      if (state.visualLat !== null && state.visualLon !== null) {
        path = [[state.visualLat, state.visualLon], ...path];
      }
    }

    state.animPath     = path;
    state.animIndex    = 0;
    state.animProgress = 0;
    state.animLastTime = null;

    // Pre-compute segment lengths for constant-speed traversal
    const segLengths = [];
    for (let i = 0; i < path.length - 1; i++) {
      segLengths.push(
        distanceMetres(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1])
      );
    }

    /**
     * Single animation frame.
     * Advances "distance budget" based on elapsed wall time, then
     * skips through polyline segments until budget is exhausted.
     */
    function step(now) {
      if (state.animLastTime === null) state.animLastTime = now;
      const dtSec    = Math.min((now - state.animLastTime) / 1000, 0.1); // cap at 100ms
      state.animLastTime = now;

      let budget = speedMps * dtSec; // metres to travel this frame

      // Advance through segments
      while (budget > 0 && state.animIndex < path.length - 1) {
        const segLen   = segLengths[state.animIndex];
        const remaining = segLen * (1 - state.animProgress);

        if (budget >= remaining) {
          // Consume this segment fully, move to next
          budget            -= remaining;
          state.animProgress = 0;
          state.animIndex++;
        } else {
          // Partial progress within this segment
          if (segLen > 0) state.animProgress += budget / segLen;
          budget = 0;
        }
      }

      // ── Clamp to end ──
      if (state.animIndex >= path.length - 1) {
        state.animIndex    = path.length - 2;
        state.animProgress = 1;
      }

      // ── Interpolate visual position ──
      const i    = state.animIndex;
      const t    = state.animProgress;
      const p0   = path[i];
      const p1   = path[i + 1] || path[i];
      const pos  = lerpLatLon(p0[0], p0[1], p1[0], p1[1], t);

      // ── Interpolate heading along road segment ──
      const segBearing  = bearing(p0[0], p0[1], p1[0], p1[1]);
      const prevBearing = i > 0 ? bearing(path[i - 1][0], path[i - 1][1], p0[0], p0[1]) : segBearing;
      const curHeading  = lerpHeading(prevBearing, segBearing, t);

      state.visualLat     = pos.lat;
      state.visualLon     = pos.lon;
      state.visualHeading = curHeading;

      // ── Push to app.js via callback ──
      if (state.onLocationUpdate) {
        state.onLocationUpdate(pos.lat, pos.lon, curHeading, state.aligned);
      }

      // ── Schedule next frame or stop ──
      if (state.animIndex < path.length - 1 || state.animProgress < 1) {
        state.animFrame = requestAnimationFrame(step);
      } else {
        state.animFrame = null;
      }
    }

    state.animFrame = requestAnimationFrame(step);
  }

  /* ═══════════════════════════════════════════
     SECTION 6 — VEHICLE-ROAD ALIGNMENT
  ═══════════════════════════════════════════ */

  function checkAlignment(vehicleHeading, roadBearing) {
    const diff            = headingDiff(vehicleHeading, roadBearing);
    const oppositeAligned = headingDiff(vehicleHeading, (roadBearing + 180) % 360) < 45;
    return {
      aligned:       diff < 45 || oppositeAligned,
      sameDirection: diff < 45,
      diff
    };
  }

  /* ═══════════════════════════════════════════
     SECTION 7 — FIREBASE LOCATION WRITE
  ═══════════════════════════════════════════ */

  async function writeEnrichedLocation(lat, lon, heading, aligned) {
    if (!state.dbRef || !state.userRef) return;
    try {
      const { setDoc, doc, serverTimestamp } = await import("./firebase-config.js");
      await setDoc(
        doc(state.dbRef, "active_users", state.userRef.uid),
        { lat, lon, heading: Math.round(heading), aligned, updatedAt: serverTimestamp() },
        { merge: true }
      );
    } catch (e) {
      console.warn("[DirectionEngine] Firebase write error:", e.message);
    }
  }

  /* ═══════════════════════════════════════════
     SECTION 8 — DIRECTION-BASED FILTERING
  ═══════════════════════════════════════════ */

  function classifyVehicle(myHeading, theirHeading) {
    if (theirHeading === undefined || theirHeading === null) {
      return { relevant: true, riskLevel: "medium" };
    }
    const diff = headingDiff(myHeading, theirHeading);
    if (diff < 45)        return { relevant: true,  riskLevel: "high"   };
    if (diff < 90)        return { relevant: true,  riskLevel: "medium" };
    if (diff > 135)       return { relevant: true,  riskLevel: "medium" };
    return                       { relevant: false, riskLevel: "low"    };
  }

  /* ═══════════════════════════════════════════
     SECTION 9 — LEAFLET ARROW MARKERS
  ═══════════════════════════════════════════ */

  const RISK_COLORS = { high: "#ef4444", medium: "#f59e0b", low: "#6b7280" };

  function buildArrowIcon(heading, riskLevel, isMe = false) {
    const color = isMe ? "#38bdf8" : RISK_COLORS[riskLevel] || "#6b7280";
    const size  = isMe ? 36 : 30;
    const svg   = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 36 36"
           style="transform:rotate(${heading}deg);display:block;">
        <polygon points="18,2 28,32 18,25 8,32"
                 fill="${color}" stroke="white" stroke-width="2" opacity="0.92"/>
      </svg>`;
    return L.divIcon({ html: svg, className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }

  function upsertVehicleMarker(uid, lat, lon, heading, riskLevel, popupText) {
    if (!state.mapRef) return;
    const icon = buildArrowIcon(heading, riskLevel);
    if (state.nearbyMarkers.has(uid)) {
      const m = state.nearbyMarkers.get(uid);
      m.setLatLng([lat, lon]);
      m.setIcon(icon);
      m.getPopup()?.setContent(popupText);
    } else {
      const marker = L.marker([lat, lon], { icon }).addTo(state.mapRef).bindPopup(popupText);
      state.nearbyMarkers.set(uid, marker);
    }
  }

  function pruneStaleMarkers(activeUids) {
    for (const [uid, marker] of state.nearbyMarkers) {
      if (!activeUids.has(uid)) {
        state.mapRef?.removeLayer(marker);
        state.nearbyMarkers.delete(uid);
      }
    }
  }

  /* ═══════════════════════════════════════════
     SECTION 10 — MAIN TRACKING LOOP (UPGRADED)
  ═══════════════════════════════════════════ */

  /** Whether this is the very first GPS fix (forces immediate OSRM snap) */
  let _firstFix = true;

  /**
   * Core tracking cycle — called every TRACK_INTERVAL_MS.
   *
   * Flow:
   *   GPS position → noise filter → heading update → OSRM match (snap) →
   *   OSRM route (road geometry) → animateAlongPath → Firebase write
   */
  async function trackingCycle() {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;

        // ── 1. Noise filter (skip first fix so we always initialise) ──
        if (!_firstFix && state.currentPosition) {
          const moved = distanceMetres(state.currentPosition.lat, state.currentPosition.lon, lat, lon);
          if (moved < NOISE_THRESHOLD_M) return;
        }

        // ── 2. Heading ────────────────────────────────────────────────
        let heading = state.smoothedHeading;
        if (state.currentPosition) {
          heading = updateHeading(state.currentPosition.lat, state.currentPosition.lon, lat, lon);
        }

        // ── 3. Shift position history ─────────────────────────────────
        state.prevPosition    = state.currentPosition;
        state.currentPosition = { lat, lon };

        state.recentGPSPoints.push({ lat, lon });
        if (state.recentGPSPoints.length > 5) state.recentGPSPoints.shift();

        // ── 4. OSRM Match (snap to road) ──────────────────────────────
        if (state.prevPosition) {
          state.distanceSinceOSRM += distanceMetres(
            state.prevPosition.lat, state.prevPosition.lon, lat, lon
          );
        }

        let snappedLat = lat;
        let snappedLon = lon;

        const shouldSnap = _firstFix || state.distanceSinceOSRM >= OSRM_TRIGGER_M;

        if (shouldSnap && state.recentGPSPoints.length >= 2) {
          const matchResult = await callOSRMMatch(state.recentGPSPoints);
          if (matchResult) {
            snappedLat          = matchResult.snappedLat;
            snappedLon          = matchResult.snappedLon;
            state.roadBearing   = matchResult.roadBearing;
            state.snappedPosition = { lat: snappedLat, lon: snappedLon };
            state.lastOSRMSnap  = { lat: snappedLat, lon: snappedLon };
            const align         = checkAlignment(heading, matchResult.roadBearing);
            state.aligned       = align.aligned;
          }
          state.distanceSinceOSRM = 0;
        } else if (state.lastOSRMSnap) {
          snappedLat = state.lastOSRMSnap.lat;
          snappedLon = state.lastOSRMSnap.lon;
        }

        // ── 5. OSRM Route (road geometry for animation) ───────────────
        //    Only fetch route if we have a previous snapped position to route FROM
        let routePath = null;
        const prevSnap = state.snappedPosition;   // position BEFORE this update
        const prevSnapRef = { ...state.lastOSRMSnap }; // copy before mutating

        if (state.visualLat !== null && (snappedLat !== state.visualLat || snappedLon !== state.visualLon)) {
          const fromLat = state.visualLat;
          const fromLon = state.visualLon;
          routePath = await fetchRouteGeometry(fromLat, fromLon, snappedLat, snappedLon);
        } else if (_firstFix) {
          // First fix: no route needed, just teleport to start position
          routePath = [[snappedLat, snappedLon]];
        }

        // ── 6. Animate or initialise ──────────────────────────────────
        if (routePath && routePath.length >= 2) {
          // Adapt speed based on distance (longer routes → faster perceived speed)
          const routeDistM = distanceMetres(
            routePath[0][0], routePath[0][1],
            routePath[routePath.length - 1][0], routePath[routePath.length - 1][1]
          );
          // Scale speed so animation completes in ~TRACK_INTERVAL_MS seconds
          const targetSpeedMps = Math.max(5, Math.min(30, routeDistM / (TRACK_INTERVAL_MS / 1000)));
          state.animSpeedMps   = targetSpeedMps;

          animateAlongPath(routePath, targetSpeedMps);

        } else if (_firstFix || state.visualLat === null) {
          // Initialise visual position without animation
          state.visualLat     = snappedLat;
          state.visualLon     = snappedLon;
          state.visualHeading = heading;
          if (state.onLocationUpdate) {
            state.onLocationUpdate(snappedLat, snappedLon, heading, state.aligned);
          }
        }

        _firstFix = false;

        // ── 7. Firebase write (snapped coords + heading) ──────────────
        await writeEnrichedLocation(snappedLat, snappedLon, heading, state.aligned);
      },
      (err) => console.warn("[DirectionEngine] GPS error:", err.message),
      { timeout: 5000, maximumAge: 0, enableHighAccuracy: true }
    );
  }

  /* ═══════════════════════════════════════════
     SECTION 11 — NEARBY VEHICLES RENDERER
  ═══════════════════════════════════════════ */

  function renderNearbyVehicles(vehicles) {
    const activeUids = new Set();
    for (const v of vehicles) {
      if (!v.uid || !v.lat || !v.lon) continue;
      activeUids.add(v.uid);
      const { relevant, riskLevel } = classifyVehicle(state.smoothedHeading, v.heading);
      const headingStr = v.heading !== undefined ? `${Math.round(v.heading)}°` : "Unknown";
      const riskLabel  = riskLevel === "high" ? "🔴 High Risk" : riskLevel === "medium" ? "🟡 Medium Risk" : "⚪ Low Risk";
      const popup      = `🚗 Nearby Vehicle<br/>Heading: ${headingStr}<br/>${riskLabel}`;
      if (!relevant) {
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

  function init({ map = null, db, currentUser, onLocationUpdate = null }) {
    state.mapRef           = map;
    state.dbRef            = db;
    state.userRef          = currentUser;
    state.onLocationUpdate = onLocationUpdate;
    _firstFix              = true;

    if (state.trackInterval) clearInterval(state.trackInterval);
    state.trackInterval = setInterval(trackingCycle, TRACK_INTERVAL_MS);

    // Run once immediately
    trackingCycle();
    console.log("[DirectionEngine] Initialized ✓ (road-following animation enabled)");
  }

  function setMap(mapInstance) { state.mapRef = mapInstance; }

  function stop() {
    if (state.trackInterval) { clearInterval(state.trackInterval); state.trackInterval = null; }
    if (state.animFrame)     { cancelAnimationFrame(state.animFrame); state.animFrame = null; }
  }

  function getHeading()        { return state.smoothedHeading; }
  function getSnappedPosition(){ return state.snappedPosition || state.currentPosition; }
  function isAligned()         { return state.aligned; }
  function classify(myH, theirH){ return classifyVehicle(myH, theirH); }

  return {
    init,
    setMap,
    stop,
    getHeading,
    getSnappedPosition,
    isAligned,
    renderNearbyVehicles,
    classify,
    headingDiff,
    // Exposed for testing / external use
    fetchRouteGeometry,
    animateAlongPath,
  };

})();