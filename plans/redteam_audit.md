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

---

## Sprint 02 — Live Telemetry, Render Overhaul & PWA Red-Team Audit

**Auditor:** `@astro-redteam`  
**Branch / Worktree:** `sprint/astro-redteam` (`c:\krunked_skymap\.worktrees\astro-redteam`)  
**Scope:** Merged Sprint 02 source files (`flightsService.ts`, `App.tsx`, `TacticalMap.tsx`, `tacticalSprites.ts`, `PolarSkyDome.tsx`, `TopTelemetryBar.tsx`, `ControlDock.tsx`, `TargetInspector.tsx`, `cockpit.css`, `public/manifest.json`, `public/sw.js`, `public/icons/*.png`, `index.html`, `vite.config.ts`) audited for phantom telemetry elimination, TTL/range/track pruning, MapLibre & Sky-Dome canvas/memory hygiene, PWA binary/service-worker integrity, offline/mobile UX desyncs, and rate-limiter consistency.

### Sprint 02 Open Defect Tally

| Severity | Count | Findings |
| :--- | :---: | :--- |
| **Critical** | **0** | None |
| **High** | **0** | None |
| **Medium** | **0** | None |
| **Low** | **2** | Stale prior-region `feeds.flights.lastUpdatedMs` retained across `> 50 km` observer jumps (`[DEFECT-S2-01]`); `{ force: true }` skipping `adsbRateLimiter.tryConsume` (`[DEFECT-S2-02]`) |
| **Total** | **2** | **21 passing** + **2 intentional failing `[DEFECT-S2-*]` probes** in [chaos.test.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/tests/adversarial/chaos.test.ts) |

### Sprint 02 Verification Summary (Verified Passing Controls)
1. **Zero Phantom Aircraft & Honest Live Feed Diagnostics:**
   - Verified `public/data/fallback-flights.json` is completely removed from disk (`fs.existsSync` returns `false`), `useSkyStore.getState().odidConfig.simulatorEnabled === false` by default, and `flightsService.ts` contains zero static seed/synthesis paths.
   - Under `TypeError('Failed to fetch')`, HTTP `429`, HTTP `503`, truncated JSON, and `navigator.onLine = false`, `fetchFlightsCascade` returns `entities: []` (or strictly verified `<= 45s` airborne in-range `prevEntities` as `'delayed'` / `'rate-limited'`), never requests `fallback-flights.json`, and surfaces honest `'rate-limited'`, `'offline'`, `'delayed'`, or `'error'` states.
   - Valid empty `{ ac: [] }` and OpenSky `{ states: [] }` responses return authoritative `'live'` `entities: []` immediately without exhausting downstream providers, and `buildOpenSkyBoxes` splits antimeridian bounding boxes cleanly while skipping polar regions (`|lat| > 88.5` / `dLon >= 180`).
2. **TTL, Landed & Out-of-Range Pruning + Zero-Track Drift Guard:**
   - `normalizeAdsbxAircraft`, `normalizeAdsbxPayloadList`, and `normalizeOpenSkyState` exclude `onGround: true`, `seen_pos > 60s`, stale `timestampMs > 60s`, future `timestampMs > nowMs + 60s`, Null Island `(0, 0)`, corrupt altitudes (`< -500 m` / `> 60_000 m`, preserving `-390 m` Dead Sea), and `groundDistKm > radiusKm`.
   - Missing track (`track: null` without `> 50 m` displacement from `prev`) sets `headingValid: false`. `App.tsx` (`922-927`, `973`), `TacticalMap.tsx` (`502-507`, `604`), `PolarSkyDome.tsx` (`1214-1231`), and `unitFormatters.ts` (`29-30`) gate dead-reckoning, velocity vectors, heading ticks, and inspector readouts (`TRACK UNKNOWN`) cleanly, alongside `60_000 ms` flight TTL and `radiusKm * 1.02` out-of-range pruning.
3. **PWA Manifest, Binary PNG & Service Worker Integrity:**
   - [manifest.json](file:///c:/krunked_skymap/.worktrees/astro-redteam/public/manifest.json) defines `start_url: "./"`, `scope: "./"`, `display: "standalone"`, `background_color: "#06090F"`, `theme_color: "#06090F"`, and `192x192` + `512x512` `image/png` icons with `"purpose": "any maskable"`.
   - Raw binary inspection of [icon-192.png](file:///c:/krunked_skymap/.worktrees/astro-redteam/public/icons/icon-192.png) (23,322 B), [icon-512.png](file:///c:/krunked_skymap/.worktrees/astro-redteam/public/icons/icon-512.png) (89,136 B), and [apple-touch-icon.png](file:///c:/krunked_skymap/.worktrees/astro-redteam/public/icons/apple-touch-icon.png) (20,787 B) confirms valid PNG magic signature (`89 50 4E 47 0D 0A 1A 0A`), valid `IHDR` / `IDAT` / `IEND` chunks, and exact big-endian `IHDR` dimensions (`192x192`, `512x512`, `180x180`).
   - VM sandbox execution of [sw.js](file:///c:/krunked_skymap/.worktrees/astro-redteam/public/sw.js) confirms `activate` prunes stale cache versions (`krunked-skymap-v1` deleted, `krunked-skymap-v2` retained), intercepts same-origin navigation/shell requests with `networkFirst`, and strictly bypasses cross-origin telemetry (`adsb.lol`, `opensky-network.org`, `sondehub.org`) and `/api-proxy/` routes.
   - [index.html](file:///c:/krunked_skymap/.worktrees/astro-redteam/index.html) and [vite.config.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/vite.config.ts) configure `./manifest.json`, `./icons/apple-touch-icon.png`, `#06090F` `theme-color`, `./sw.js` (`scope: './'`), `base: './'`, and `/api-proxy/` dev/preview routes (`npm run build` verified clean with relative `./assets/` paths).
4. **Render, Spatial Placement & Memory Hygiene:**
   - Both [PolarSkyDome.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/skydome/PolarSkyDome.tsx#L978-L982) and [TacticalMap.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/map/TacticalMap.tsx#L1082-L1086) reset transforms to identity (`setTransform(1, 0, 0, 1, 0, 0)`) prior to `clearRect(0, 0, canvas.width, canvas.height)`.
   - `PolarSkyDome.tsx` (`1080-1090`) prunes `polarTrailsRef` and `lastTrailSampleRef` immediately (`!activeIds.has(key)`) with zero `+ 40` slack.
   - `TacticalMap.tsx` enforces `maxPitch: 0`, `touchPitch: false`, `pitchWithRotate: false` (`1025-1028`), syncs `recenterNonce` both post-`load` and reactively (`1368`, `1643`, `1667`), deduplicates entity features via `seenIds` (`489-495`, `571-577`), registers 96x96 `pixelRatio: 3` Retina sprites (`tacticalSprites.ts:21,53`), and cleans up all map events, `webglcontextlost`, `ResizeObserver`, window `resize`, and `requestAnimationFrame` on unmount (`1588-1621`).

---

### Sprint 02 Defect Registry & Surgical Fix Directives

#### `[DEFECT-S2-01]` Low — Cross-Region Observer Jump (`> 50 km`) Retains Prior Region's `feeds.flights.lastUpdatedMs` on Offline/Failure
- **Location:** [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L486-L502), [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L595-L604)
- **Reproduction:**
  1. Load the app on **DC / Potomac Corridor** while online so `feeds.flights.lastUpdatedMs` records `T_DC` (e.g., `14:00:00`).
  2. Go offline (or simulate upstream `503`/`429`) and switch observer preset to **Tokyo Haneda / Kanto** (`jumpKm > 50`).
  3. `App.tsx:596` immediately clears `rawFlights`, `rawBalloons`, and `rawDrones`, and calls `runFlightsRefresh(true)`.
  4. `fetchFlightsCascade` finds no fresh flights for Tokyo's `rateKey` and returns `{ entities: [], status: 'offline', timestampMs: 0 }`.
  5. `App.tsx:488-489` evaluates `res.timestampMs > 0 ? res.timestampMs : prevFlightsFeed.lastUpdatedMs`, preserving `T_DC` (`14:00:00`) as if Tokyo had last updated at `14:00:00`.
- **Root Cause:** `if (jumpKm > 50)` wipes `liveKinematicsRegistry.rawFlights` without resetting `feeds.flights` (`lastUpdatedMs: null`, `provider: 'adsb-cascade'`, `count: 0`, `errorMsg: undefined`).
- **Surgical Fix:** Inside `if (jumpKm > 50)` (`src/App.tsx:595-604`), reset flight feed diagnostics before triggering `runFlightsRefresh(true)`:
  ```ts
  useSkyStore.getState().setFeedState('flights', {
    lastUpdatedMs: null,
    provider: 'adsb-cascade',
    count: 0,
    errorMsg: undefined,
  });
  ```

#### `[DEFECT-S2-02]` Low — `fetchFlightsCascade(..., { force: true })` Fails to Consume `adsbRateLimiter`, Allowing Immediate Non-Forced Re-Fetch Within 10s
- **Location:** [flightsService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/flightsService.ts#L733-L735)
- **Reproduction:**
  1. Call `await fetchFlightsCascade(DCA, 120, undefined, { force: true })` (matching `App.tsx`'s mount, observer-change, and manual-sweep calls).
  2. Immediately (< 10s later) call `await fetchFlightsCascade(DCA, 120, prevEntities)` without `force: true`.
  3. Because `!options.force` short-circuits `&&` before `adsbRateLimiter.tryConsume(rateKey)`, the bucket remains full and the second call hits upstream ADS-B endpoints again instead of returning the 10s rate-limit cache.
- **Root Cause:** `if (!options.force && !adsbRateLimiter.tryConsume(rateKey))` skips `tryConsume` whenever `force: true`.
- **Surgical Fix:** Evaluate `adsbRateLimiter.tryConsume(rateKey)` unconditionally (or record consumption in `TokenBucketRateLimiter` on `force: true`) before checking `!options.force`:
  ```ts
  const rateAllowed = adsbRateLimiter.tryConsume(rateKey);
  if (!options.force && !rateAllowed) {
  ```

---

### Sprint 02 Round 2 — Remediation & Verification Sign-Off

Both Low defects (`[DEFECT-S2-01]`, `[DEFECT-S2-02]`) were remediated on `main`:

| Defect ID | File Updated | Verification Status |
| :--- | :--- | :--- |
| `[DEFECT-S2-01]` | `src/App.tsx` | Fixed & Verified (`jumpKm > 50` resets `feeds.flights` diagnostics including `lastUpdatedMs: null`) |
| `[DEFECT-S2-02]` | `src/services/flightsService.ts` | Fixed & Verified (`adsbRateLimiter.tryConsume(rateKey)` evaluated prior to `!options.force` check) |

#### Sprint 02 Final Open Defect Tally
- **Critical:** **0**
- **High:** **0**
- **Medium:** **0**
- **Low:** **0**

---

## Sprint 02.1 — Live ADS-B CORS & Circuit-Breaker Patch Audit

**Auditor:** `@redteam-patch`  
**Branch / Worktree:** `sprint/redteam-patch` (`c:\krunked_skymap\.worktrees\redteam-patch`)  
**Scope:** Sprint 02.1 commits (`0e01a2d`, `a116c5f`, `dc61b62`, `9cc78d1`, `aa019a4`) touching [flightsService.ts](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/services/flightsService.ts), [httpClient.ts](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/services/httpClient.ts), [balloonsService.ts](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/services/balloonsService.ts), [vite.config.ts](file:///c:/krunked_skymap/.worktrees/redteam-patch/vite.config.ts), [sw.js](file:///c:/krunked_skymap/.worktrees/redteam-patch/public/sw.js), [ControlDock.tsx](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/components/hud/ControlDock.tsx), [cockpit.css](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/styles/cockpit.css), and [App.tsx](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/App.tsx).

### Sprint 02.1 Open Defect Tally

| Severity | Count | Findings |
| :--- | :---: | :--- |
| **Critical** | **0** | None |
| **High** | **0** | None |
| **Medium** | **0** | None |
| **Low** | **0** | None |
| **Total** | **0** | **27 / 27 passing** in [chaos.test.ts](file:///c:/krunked_skymap/.worktrees/redteam-patch/tests/adversarial/chaos.test.ts) (`74 / 74` full suite; `tsc --noEmit` exit `0`) |

### Sprint 02.1 Verification Summary (Verified Passing Controls)
1. **Zero-Preflight CORS Relay Hygiene (`r.jina.ai`):**
   - Stage 2 relay calls in [flightsService.ts](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/services/flightsService.ts#L950-L955) invoke [fetchTextWithTimeout](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/services/httpClient.ts#L114-L120) without `headers` or non-GET `method`, keeping `init?.headers === undefined` (no `Accept: application/json` or custom headers) so browsers execute simple GET requests with zero `OPTIONS` preflight failures.
   - Shared `429` suppression skips `cors-relay:adsb.lol` whenever `cors-relay:adsb.fi` failed with HTTP `429` (live or open-circuit `getLastError`).
2. **Cache-Poisoning & Phantom-Aircraft Rejection:**
   - [extractRelayedJsonPayload](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/services/flightsService.ts#L670-L723) extracts direct JSON, Jina `{ data: { content } }`, and `Markdown Content:` envelopes while rejecting `<!DOCTYPE html>` / `<html>`, upstream `{ Error: "..." }` (even when accompanied by an `ac[]` array), truncated JSON, arrays, and empty responses — returning `status: 'error'` and `0` phantom aircraft.
3. **Vite Proxy Header Scrubbing & Localhost Static-Server Fast-Bypass:**
   - [vite.config.ts](file:///c:/krunked_skymap/.worktrees/redteam-patch/vite.config.ts#L4-L44) strips `origin` and `referer` on `proxyReq` and sets an explicit `User-Agent` across `/api-proxy/adsb-lol`, `/api-proxy/adsb-fi`, and `/api-proxy/airplanes-live` for both `server.proxy` and `preview.proxy`.
   - [isLocalDevOrLanRuntime](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/services/flightsService.ts#L636-L664) restricts Stage 1 proxy probes to dev/localhost/LAN/CGNAT hosts, and HTTP `404`/`405` or `200 HTML` responses latch `viteProxyUnavailable = true`, reset the proxy breaker, suppress spurious `404` status/error strings, and fast-bypass straight into `cors-relay:adsb.fi`.
4. **Service Worker `krunked-skymap-v3` Isolation:**
   - VM sandbox execution of [sw.js](file:///c:/krunked_skymap/.worktrees/redteam-patch/public/sw.js#L1-L132) confirms `activate` prunes `krunked-skymap-v1` and `krunked-skymap-v2` while preserving `krunked-skymap-v3`, and `shouldBypassCache` bypasses `r.jina.ai`, `api.adsb.lol`, `opensky-network.org`, `api.v2.sondehub.org`, and `/api-proxy/` routes.
5. **Circuit-Breaker Reset Separation & Anti-Loop UI Hygiene:**
   - [App.tsx](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/App.tsx#L461-L704) cleanly isolates user/recovery triggers (`runFlightsRefresh(true, true)` on observer jump, manual sweep, and `online` recovery; plus `fetchBalloons(..., { force: true })` in [balloonsService.ts](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/services/balloonsService.ts#L268-L270)) from the 1Hz background scheduler (`runFlightsRefresh(shouldForce, false)` honoring open circuit cooldowns and surfacing `(HTTP 429)`/`lastError` diagnostics via [CircuitBreaker.getLastError](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/services/httpClient.ts#L325-L327)).
   - `flightsInFlightRef` locking, `nextFlightsDueMsRef = checkedAtMs + 10_000`, `nextRefreshSec = 10`, and [ControlDock.tsx](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/components/hud/ControlDock.tsx#L617-L778) `canRetryLiveFeed` gating (hiding `Retry Live Feed` during `loading`) prevent tight polling loops on repeated clicks of `Retry Live Feed` or `Sweep Now`, while [cockpit.css](file:///c:/krunked_skymap/.worktrees/redteam-patch/src/styles/cockpit.css#L1236-L1334) wraps structured error diagnostics cleanly inside the dock.

### Toolchain Verification (Post-Edit)
- `npx tsc --noEmit` -> **PASS (exit 0)**
- `npx vitest run --pool=vmThreads tests/adversarial/chaos.test.ts` -> **27 / 27 PASS** (`Challenge 1`–`Challenge 7`)
- `npx vitest run --pool=vmThreads` -> **74 / 74 PASS** (`tests/unit/ingest.test.ts`: 28, `tests/unit/math.test.ts`: 19, `tests/adversarial/chaos.test.ts`: 27)

---

## Sprint 03 — Global WindBorne, Mil/LADD/PIA, ATC UAS/LTA, Scale & Glass-Cockpit Overlay Audit (Round 1 Challenge)

**Auditor:** `@astro-redteam`  
**Branch / Worktree:** `sprint/astro-redteam` (`c:\krunked_skymap\.worktrees\astro-redteam`, branched from `65ee8b7`)  
**Scope:** [sky-contracts.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/types/sky-contracts.ts), [useSkyStore.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/store/useSkyStore.ts), [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx), [httpClient.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/httpClient.ts), [balloonsService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/balloonsService.ts), [flightsService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/flightsService.ts), [openDroneIdService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/openDroneIdService.ts), [satellitesService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/satellitesService.ts), [airspaceService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/airspaceService.ts), [TopTelemetryBar.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/TopTelemetryBar.tsx), [ControlDock.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/ControlDock.tsx), [OpenDroneIdModal.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/OpenDroneIdModal.tsx), [TargetInspector.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/inspector/TargetInspector.tsx) (canonical path vs brief alias), [TacticalMap.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/map/TacticalMap.tsx), [PolarSkyDome.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/skydome/PolarSkyDome.tsx), [cockpit.css](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/styles/cockpit.css), [vite.config.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/vite.config.ts), [sw.js](file:///c:/krunked_skymap/.worktrees/astro-redteam/public/sw.js), and [refresh-ephemeris.mjs](file:///c:/krunked_skymap/.worktrees/astro-redteam/scripts/refresh-ephemeris.mjs).

### Executive Defect Tally

| Severity | Count | Findings |
| :--- | :---: | :--- |
| **Critical** | **0** | None |
| **High** | **2** | `[DEFECT-S3-01]`, `[DEFECT-S3-02]` |
| **Medium** | **4** | `[DEFECT-S3-03]`, `[DEFECT-S3-04]`, `[DEFECT-S3-05]`, `[DEFECT-S3-06]` |
| **Low** | **2** | `[DEFECT-S3-07]`, `[DEFECT-S3-08]` |
| **Total** | **8** | **8 / 8 reproducible `[DEFECT-S3-*]` probes failing** in [chaos.test.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/tests/adversarial/chaos.test.ts) (`85 / 93` total passing; `tsc --noEmit` exit `0`) |

### Challenge 8 Verified Passing Controls (No Regression Found)
1. **WindBorne Validation, Snapshot Alignment & Antimeridian Kinematics:** `parseWindBorneConstellation` and `buildWindBorneTrail` reject `null`, `NaN`, `Infinity`, `(0, 0)` Null Island, and out-of-range coordinates/altitudes cleanly; tolerate mismatched `00.json` / `01.json` / `02.json` snapshot array lengths; enforce the `> 450 km` hourly index-shift outlier jump guard; and compute finite Antimeridian `±180°` crossing heading and groundspeed (`179.5°` → `-179.5°`).
2. **Global `/v2/mil` + `/v2/ladd` + `/v2/pia` Hex Deduplication & Circuit-Breaker Isolation:** Deduplicates overlapping ICAO `hex` entries across global endpoints while accumulating `dbFlags` / military precedence, and isolates `globalFlightsCircuitBreaker` (`429`/`503` trip) cleanly from local `flightsCircuitBreaker` (`/v2/point`).
3. **High-Altitude Stratospheric, Military UAS (`B6`), LTA (`B2`) & Low-Groundspeed Hover Retention:** Retains `alt_baro: null` + `alt_geom: 62000` stratospheric targets, preserves `isMilitary: true` on `B6` UAS (`MQ-9` / `RQ-4`), classifies `B2` LTA targets cleanly, and retains `gs < 5 kts` hovering rotors/UAS/balloons without drift suppression bugs.
4. **Scale & Memory Hygiene (`1,000` WindBorne + `500` Military + `2,000` Satellites):** `parseWindBorneConstellation` (1,000 balloons = `19.90ms`), global military ingestion (`500` flights = `6.85ms`), and SGP4 worker propagation (`2,000` satellites = `47.69ms`) execute within real-time frame budgets with zero unbounded trail growth or NaN poisoning. (`public/data/windborne-balloons.json` verified intact on disk with `1,000` tuples.)
5. **Service Worker `krunked-skymap-v3` Bypass & Caching:** [sw.js](file:///c:/krunked_skymap/.worktrees/astro-redteam/public/sw.js) bypasses `/api-proxy/windborne` and live same-origin `.json` telemetry payloads (`network-only`) while serving/caching `manifest.json`.
6. **Sprint 01 / 02 / 02.1 Baseline Preservation:** All `27 / 27` tests in `Challenge 1`–`Challenge 7`, `19 / 19` in [math.test.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/tests/unit/math.test.ts), and `34 / 34` in [ingest.test.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/tests/unit/ingest.test.ts) pass.

### Detailed Sprint 03 Findings (`[DEFECT-S3-01]` – `[DEFECT-S3-08]`)

#### 1. `[DEFECT-S3-01]` (High) — Duplicate `⌘K` / `Ctrl+K` Global Listeners Self-Cancel & `/` Leaks Past `OpenDroneIdModal`
- **Files & Lines:** [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L361-L397), [ControlDock.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/ControlDock.tsx#L219-L251)
- **Root Cause:** Both `ControlDock` (mounted inside `App`, so its `useEffect` registers first on `window`) and `App` attach `window.addEventListener('keydown', ...)` handlers that execute `setCommandPaletteOpen(!useSkyStore.getState().commandPaletteOpen)` on `Ctrl+K` / `⌘K` without `stopImmediatePropagation()`. Pressing `Ctrl+K` once invokes both listeners sequentially (`false -> true -> false`), leaving the Command Palette closed. Additionally, [ControlDock.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/ControlDock.tsx#L234) activates on `/` without guarding `!useSkyStore.getState().odidModalOpen`.
- **Fix Recipe:** Remove global `Ctrl+K` / `⌘K` and `/` keybinding handling from [ControlDock.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/ControlDock.tsx#L219-L251), keep keyboard shortcut ownership centralized in [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L361-L397), and reject `/` when `odidModalOpen` is `true`.

#### 2. `[DEFECT-S3-02]` (High) — Non-Atomic Multi-Overlay `Escape` Handling Cascades Into `TargetInspector`
- **Files & Lines:** [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L386-L392), [ControlDock.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/ControlDock.tsx#L240-L246), [TopTelemetryBar.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/TopTelemetryBar.tsx#L171-L176), [TargetInspector.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/inspector/TargetInspector.tsx#L130-L137), [OpenDroneIdModal.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/OpenDroneIdModal.tsx#L56-L60)
- **Root Cause:** Five independent `window` `keydown` listeners react to the same `Escape` event without shared tray state or `stopImmediatePropagation()`:
  1. When `diagnosticsOpen` (or `settingsOpen`) and `inspectorOpen` are both `true`, `App.tsx` closes `closeAllPopovers()` first, and `TargetInspector.tsx` subsequently sees `diagnosticsOpen === false` and calls `selectEntity(null, false)`.
  2. When a `ControlDock` sub-tray is open alongside `TargetInspector`, `ControlDock` clears its local `activeTrayCategory` while `App.tsx` (or `TargetInspector`) falls through and dismisses `inspectorOpen`.
  3. When `commandPaletteOpen` is `true` with focus outside an `<input>`, `ControlDock` closes the palette and downstream listeners see `commandPaletteOpen === false` and dismiss `inspectorOpen`.
- **Fix Recipe:** Promote `activeDockTray` (or tray state) into [useSkyStore.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/store/useSkyStore.ts) and consolidate `Escape` handling into one ordered dispatcher (`odidModalOpen` → `commandPaletteOpen` → `diagnosticsOpen || settingsOpen` → `activeDockTray` → `inspectorOpen`) calling `e.stopImmediatePropagation()` so one `Escape` press dismisses strictly one overlay layer.

#### 3. `[DEFECT-S3-03]` (Medium) — Global `/v2/{mil,ladd,pia}` Hex Merge Downgrades `airframeClass` (`heavy`/`heli`) & Drops Metadata
- **Files & Lines:** [flightsService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/flightsService.ts#L1909-L1931), [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L218-L241), [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L1494-L1515)
- **Root Cause:** At [flightsService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/flightsService.ts#L1928) (`existing.airframeClass === 'fast-mil' ? existing.airframeClass : f.airframeClass`), merging an existing `/v2/mil` `heavy` (`C17`) or `heli` (`H60`) target with a downstream `/v2/ladd` or `/v2/pia` record that lacks aircraft type `t` overwrites `'heavy'`/`'heli'` with `'fast-mil'` (or `'jet'`). Similarly, [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L1503) lets `'jet'` local `/v2/point` frames overwrite richer global military airframe classes, and `syncAdsbSecondaryRegistries` replaces `adsb-uas` / `adsb-lta` records without retaining `isMilitary` / `isLadd` / `isPia` and optional airframe metadata.
- **Fix Recipe:** Introduce a helper ranking airframe specificity (`heli`/`heavy` > `fast-mil` > `prop` > `jet`) when merging ICAO `hex` matches across `/v2/{mil,ladd,pia}`, local/global flights, and `syncAdsbSecondaryRegistries`, preserving non-empty `aircraftType`, `registration`, and `squawk`.

#### 4. `[DEFECT-S3-04]` (Medium) — `fetchBalloons` Masks SondeHub 503 + WindBorne Cached Seed Behind `status: 'live'` & `Date.now()`
- **File & Lines:** [balloonsService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/balloonsService.ts#L1124-L1164)
- **Root Cause:** In `scope: 'global'`, when `/sondes` rejects (`503`) while `/amateur` returns `200 {}` (`0` telemetry records) and WindBorne falls back to cached `./data/windborne-balloons.json` (`wbStatus: 'cached'`, `isCachedSeed: true`), `sondeOk` evaluates `true` (`amateurRes.status === 'fulfilled'`). Line 1134 then emits `status: 'live'` and line 1164 stamps `timestampMs: Date.now()` instead of reporting `'cached'` and preserving `windborneRes.timestampMs`.
- **Fix Recipe:** When `wbStatus === 'cached'` and SondeHub contributed `0` live entities (especially when `sondesRes.status === 'rejected'`), return `status: 'cached'` and `timestampMs: windborneRes.timestampMs` instead of synthesizing `'live'` telemetry timestamps.

#### 5. `[DEFECT-S3-05]` (Medium) — `TopTelemetryBar` System Beacon Masks Local `flights: 'error'` as `FEEDS LIVE` When `balloons: 'live'`
- **File & Lines:** [TopTelemetryBar.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/TopTelemetryBar.tsx#L63-L93)
- **Root Cause:** `resolveSystemBeacon` evaluates `if (flights === 'live' || military === 'live' || balloons === 'live')` at line 77 before checking `if (flights === 'error')` at line 80 (and omits `military === 'error'` checks entirely). An active local ADS-B outage (`flights: 'error'`) is hidden behind a green `FEEDS LIVE` beacon whenever SondeHub/WindBorne balloons are `'live'`.
- **Fix Recipe:** Check `flights === 'error'` (and `military === 'error'` when `atmosphericScope === 'global'`) prior to resolving a green `'live'` beacon state when primary ADS-B flight feeds are unhealthy.

#### 6. `[DEFECT-S3-06]` (Medium) — `App.tsx` Runs 60fps WGS-84 Extrapolation on Disabled Atmospheric Layers & Delays WindBorne Pruning on `GLOBAL -> LOCAL`
- **Files & Lines:** [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L973-L989), [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L1408), [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx#L1521-L1529)
- **Root Cause:** `stepKinematics` iterates all entries in `rawGlobalFlights`, `rawBalloons`, `rawAdsbBalloons`, `rawDrones`, and `rawAdsbDrones` through WGS-84 ECEF/ENU `pushAtmospheric` on every animation frame even when `st.layers.balloon`, `st.layers.military`, or `st.layers.drone` is `false` (discarding only downstream at line 1408 inside `pushExtrapolatedEntity`). Furthermore, the `GLOBAL -> LOCAL` scope transition handler synchronously clears `rawGlobalFlights` and `globalAdsb*` entries, but leaves global `subSource === 'windborne'` / out-of-range balloons inside `liveKinematicsRegistry.rawBalloons` until an async SondeHub fetch returns.
- **Fix Recipe:** Gate each `pushAtmospheric` loop in `stepKinematics` on its corresponding `st.layers.*` toggle (`layers.military`, `layers.balloon`, `layers.drone`) and synchronously prune `subSource === 'windborne'` / out-of-range balloons from `liveKinematicsRegistry.rawBalloons` in the `atmosphericScope === 'local'` effect.

#### 7. `[DEFECT-S3-07]` (Low) — Secondary Proxy `404` Latches `globalViteProxyUnavailable` Permanently & `B6` UAS Compliance Gate Uses MSL Not AGL
- **File & Lines:** [flightsService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/flightsService.ts#L812), [flightsService.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/services/flightsService.ts#L1855-L1863)
- **Root Cause:** (A) If the primary `/api-proxy/adsb-lol` returns transient `503` and failover hits a secondary proxy (e.g., `airplanes-live/v2/ladd`) returning JSON `404`, lines 1855–1863 latch `globalViteProxyUnavailable = true` globally, blocking primary `/api-proxy/adsb-lol` on subsequent cycles. (B) Line 812 checks `core.altM <= 500` (MSL) instead of `core.altM - (observer.altM ?? 0) <= 500` (AGL), causing `B6` UAS compliance / FAA UASFM ceiling checks to be skipped at high-elevation US airports (e.g., Denver `1,655 m` MSL).
- **Fix Recipe:** Latch `globalViteProxyUnavailable` strictly on `/api-proxy/adsb-lol` `404`/`405` or HTML static fallback responses, and compute AGL height `(core.altM - (observer.altM ?? 0))` at line 812.

#### 8. `[DEFECT-S3-08]` (Low) — Tablet (`768px–1040px`) Dock / Inspector Squeeze & Mobile SkyDome Legend Overlap
- **Files & Lines:** [cockpit.css](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/styles/cockpit.css#L1164-L1177), [cockpit.css](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/styles/cockpit.css#L1758-L1762), [cockpit.css](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/styles/cockpit.css#L2360-L2366), [PolarSkyDome.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/skydome/PolarSkyDome.tsx#L2042)
- **Root Cause:** Inside `@media (min-width: 768px) and (max-width: 1440px)` when `.target-inspector.is-open` shifts `.control-dock-wrap` to `right: 364px` (leaving ~`404px` width at `768px`), `.dock-pill` lacks `flex-wrap: wrap`, squeezing dock controls horizontally. Meanwhile, the bottom-right legend in [PolarSkyDome.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/skydome/PolarSkyDome.tsx#L2042) carries inline `bottom: 8px` positioning with no `.skydome-legend` CSS class hook to clear the stacked mobile `ControlDock` at `<= 767px`.
- **Fix Recipe:** Add `.dock-pill { flex-wrap: wrap; justify-content: center; }` within `@media (min-width: 768px) and (max-width: 1120px)` when inspector is open, add `className="skydome-legend"` in [PolarSkyDome.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/skydome/PolarSkyDome.tsx#L2042), and lift `.skydome-legend` under `@media (max-width: 767px)` (`bottom: 92px !important`).

### Exact Verification Commands & Counts (Round 1 Challenge)
```powershell
$env:PATH = "$env:LOCALAPPDATA\nodejs-v22;$env:PATH"
npm run typecheck
npx vitest run --pool=vmThreads
```
- `npm run typecheck` -> **PASS (exit 0)**
- `npx vitest run --pool=vmThreads` -> **3 test files | 93 tests: 85 passed, 8 failed (`[DEFECT-S3-01]` – `[DEFECT-S3-08]` intentional Sprint 03 challenge probes)**
  - `tests/unit/math.test.ts` -> **19 / 19 PASS**
  - `tests/unit/ingest.test.ts` -> **34 / 34 PASS**
  - `tests/adversarial/chaos.test.ts` -> **32 / 40 PASS** (`Challenge 1`–`Challenge 7`: `27 / 27 PASS`; `Challenge 8`: `5 / 13 PASS`, `8 / 8 [DEFECT-S3-*]` FAIL as expected before remediation)
  - Scale timings observed: `Challenge 3` 2,000-sat median `45.40ms` (`visible=96`); `Challenge 8` `wb1000=19.90ms`, `mil500=6.85ms`, `sat2000=47.69ms`.

### Sprint 03 Round 2 Remediation & Verification

- **Status:** **ALL 8 / 8 DEFECTS REMEDIATED (`0 Critical / 0 High / 0 Medium / 0 Low` OPEN)**
  - `[DEFECT-S3-01]` & `[DEFECT-S3-02]` Fixed: Centralized `Ctrl+K` / `⌘K`, `/`, and 5-tier single-layer `Escape` handling (`odidModalOpen` -> `commandPaletteOpen` -> `diagnosticsOpen || settingsOpen` -> `activeDockTray` -> `inspectorOpen`) inside `App.tsx` with `stopImmediatePropagation()`, backed by store `activeDockTray`. Removed duplicate window listeners from `ControlDock.tsx`, `TopTelemetryBar.tsx`, `TargetInspector.tsx`, and `OpenDroneIdModal.tsx`.
  - `[DEFECT-S3-03]` Fixed: Exported `pickRicherAirframeClass` in `flightsService.ts` and preserved richer `airframeClass` (`heli`/`heavy` > `fast-mil` > `prop` > `jet`) plus `aircraftType`, `registration`, `squawk`, and `emergencyFlag` across `/v2/{mil,ladd,pia}`, local/global flight merges, and `syncAdsbSecondaryRegistries`.
  - `[DEFECT-S3-04]` Fixed: Updated `fetchBalloons` in `balloonsService.ts` to report `status: 'cached'` and preserve `windborneRes.timestampMs` when SondeHub contributes zero live records alongside a cached WindBorne seed.
  - `[DEFECT-S3-05]` Fixed: Reordered `resolveSystemBeacon` in `TopTelemetryBar.tsx` to check `flights === 'error' || military === 'error'` ahead of green `'live'` status.
  - `[DEFECT-S3-06]` Fixed: Gated 60fps `pushAtmospheric` calls in `App.tsx` on active `st.layers.*` toggles and synchronously pruned `subSource === 'windborne'` and out-of-range `rawBalloons` entries on `GLOBAL -> LOCAL`.
  - `[DEFECT-S3-07]` Fixed: Scoped Vite proxy unavailability latching strictly to primary proxy `404`/`405` or static HTML fallback responses in `flightsService.ts`, and evaluated `B6` UAS compliance against observer-relative AGL (`altM - observer.altM`) rather than MSL.
  - `[DEFECT-S3-08]` Fixed: Wrapped `.dock-pill` when `.target-inspector.is-open` at `@media (min-width: 768px) and (max-width: 1440px)` in `cockpit.css`, and added `.skydome-legend` in `PolarSkyDome.tsx` lifted clear above mobile dock under `@media (max-width: 767px)`.


---

## Sprint 04 — 3D Sky-Dome, Celestial/TCA, Zero-GC & Hotkey Audit (Challenge 9)

**Result: 0 Critical / 0 High / 0 Medium / 0 Low OPEN.** Challenge 9 = 6/6 PASS.

| Probe | Coverage | Outcome |
|---|---|---|
| 9.1 | 1,000 targets el -85..-0.01 culled (hemisphere + zenith, zenith el<30); no -5deg/OTH/EL_MIN=-5 in PolarSkyDome.tsx | PASS |
| 9.2 | Zenith overflight + antimeridian crossing, 61 steps: tangent finite, max step <2deg, ENU projection finite | PASS |
| 9.3 | Project/unproject <0.01deg, both zoom modes, 156^2..3840x2160, DPR 1/2/3 | PASS |
| 9.4 | Sun/Moon at +/-89.9 lat, equator, antimeridian, ts 0/NaN/2100 finite+in range; TCA speed 0, receding, approaching 0<tca<=600 | PASS |
| 9.5 | 80 aircraft in 15deg zenith cone: caps 12/7/0, no overlap, 8px margins, el<8 hidden; prune evicts disabled layer + GLOBAL->LOCAL synchronously | PASS |
| 9.6 | Hotkeys M/S/D/P/L/Esc on body; ignored in input, odid modal, palette | PASS |

| Severity | Open | Notes |
|---|---|---|
| Critical | 0 | |
| High | 0 | |
| Medium | 0 | |
| Low | 0 | |

**Test maintenance (not src defects):** sw.js assertions bumped to `krunked-skymap-v4` (prune v1/v2/v3); Sprint 02 polar-trail prune assertion re-anchored because Sprint 04 removed the comment markers (prune logic intact at PolarSkyDome.tsx ~L1656-1659).

---

## Sprint 05 — Translucent Sky-Dome, Compass/Touch-Lock, Portal Modal, Right +33% PIP & Overhead Lock Audit (Challenge 10)

**Auditor:** `@astro-redteam`  
**Branch / Worktree:** `sprint/astro-redteam` (`c:\krunked_skymap\.worktrees\astro-redteam`)  
**Scope:** Merged Sprint 05 deliverables across [geodesy.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/math/geodesy.ts), [useSkyStore.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/store/useSkyStore.ts), [PolarSkyDome.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/skydome/PolarSkyDome.tsx), [ControlDock.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/ControlDock.tsx), [TopTelemetryBar.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/TopTelemetryBar.tsx), [TacticalMap.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/map/TacticalMap.tsx), [cockpit.css](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/styles/cockpit.css), [App.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/App.tsx), and [sw.js](file:///c:/krunked_skymap/.worktrees/astro-redteam/public/sw.js).

### Sprint 05 Executive Defect Tally

| Severity | Count | Findings |
| :--- | :---: | :--- |
| **Critical** | **0** | None |
| **High** | **0** | None |
| **Medium** | **0** | None |
| **Low** | **2** | Synchronous `requestPermission()` throw guard (`[DEFECT-S5-01]`); queued 250ms search debounce not cleared on palette close (`[DEFECT-S5-02]`) |
| **Total** | **2** | **50 / 50 passing** in [chaos.test.ts](file:///c:/krunked_skymap/.worktrees/astro-redteam/tests/adversarial/chaos.test.ts) (`Challenge 1`–`Challenge 10`; `tsc --noEmit` exit `0`) |

### Challenge 10 & SW v5 Verification Matrix

| Probe | Coverage | Outcome |
| :--- | :--- | :---: |
| **SW v5 (C6 & C8)** | `public/sw.js` pinned to `krunked-skymap-v5`; `activate` prunes `v1`–`v4` while preserving `v5`; bypasses cross-origin telemetry, `/api-proxy/`, and live `.json` while caching `manifest.json` | **PASS** |
| **10.1a** | `359.9° <-> 0.1°` North-crossing jitter (`< 0.5°/step`, never spins `359°`, converges `< 0.01°`); landscape `90°`/`270°`/`180°` screen orientation compensation & iOS `webkitCompassHeading` priority in `extractCompassHeadingDeg` & `deriveCompassHeadingDeg`; rotated `projectToSkyDome` / `projectEnuToSkyDome` / `unprojectFromSkyDome` / `computeSkyDomeTrajectoryTangent` round-trip `< 0.05°` across `0°..359.9°` in both `'hemisphere'` & `'zenith'` modes + smooth zenith overflight at `143.7°` | **PASS** |
| **10.1b** | Full JSDOM mount of real `PolarSkyDome`: iOS `DeviceOrientationEvent.requestPermission()` `NotAllowedError` rejection & desktop missing-sensor graceful fallback (absent API + 1.5s silent timeout); `< 6px` micro-movement tap target selection without altering heading; CCW pointer drag-and-release parking at `~143.7°` with zero post-release snap-back, automatic compass disengage, and `stopPropagation()` blocking parent/map propagation; `LOCK` strictly blocking drag, `setDomeRotationDeg`, and live compass updates while `N▲` (`resetDomeNorth`) still resets to `000°`; live unlocked `deviceorientationabsolute` North-seam smoothing (`359.9° -> 0.1°`) | **PASS** |
| **10.2** | Full JSDOM mount of `App` + `ControlDock`: clicking `[data-testid="omnibox-trigger"]` portals `.cockpit-modal-backdrop` directly under `document.body` (escaped `.control-dock-wrap`); `cockpit.css` enforces `pointer-events: auto` and `z-index: 120 >= 100`; inner `.command-palette` clicks do NOT close modal; typing `33.9416, -118.4085` + submitting `[data-testid="command-palette-submit"]` (`GO`) moves observer and closes modal; Hotspot Preset click jumps observer & closes; `X` (`[data-testid="command-palette-close"]`) & outer backdrop (`[data-testid="command-palette-backdrop"]`) both close cleanly | **PASS** |
| **10.3** | `.stage-map-pane` always `display: block !important` (never `display: none` in `dome` mode); `TacticalMap.tsx` renders continuously in `dome` mode and applies dynamic `setPadding` / `computeLayoutCameraPadding` in `split` mode (`right: 605` at `1440×900`, `bottom: 405` at `390×844`); translucent `.stage-dome-pane` (`rgba(6, 10, 18, 0.30)`, `blur(1px) <= 4px`), transparent root, and `clearRect` without full-canvas `fillRect`; desktop right-side `+33%` PIP (`320×320px`, `right:`, `left: auto`) shifts left `352px` when `.target-inspector.is-open` (`1440px`: PIP `[756, 1076]` vs Inspector `[1088, 1428]` -> `12px` clean gap, zero overlap) and mobile PIP clamps to `min(208px, calc(100vw - 24px))` (`<= 366px` at `390×844`); zero passive `ZENITH` labels in `TopTelemetryBar.tsx` / `PolarSkyDome.tsx`; `[data-testid="topbar-overhead-lock"]` handles `0` targets without throw, locks/cycles fallback targets (`35° -> 25° -> 35°`), and prioritizes/cycles primary cone (`72° -> 50° -> 72°`, excluding `30°`) while opening `TargetInspector` | **PASS** |

### Sprint 05 Low-Severity Hardening Findings

#### `[DEFECT-S5-01]` (Low) — Uncaught Synchronous Throw If `DeviceOrientationEvent.requestPermission()` Throws Before Returning a Promise
- **File & Lines:** [PolarSkyDome.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/skydome/PolarSkyDome.tsx#L2535-L2556)
- **Reproduction:** Mock `window.DeviceOrientationEvent = { requestPermission: () => { throw new DOMException('NotAllowedError'); } }` and click `[data-testid="skydome-compass-toggle"]`. Because `DevOrientCtor.requestPermission()` is evaluated as an argument before `Promise.resolve(...)` is entered, a synchronous throw bypasses `.catch(...)`. (Standard iOS Safari rejects asynchronously via Promise, which `.catch()` already handles cleanly.)
- **Surgical Fix:** Wrap the `DevOrientCtor.requestPermission()` invocation in `try { void Promise.resolve(DevOrientCtor.requestPermission()).then(...).catch(...); } catch { setDomeCompassActive(false); showCompassStatus('Compass permission denied — drag dome to rotate'); }` so synchronous user-gesture invocation is preserved while guarding synchronous throws.

#### `[DEFECT-S5-02]` (Low) — Queued 250ms Location Search Debounce Timer Not Cancelled When Command Palette Closes
- **File & Lines:** [ControlDock.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/ControlDock.tsx#L240-L251), [ControlDock.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/ControlDock.tsx#L319-L322)
- **Reproduction:** Open the Location Command Palette, type a city name (e.g. `Paris`), and dismiss the modal via `X`, backdrop click, or `Esc` within `< 250ms`. Line 248 aborts any in-flight `abortRef.current` request, but leaves `debounceRef.current` armed, triggering a background `onSearchLocation('Paris')` network call 250ms later after the modal is already closed.
- **Surgical Fix:** Inside the `!commandPaletteOpen` branch at [ControlDock.tsx](file:///c:/krunked_skymap/.worktrees/astro-redteam/src/components/hud/ControlDock.tsx#L248-L250), clear `debounceRef.current` via `window.clearTimeout(debounceRef.current); debounceRef.current = null;`.

### Verification Commands & Observed Results
```powershell
Set-Location "c:\krunked_skymap\.worktrees\astro-redteam"
$env:PATH = "$env:LOCALAPPDATA\nodejs-v22;$env:PATH"
npx tsc --noEmit
npx vitest run tests/adversarial/chaos.test.ts --pool=vmThreads
```
- `npx tsc --noEmit` -> **PASS (exit 0)**
- `npx vitest run tests/adversarial/chaos.test.ts --pool=vmThreads` -> **50 / 50 PASS** (`Challenge 1`–`Challenge 10`, including SW v5 updates and all 4 Sprint 05 Challenge 10 suites)

### Sprint 05 Low-Severity Remediation Sign-Off

Both Low hardening items (`[DEFECT-S5-01]`, `[DEFECT-S5-02]`) were remediated on `main`:

| Defect ID | File Updated | Verification Status |
| :--- | :--- | :--- |
| `[DEFECT-S5-01]` | `src/components/skydome/PolarSkyDome.tsx` | Fixed & Verified (`try/catch` guards synchronous throws from `DeviceOrientationEvent.requestPermission()`) |
| `[DEFECT-S5-02]` | `src/components/hud/ControlDock.tsx` | Fixed & Verified (`window.clearTimeout(debounceRef.current)` cancels pending search debounce when Command Palette closes) |

#### Sprint 05 Final Open Defect Tally
- **Critical:** **0**
- **High:** **0**
- **Medium:** **0**
- **Low:** **0**


