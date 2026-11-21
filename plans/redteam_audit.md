# Krunked Sky-Map — Boost-Grade Adversarial Red-Team Audit

**Auditor:** `@astro-redteam`  
**Branch / Worktree:** `track/astro-redteam` (`c:\krunked_skymap\.worktrees\astro-redteam`)  
**Scope:** End-to-end physics, geodesy, SGP4 astrodynamics, multi-API fault tolerance, 60fps memory hygiene, lifecycle cleanup, and cockpit UX audit.

---

## Executive Severity Summary

| Severity | Count | Key Themes |
| :--- | :---: | :--- |
| **Critical** | **2** | Worker crash on decayed SGP4 propagation (`[DEFECT-01]`); satellite ID prefix mismatch (`sat:` vs `sat-`) disabling all orbital ground tracks & pass arcs (`[DEFECT-03]`) |
| **High** | **6** | Polar geodesic polygon 360° antimeridian jump (`[DEFECT-02]`); 5-min balloon pruning dropping valid 3h SondeHub sondes (`[DEFECT-04]`); OpenDroneID disconnect/WS retention bugs (`[DEFECT-06]`); PolarSkyDome/TacticalMap cursor & hover leaks (`[DEFECT-07]`); duplicate audio triggers + missing OrbitOverlay layer gating (`[DEFECT-08]`); hanging `AstroClient.computeOrbit` on worker error (`[DEFECT-10]`) |
| **Medium** | **6** | Permalink `alt`/`label` clobbering & NM orbital unit mismatch (`[DEFECT-05]`); `flightsService` cooldown status masking/bypass & antimeridian bbox (`[DEFECT-09]`); ControlDock dropdown re-open (`[DEFECT-11]`); hidden-pane 60fps CPU/GPU waste (`[DEFECT-12]`); ArcGIS partial-failure & ODID flag sync (`[DEFECT-13]`); SondeHub partial error masking (`[DEFECT-14]`) |
| **Low** | **4** | Stale selected target ID & cold-boot `workerReady` race (`[DEFECT-15]`); Bennett `-1°` cut-on step (`[DEFECT-16]`); `-5°` pass-arc clipping (`[DEFECT-17]`); modal timeout cleanup & duplicated helpers (`[DEFECT-18]`) |
| **Total** | **18** | **13 passing** + **10 intentional failing `[DEFECT-*]` probes** in [chaos.test.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/tests/adversarial/chaos.test.ts) |

---

## Challenge Verification Matrix (Observed Test Results)

Toolchains verified inside `c:\krunked_skymap\.worktrees\astro-redteam`:
- `npx tsc --noEmit` -> **PASS (exit 0)**
- `npx vitest run tests/unit/math.test.ts tests/unit/ingest.test.ts --pool=vmThreads` -> **36 / 36 PASS (647ms)**
- `npx vitest run tests/adversarial/chaos.test.ts --pool=vmThreads` -> **23 tests: 13 PASS, 10 FAIL (`[DEFECT-01]`..`[DEFECT-10]` real defect probes)**

### Challenge 1 — Extreme Geodesy & Antimeridian Torture
- **Verified Passing:**
  - `computeTopocentricLookAngles`, `greatCircleDestination`, `haversineDistanceKm`, `computeBearingDeg`, `normalizeLonDeg`: zero `NaN`/`Infinity` across Equator `(0, 0)`, Svalbard `(78.22, 15.63)`, Sydney `(-33.86, 151.20)`, South Pole `(-89.99, 0)`, and Antimeridian `(0, 179.95)` / `(0, -179.95)`. Cross-antimeridian short path `(0, 179.95) -> (0, -179.95)` verified at `11.12 km` @ `90°` East.
  - `splitAntimeridianLine`: splits multi-crossing zig-zags and exact `±180°` boundaries with zero `> 180°` jumps.
  - `computeSatelliteOrbitOverlay`: ISS, polar (`NOAA 19`), and equatorial (`EQUA-LEO`) tracks across all 6 observers yield zero `NaN`s and zero `> 180°` segment jumps.
  - `geodesicCirclePolygon`: clean on all non-polar observers (`0, 0`, `-33.86, 151.2`, `78.22, 15.63 @ 250km`, `0, ±179.95`).
- **Broken / Failed (`[DEFECT-02]`):**
  - `geodesicCirclePolygon(-89.99, 0, 120, 72)` and `geodesicCirclePolygon(78.22, 15.63, 2200, 72)` insert `[-180, poleLat]` directly next to `[180, poleLat]`, creating a **360° longitude jump (`|Δlon| = 360 > 180`)** at the polar seam.

### Challenge 2 — WGS-84 Curvature Horizon & Bennett Refraction Bounds
- **Verified Passing:**
  - At `250 km` ground distance across all 6 observers & 4 cardinal bearings: `1,500 m` target yields `elevationDeg < 0` (`belowHorizon === true`) with both `applyRefraction = false` and `true`; `12,000 m` yields `elevationDeg > 0` (`belowHorizon === false`).
  - Sweep of geometric elevations across `[-90°, 90°]` confirms `applyRefraction = true` remains bounded in `[-90, 90]`, finite, and monotonically non-decreasing (with a noted 0.83° cut-on step at `-1.0°`, `[DEFECT-16]`).

### Challenge 3 — SGP4 Resilience & 2,000-Satellite Latency Budget
- **Verified Passing:**
  - `parseTleText` + `parseTleRecords` + `propagateSatellites`: survives short lines, garbage epochs, zero mean motion, hyperbolic eccentricity, mismatched NORAD IDs, Alpha-5 IDs, empty/null records alongside valid ISS/NOAA-19 TLEs with zero NaNs.
  - **2,000-Satellite Benchmark:** Observed median batch propagation across 5 runs = **`44.49 ms`** (samples: `46.53, 46.10, 44.49, 43.19, 42.87 ms`, `96` visible satellites), well under the `100 ms` budget, with strict `SAT_KINEMATICS_STRIDE = 12` `Float32Array` packing and clean `unpackSatelliteKinematics` round-trip.
- **Broken / Failed (`[DEFECT-01]`):**
  - Feeding a decayed TLE (`DECAYED ANCIENT SAT`, NORAD `90007`) into `computeSatelliteOrbitOverlay` throws an unhandled **`TypeError: Cannot read properties of undefined (reading 'x')`** in `isFiniteVec3(pv.position)` (`src/workers/astro.worker.ts:54,414`).

### Challenge 4 — Multi-API Blackout & Malformed Payload Chaos
- **Verified Passing:**
  - Under `TypeError('Failed to fetch')`, HTTP `429`, HTTP `503`, and truncated/corrupt JSON across `flightsService`, `balloonsService`, `airspaceService`, and `satellitesService` (with `public/data/*` fallback assets served, plus total blackout with `./data/*` also failing): zero uncaught rejections; `flightsService` -> `'fallback'`, `airspaceService` (US) -> `'fallback'`, `satellitesService` -> `'fallback'`, `balloonsService` -> `'error'`.
  - ADS-B edge cases verified: `alt_baro: "ground"` -> `onGround: true, altM: 0`; Dead Sea `-390 m` (`alt_baro`/`alt_geom: -1279.5 ft`) -> `-390 m`; `lat: undefined` -> `null`; `track: null` -> `headingDeg: 0`; `dbFlags` `1` (`isMilitary`), `4` (`isPia`), `8` (`isLadd`); Heathrow `(51.47, -0.4543)` -> `usCoverage: false` with zero ArcGIS requests.
- **Broken / Failed (`[DEFECT-09]`):**
  - When all live ADS-B providers fail (`status: 'fallback'`), `adsbRateLimiter.tryConsume` has already consumed the token without populating `lastCachedFlightsByKey`. A second non-forced call within 10s with `prevEntities` masks `status` as `'cached'` (`rate-limit-cache`), while a call without `prevEntities` bypasses the rate limiter and re-triggers the full fetch cascade.

### Challenge 5 — 60fps Memory Hygiene & Cleanup Inspection
- **Verified Passing:**
  - Across **100 consecutive updates**, `trail` lengths stay strictly `<= 40` on `flightsService` (`<= 24`), `balloonsService` (`<= 24`), `openDroneIdService` sim & live (`<= 24`), and `unpackSatelliteKinematics` (`40`).
  - `AstroClient.dispose()` terminates the worker and nulls `onmessage`/`onerror`.
  - `OpenDroneIdClient.disconnect()` closes WebSocket, nulls all 4 WS handlers, clears `pollTimer`, and aborts `AbortController`.
  - `TacticalAudioEngine` stays muted by default and cleans up graph/subscriber on `dispose()`.
  - MapLibre sources in `TacticalMap.tsx` are registered once on `load` and updated via `.setData()` (no source recreation leak).
- **Broken / Failed (`[DEFECT-03]`..`[DEFECT-08]`, `[DEFECT-10]`):**
  - 7 concrete runtime/UX/lifecycle defects verified by probes and documented in full below.

---

## Detailed Defect Registry & Surgical Fix Directives

### Critical Defects

#### `[DEFECT-01]` SGP4 Crash on Decayed/Failed Propagation (`undefined` Position Vector)
- **Location:** [astro.worker.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/workers/astro.worker.ts#L53-L55), [astro.worker.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/workers/astro.worker.ts#L277-L286), [astro.worker.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/workers/astro.worker.ts#L411-L416)
- **Root Cause:** `satellite.js` v5 returns `{ position: undefined, velocity: undefined }` (or `undefined`) when SGP4 propagation fails/decays. `isFiniteVec3(v)` dereferences `v.x` without checking `!v || typeof v !== 'object'`. `computeSatelliteOrbitOverlay` checks `typeof pv.position === 'boolean'` then calls `isFiniteVec3(pv.position)` without checking `sat.satrec.error !== 0` or `!pv.position`, throwing `TypeError: Cannot read properties of undefined (reading 'x')`.
- **Surgical Fix:** Guard `isFiniteVec3(v: unknown)` with `Boolean(v && typeof v === 'object' && Number.isFinite((v as ...).x) && ...)` and check `!pv || sat.satrec.error !== 0 || !pv.position || typeof pv.position === 'boolean'` in both `propagateSatellites` and `computeSatelliteOrbitOverlay` (plus reset `sat.satrec.error = 0` or clone `satrec` if needed across epochs).

#### `[DEFECT-03]` Satellite ID Prefix Mismatch (`'sat:'` vs `'sat-'`) Disables All Orbit Overlays
- **Location:** [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L338-L360) vs [astro.worker.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/workers/astro.worker.ts#L150) & [astroClient.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/workers/astroClient.ts#L89)
- **Root Cause:** Satellites are emitted with `id: \`sat-${noradId}\`` (e.g. `sat-25544`), matching `TacticalMap.tsx:452` and `PolarSkyDome.tsx:432`. However, `App.tsx:340` checks `if (!selectedId || !selectedId.startsWith('sat:'))`, so selecting ANY satellite never triggers `client.computeOrbit(...)` and forces `liveKinematicsRegistry.orbitOverlay = null`.
- **Surgical Fix:** Change `selectedId.startsWith('sat:')` to `selectedId.startsWith('sat-')` (and verify `selectedId.slice(4)` parses the NORAD ID cleanly).

---

### High Severity Defects

#### `[DEFECT-02]` `geodesicCirclePolygon` Emits 360° Longitude Jump Around Poles
- **Location:** [geodesy.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/math/geodesy.ts#L449-L470)
- **Root Cause:** When `enclosesNorthPole || enclosesSouthPole` is true (e.g. South Pole `(-89.99, 0)` with `120 km` scan ring or Svalbard `(78.22, 15.63)` with `2,200 km` satellite footprint), lines 461–464 push `[endEdgeLon, poleLat]` (`-180`) followed immediately by `[startEdgeLon, poleLat]` (`+180`), jumping `360° > 180°` between consecutive vertices. Also, lines 453–456 mis-order segments if `split.length >= 3`.
- **Surgical Fix:** When traversing the polar edge from `endEdgeLon` to `startEdgeLon`, insert intermediate vertices along `poleLat` (`[-90, poleLat], [0, poleLat], [90, poleLat]` in direction of traversal) so every consecutive step is `<= 90°`, and handle `split.length >= 2` by concatenating ordered seam-connected segments rather than only `split[last] + split[0]`.

#### `[DEFECT-04]` `App.tsx` Prunes Active SondeHub Balloons After 5 Minutes Despite 3h/6h Query Window
- **Location:** [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L728) vs [balloonsService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/balloonsService.ts#L198,L263-L264)
- **Root Cause:** `balloonsService.ts` queries `/sondes?...&last=10800` (3h) and `/amateur?last=21600` (6h) and assigns `timestampMs = Date.parse(raw.datetime)`. `App.tsx:728` passes `pruneStaleMs = 300_000` (5 min) to `pushAtmospheric`, immediately deleting valid radiosondes older than 5 minutes on the very next rAF frame while `feeds.balloons.count` in `ControlDock` still shows the pre-pruned count.
- **Surgical Fix:** Increase balloon `pruneStaleMs` in `App.tsx:728` to `>= 10_800_000` (3 hours, or `21_600_000` to match `/amateur`), and sync `feeds.*.count` when entities are pruned.

#### `[DEFECT-06]` OpenDroneID Disconnect Leak, WS Frame Overwrite & Unbounded `latestDrones` Map
- **Location:** [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L511-L536,L562-L577) & [openDroneIdService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/openDroneIdService.ts#L540,L614-L622,L668-L676)
- **Root Cause:**
  1. `App.tsx:533-536` calls `client.disconnect()` without clearing `liveWebhookDronesRef.current`, so `tickDrones()` (`line 562`) keeps resurrecting disconnected webhook drones every 1s.
  2. `App.tsx:511-517` replaces `liveWebhookDronesRef.current` wholesale on each `onDrones` callback; in WebSocket mode where one ASTM F3411 packet arrives per frame, Drone B erases Drone A.
  3. `OpenDroneIdClient.latestDrones` never prunes stale drones (`>120s`), leaking memory over long sessions.
- **Surgical Fix:** Clear `liveWebhookDronesRef.current.clear()` on disconnect cleanup in `App.tsx`; merge incoming drones into `liveWebhookDronesRef.current` with `>120s` stale eviction; prune `this.latestDrones` entries older than `120_000 ms` inside `OpenDroneIdClient`.

#### `[DEFECT-07]` PolarSkyDome Cursor Conflict & TacticalMap Stale Hover/Cursor Leaks
- **Location:** [PolarSkyDome.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/skydome/PolarSkyDome.tsx#L1395-L1433,L1541) & [TacticalMap.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/map/TacticalMap.tsx#L1226-L1236) & [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L716)
- **Root Cause:**
  1. `PolarSkyDome.tsx:1541` sets JSX inline `style={{ ..., cursor: 'crosshair' }}` while `handleMouseMove` (`line 1397`) mutates `canvas.style.cursor = 'pointer'`. React re-renders overwrite `'pointer'`, and if a hovered target vanishes or its layer is hidden without mouse movement, `canvas.style.cursor` and `hoveredId` remain stuck.
  2. `App.tsx:716` keeps hidden-layer entities inside `liveKinematicsRegistry.entities`, and `TacticalMap.tsx:1226-1236` only checks `entities.get(hc.id)` without checking `state.layers[hoveredEntity.category]` and never resets `state.setHoveredId(null)` or `activeMap.getCanvas().style.cursor = ''`.
- **Surgical Fix:** Drive `PolarSkyDome` canvas cursor via a dedicated ref/state outside JSX inline style override, clear cursor/hover in `renderFrame` when `hoveredId` is no longer in `nextHits`, and in `TacticalMap.tsx` check `state.layers[hoveredEntity.category]` + clear `state.setHoveredId(null)` and `canvas.style.cursor = ''` when a hovered entity disappears or hides.

#### `[DEFECT-08]` Duplicate Acoustic Triggers, Missing `OrbitOverlay` Layer Gating & Uncleaned AudioContext
- **Location:** [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L480,L611,L641-L671,L722,L769), [PolarSkyDome.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/skydome/PolarSkyDome.tsx#L891,L1002,L1047-L1070,L1416), [TacticalMap.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/map/TacticalMap.tsx#L428-L487,L1192-L1199)
- **Root Cause:**
  1. Both `App.tsx` and `PolarSkyDome.tsx` independently call `tacticalAudio.playSweepPulse()`, `playTargetLock()`, `playZenithChime()` (at conflicting thresholds: `75°` vs `65°`), and `playAlertTone()`. `App.tsx` also updates `zenithNotifiedRef`/`alertNotifiedRef` while `audioEnabled === false` and never calls `tacticalAudio.dispose()` on unmount.
  2. Neither `TacticalMap.buildOrbitOverlayFc()` nor `PolarSkyDome.drawOrbitPassArc()` checks `state.layers.satellite`, leaving the orbital ground track, footprint, and pass arc visible when `Active Satellites` is toggled off.
- **Surgical Fix:** Centralize all `tacticalAudio` event triggers in `App.tsx` (gating on `st.audioEnabled`, unifying thresholds, checking `st.satGroups`, and disposing `tacticalAudio.dispose()` on unmount); gate `OrbitOverlay` rendering on `state.layers.satellite` in both `TacticalMap` and `PolarSkyDome`.

#### `[DEFECT-10]` `AstroClient.computeOrbit` & `initTles` Hang Forever on Worker Error Messages
- **Location:** [astroClient.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/workers/astroClient.ts#L239-L243)
- **Root Cause:** When `astro.worker.ts` posts `{ type: 'error', message }`, `AstroClient.handleWorkerMessage` resets `tickInFlight = false` and invokes `onError`, but leaves `this.readyResolvers` and `this.orbitResolvers` pending indefinitely.
- **Surgical Fix:** In `case 'error'`, reject (or resolve empty fallback via `resolveEmptyPending()` / `rejectPending(new Error(msg))`) pending `readyResolvers` and `orbitResolvers` cleanly.

---

### Medium Severity Defects

#### `[DEFECT-05]` URL Hash Drops `label` & `alt`, and `TargetInspector` Displays Orbital Altitude in `NM`
- **Location:** [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L108-L123), [TargetInspector.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/inspector/TargetInspector.tsx#L95-L103), [unitFormatters.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/inspector/unitFormatters.ts#L35-L64,L127-L132)
- **Root Cause:** `parseUrlHashPatch()` reads `alt` and `label`, but `buildUrlHashString()` omits both, erasing custom location labels & elevations 400ms after page load (and `App.tsx` has no `hashchange` listener). Meanwhile, `unitFormatters.ts` formats ISS `420,000 m` altitude in aviation mode as `226.8 NM`, speed `7,660 m/s` as `14,890 kt`, and Doppler `8,420 Hz` as `+8,420 Hz` (diverging from `src/math/units.ts` and `TacticalMap.tsx`).
- **Surgical Fix:** Include `alt` and `label` in `buildUrlHashString()` and `TargetInspector.handleCopyPermalink()`; add a `hashchange` listener in `App.tsx`; align `unitFormatters.ts` orbital altitude (`>= 100 km -> km`), orbital speed (`>= 1500 m/s -> km/s`), and Doppler (`>= 1000 Hz -> kHz`) with `src/math/units.ts`.

#### `[DEFECT-09]` `flightsService` Cooldown Status Masking / Rate-Limit Bypass & Polar/Antimeridian OpenSky BBox
- **Location:** [flightsService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/flightsService.ts#L723-L743,L836-L844)
- **Root Cause:** `adsbRateLimiter.tryConsume(rateKey)` runs before fallback, never populates `lastCachedFlightsByKey` on `'fallback'`, masks `'fallback'` as `'cached'` when `prevEntities` is passed, and falls through to network requests when `prevEntities` is empty. Also, `rateKey` omits `radiusKm`, and OpenSky `lomin`/`lomax` clamp to `[-180, 180]` (truncating antimeridian/polar queries).
- **Surgical Fix:** Cache fallback status/entities or track last result per `(rateKey, radiusKm)` with its true `status`, enforce cooldown even when `prevMap.size === 0` (returning cached `[]` or fallback), and widen/wrap OpenSky query boxes at `±180°` and high latitudes (`lat > 85°` -> `[-180, 180]`).

#### `[DEFECT-11]` `ControlDock` Search Dropdown Re-Opens 300ms After Location Selection
- **Location:** [ControlDock.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/ControlDock.tsx#L169-L223)
- **Root Cause:** `selectSearchResult` calls `setQuery(item.label)` and `setDropdownOpen(false)`, which triggers the `useEffect([query, runSearch])` debouncer 300ms later to re-query `item.label` and re-open `dropdownOpen(true)`.
- **Surgical Fix:** Track a `suppressNextSearchRef` (or `lastSelectedQueryRef`) set inside `selectSearchResult` and checked in the `useEffect([query])` hook.

#### `[DEFECT-12]` Hidden-Pane 60fps CPU/GPU Overhead & Polar Map Ring Distortion
- **Location:** [TacticalMap.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/map/TacticalMap.tsx#L245,L1142-L1237), [PolarSkyDome.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/skydome/PolarSkyDome.tsx#L1050-L1070,L1156-L1180)
- **Root Cause:**
  1. `TacticalMap.tsx` keeps rebuilding GeoJSON and calling `.setData()` at 60fps even when `state.layout === 'dome'` (`display: none`), and `buildGeodesicCircle` clamps latitudes to `[-85.05, 85.05]`, distorting polar scan rings at `(-89.99, 0)`.
  2. `PolarSkyDome.tsx` recomputes `computeLookAnglesWgs84` on up to 10 trail points per entity per frame (`~6,000` ECEF+ENU transforms/frame with 600 satellites) and leaves `zenithChimedRef`/`hazardAlertedRef` unbounded until observer switches.
- **Surgical Fix:** Skip GeoJSON `setData()` updates in `TacticalMap.frameLoop` while `state.layout === 'dome'` (forcing one sync on layout switch back); import shared geodesy from `src/math/geodesy.ts`; cache or throttle trail topocentric projection in `PolarSkyDome` and prune `zenithChimedRef`/`hazardAlertedRef` when `size > 200`.

#### `[DEFECT-13]` ArcGIS Partial Failure Masking, Broad `tfrBreach` Classification & Stale `emergencyFlag`
- **Location:** [airspaceService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/airspaceService.ts#L225-L246,L315-L329), [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L570-L575)
- **Root Cause:** If `uasfm` returns HTTP `429`/`503` while `boundary` returns `200 []`, `anySuccess` is `true` and `fetchAirspace` reports `status: 'live'` with empty UASFM data instead of falling back. `isLowAltitudeTfrOrRestricted` treats `'A'`/`'W'` zones lacking `LOWER_VAL` as breaches and ignores `LOWER_VAL` on `'P'`/`'R'`. `App.tsx:570` recomputes `ceilingBreach`/`tfrBreach` on live ODID drones without updating `emergencyFlag`.
- **Surgical Fix:** Require primary `uasfm` (or non-empty fallback trigger) when `uasfm` fails; refine `isLowAltitudeTfrOrRestricted` to respect `LOWER_VAL` floors and restrict `'A'`/`'W'` non-prohibitive alerts; recompute `emergencyFlag` alongside compliance in `App.tsx:570`.

#### `[DEFECT-14]` SondeHub Partial Endpoint Failure & Unprotected Widened Query
- **Location:** [balloonsService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/balloonsService.ts#L277-L365)
- **Root Cause:** If `/sondes` rejects (`503`/`429`) while `/amateur` returns `{}`, `fetchBalloons` returns `status: 'live', entities: []` with no `errorMsg`. The widened `distance=1000000` hint query also bypasses `balloonsCircuitBreaker`.
- **Surgical Fix:** Surface partial rejection `errorMsg` (or `'error'` when `/sondes` fails and `/amateur` is empty) and route the widened query through `balloonsCircuitBreaker`.

---

### Low Severity Defects

#### `[DEFECT-15]` Stale Selected Entity ID Stickiness & Cold-Boot `workerReady` Race
- **Location:** [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L248-L252,L338-L360,L799-L804)
- **Root Cause:** When a selected aircraft is pruned after `>120s`, `selectedEntitySnapshot` becomes `null` while `selectedId` and `followSelected` remain active. Additionally, `#selected=sat-25544` URL hydration calls `computeOrbit` before `workerReady` becomes `true`, and `onOrbitOverlay` lacks a `selectedId` check against stale async responses.
- **Surgical Fix:** Add `workerReady` to the `computeOrbit` effect dependencies, check `useSkyStore.getState().selectedId === \`sat-${overlay.noradId}\`` inside `onOrbitOverlay`, and clear `selectedId` if missing for longer than a brief grace window after initial feed load.

#### `[DEFECT-16]` Bennett Atmospheric Refraction `-1.0°` Threshold Discontinuity
- **Location:** [geodesy.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/math/geodesy.ts#L157-L163)
- **Root Cause:** Hard gate `elevationDeg > -1` causes an instantaneous `+0.83°` jump between `-1.001°` (unrefracted) and `-0.999°` (`+0.83°` refraction). Function remains strictly monotonically non-decreasing and bounded in `[-90, 90]`.
- **Surgical Fix:** Optional smooth cosine/linear ramp between `-2.0°` and `-0.5°` if continuous OTH atmospheric bending is desired.

#### `[DEFECT-17]` Dead `-5°` Pass-Arc Edge Interpolation in `PolarSkyDome`
- **Location:** [astro.worker.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/workers/astro.worker.ts#L440) & [PolarSkyDome.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/skydome/PolarSkyDome.tsx#L464-L480)
- **Root Cause:** `computeSatelliteOrbitOverlay` only emits `passArcAzEl` points with `elDeg >= -5`, leaving `PolarSkyDome`'s `pt.elDeg < EL_MIN` edge-interpolation code unreachable and stopping pass arcs up to ~1° shy of the `-5°` bezel.
- **Surgical Fix:** Emit points with `elDeg >= -12` (or include the immediately adjacent below-`-5°` sample before/after horizon crossings) so `PolarSkyDome` interpolates cleanly to the `-5°` outer ring.

#### `[DEFECT-18]` Minor Cleanup & Code Duplication
- **Location:** [OpenDroneIdModal.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/OpenDroneIdModal.tsx#L110), [flightsService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/flightsService.ts#L285-L294), [TacticalMap.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/map/TacticalMap.tsx#L117-L261), [PolarSkyDome.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/skydome/PolarSkyDome.tsx#L75-L160)
- **Root Cause:** `OpenDroneIdModal` leaves a `1800ms` `setTimeout` uncleaned on close/unmount; `classifyAirframeClass` has a redundant branch returning `'fast-mil'`; `TacticalMap` and `PolarSkyDome` reimplement `geodesy.ts` primitives locally.
- **Surgical Fix:** Store/clear timeout ref in `OpenDroneIdModal`, collapse redundant branch in `classifyAirframeClass`, and reuse `src/math/geodesy.ts` in UI components.


---

## Round 2 — Remediation & Verification Sign-Off

All 18 findings (`[DEFECT-01]`..`[DEFECT-18]`) identified in Round 1 were surgically remediated on `main`:

| Defect IDs | Files Updated | Verification Status |
| :--- | :--- | :--- |
| `[DEFECT-01]`, `[DEFECT-17]` | `src/workers/astro.worker.ts` | Fixed & Verified (`chaos.test.ts` Challenge 3 green; `-12°` pass-arc clipping margin) |
| `[DEFECT-02]`, `[DEFECT-16]` | `src/math/geodesy.ts` | Fixed & Verified (`chaos.test.ts` Challenge 1 & 2 green; smooth polar closure & Bennett ramp) |
| `[DEFECT-03]`, `[DEFECT-04]`, `[DEFECT-05]`, `[DEFECT-06]`, `[DEFECT-08]`, `[DEFECT-15]` | `src/App.tsx` | Fixed & Verified (`sat-` prefix match + `workerReady` dependency, `21_600_000 ms` balloon window, `alt`/`label` permalink + `hashchange`, WS merge + disconnect cleanup, centralized audio + `dispose()`) |
| `[DEFECT-05]`, `[DEFECT-11]`, `[DEFECT-18]` | `src/components/inspector/unitFormatters.ts`, `TargetInspector.tsx`, `ControlDock.tsx`, `OpenDroneIdModal.tsx` | Fixed & Verified (consistent orbital km / km/s / kHz formatting, permalink `alt`/`label`, post-pick dropdown suppression, timeout cleanup) |
| `[DEFECT-07]`, `[DEFECT-08]`, `[DEFECT-12]`, `[DEFECT-18]` | `src/components/skydome/PolarSkyDome.tsx`, `src/components/map/TacticalMap.tsx` | Fixed & Verified (shared `geodesy.ts` integration, `layers.satellite` OrbitOverlay gating, hidden-pane idle skip, clean hover/cursor reset) |
| `[DEFECT-06]`, `[DEFECT-09]`, `[DEFECT-13]`, `[DEFECT-14]`, `[DEFECT-18]` | `src/services/flightsService.ts`, `airspaceService.ts`, `balloonsService.ts`, `openDroneIdService.ts` | Fixed & Verified (status-preserving rate-limiter cache, primary UASFM fallback guard, `LOWER_VAL` floor checks, 120s ODID stale pruning) |
| `[DEFECT-10]` | `src/workers/astroClient.ts` | Fixed & Verified (`computeOrbit` & `initTles` promises reject cleanly on worker `error` messages) |

### Final Open Defect Tally
- **Critical:** **0**
- **High:** **0**
- **Medium:** **0**
- **Low:** **0**
