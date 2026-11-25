import type {
  FeedHealthStatus,
  SatelliteGroup,
  TleRecord,
} from '../types/sky-contracts';
import { fetchTextWithTimeout } from './httpClient';
import { resolveAdaptiveTimeoutMs } from './teslaCompat';

const IDB_OPERATION_TIMEOUT_MS = 2500;

export const TLE_DB_NAME = 'krunked_tle_v1';
export const TLE_STORE_NAME = 'tle_cache';
export const TLE_CACHE_KEY = 'celestrak_gp_bundle';
export const TLE_TTL_MS = 2 * 60 * 60 * 1000; // Strict 2-hour CelesTrak TTL

const GROUPS: readonly SatelliteGroup[] = ['stations', 'visual', 'starlink'];

export interface TleCacheBundle {
  key: string;
  fetchedAtMs: number;
  records: TleRecord[];
}

export interface TleRefreshResult {
  records: TleRecord[];
  status: FeedHealthStatus;
  provider: string;
  lastUpdatedMs: number;
  fromNetwork: boolean;
  errorMsg?: string;
}

export interface RefreshTleOptions {
  signal?: AbortSignal;
  nowMs?: number;
  timeoutMs?: number;
}

let memoryTleCache: TleCacheBundle | null = null;

export function clearTleCache(): void {
  memoryTleCache = null;
}

/**
 * Decode 5-character NORAD catalog ID (numeric or Space-Track Alpha-5).
 */
export function parseNoradId(rawField: string): number | null {
  const token = rawField.trim().toUpperCase();
  if (!token) return null;

  if (/^\d{1,6}$/.test(token)) {
    const num = Number.parseInt(token, 10);
    return Number.isInteger(num) && num > 0 ? num : null;
  }

  // Alpha-5 encoding: first char A-H (10-17), J-N (18-22), P-Z (23-33) + 4 digits
  if (/^[A-HJ-NP-Z]\d{4}$/.test(token)) {
    const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const prefix = alphabet.indexOf(token[0]);
    const suffix = Number.parseInt(token.slice(1), 10);
    if (prefix >= 10 && Number.isInteger(suffix)) {
      return prefix * 10000 + suffix;
    }
  }

  return null;
}

function isValidTleLine1(line: string): boolean {
  return line.startsWith('1 ') && line.length >= 68;
}

function isValidTleLine2(line: string): boolean {
  return line.startsWith('2 ') && line.length >= 68;
}

/**
 * Parse 3-line or 2-line TLE text blocks into validated TleRecord[].
 * Skips malformed pairs and mismatched NORAD catalog IDs without throwing.
 */
export function parseTleText(text: string, group: SatelliteGroup): TleRecord[] {
  if (typeof text !== 'string' || !text.trim()) {
    return [];
  }

  const lines = text.split(/\r?\n/);
  const records: TleRecord[] = [];
  let pendingName: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i]?.trimEnd() ?? '';
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      pendingName = null;
      continue;
    }

    if (isValidTleLine1(trimmed)) {
      const nextRaw = lines[i + 1]?.trimEnd() ?? '';
      const nextTrimmed = nextRaw.trim();

      if (isValidTleLine2(nextTrimmed)) {
        const id1 = parseNoradId(trimmed.slice(2, 7));
        const id2 = parseNoradId(nextTrimmed.slice(2, 7));

        if (id1 !== null && id2 !== null && id1 === id2) {
          const cleanName = pendingName
            ? pendingName.replace(/^0\s+/, '').trim()
            : `SAT-${id1}`;
          records.push({
            name: cleanName || `SAT-${id1}`,
            noradId: id1,
            group,
            line1: trimmed,
            line2: nextTrimmed,
          });
        }
        i += 1; // Consume line 2
      }
      pendingName = null;
      continue;
    }

    if (isValidTleLine2(trimmed)) {
      // Orphaned line 2 without matching line 1
      pendingName = null;
      continue;
    }

    // Ignore partial/corrupted lines that look like broken TLE lines ("1 ..." or "2 ...")
    if (/^[12]\s/.test(trimmed)) {
      pendingName = null;
      continue;
    }

    pendingName = trimmed;
  }

  return records;
}

/**
 * Deduplicate TLE records across groups while preserving priority:
 * stations > visual > starlink.
 */
export function deduplicateTleRecords(records: TleRecord[]): TleRecord[] {
  const priority: Record<SatelliteGroup, number> = {
    stations: 0,
    visual: 1,
    starlink: 2,
  };
  const byId = new Map<number, TleRecord>();

  for (const rec of records) {
    const existing = byId.get(rec.noradId);
    if (!existing || priority[rec.group] < priority[existing.group]) {
      byId.set(rec.noradId, rec);
    }
  }
  return Array.from(byId.values());
}

/**
 * Load build-seeded TLE files from ./data/tle/{stations,visual,starlink}.tle for 0ms cold boot.
 */
export async function loadInitialTles(signal?: AbortSignal): Promise<TleRecord[]> {
  const timeoutMs = resolveAdaptiveTimeoutMs(4000);
  const results = await Promise.allSettled(
    GROUPS.map(async (group) => {
      const text = await fetchTextWithTimeout(`./data/tle/${group}.tle`, {
        timeoutMs,
        signal,
      });
      return parseTleText(text, group);
    })
  );

  const collected: TleRecord[] = [];
  for (const res of results) {
    if (res.status === 'fulfilled') {
      collected.push(...res.value);
    }
  }
  return deduplicateTleRecords(collected);
}

async function openTleDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;

  return new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    const finish = (val: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), IDB_OPERATION_TIMEOUT_MS);

    try {
      const req = indexedDB.open(TLE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(TLE_STORE_NAME)) {
          db.createObjectStore(TLE_STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        if (settled) {
          try {
            req.result.close();
          } catch {
            // Ignore close failure
          }
          return;
        }
        finish(req.result);
      };
      req.onerror = () => finish(null);
      req.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

async function readCachedBundleFromIdb(): Promise<TleCacheBundle | null> {
  if (typeof indexedDB === 'undefined') {
    return memoryTleCache;
  }

  const db = await openTleDb();
  if (!db) return memoryTleCache;

  return new Promise<TleCacheBundle | null>((resolve) => {
    let settled = false;
    const finish = (val: TleCacheBundle | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        db.close();
      } catch {
        // Ignore close failure
      }
      resolve(val);
    };
    const timer = setTimeout(() => finish(memoryTleCache), IDB_OPERATION_TIMEOUT_MS);

    try {
      const tx = db.transaction(TLE_STORE_NAME, 'readonly');
      const store = tx.objectStore(TLE_STORE_NAME);
      const req = store.get(TLE_CACHE_KEY);
      req.onsuccess = () => {
        const val = req.result as TleCacheBundle | undefined;
        if (
          val &&
          typeof val.fetchedAtMs === 'number' &&
          Array.isArray(val.records)
        ) {
          finish(val);
        } else {
          finish(memoryTleCache);
        }
      };
      req.onerror = () => finish(memoryTleCache);
      tx.onabort = () => finish(memoryTleCache);
    } catch {
      finish(memoryTleCache);
    }
  });
}

async function writeCachedBundleToIdb(bundle: TleCacheBundle): Promise<void> {
  memoryTleCache = bundle;
  if (typeof indexedDB === 'undefined') return;

  const db = await openTleDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        db.close();
      } catch {
        // Ignore close failure
      }
      resolve();
    };
    const timer = setTimeout(finish, IDB_OPERATION_TIMEOUT_MS);

    try {
      const tx = db.transaction(TLE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(TLE_STORE_NAME);
      store.put(bundle);
      tx.oncomplete = finish;
      tx.onerror = finish;
      tx.onabort = finish;
    } catch {
      finish();
    }
  });
}

/**
 * Refresh CelesTrak GP TLEs only when IndexedDB cache (krunked_tle_v1) is missing,
 * older than the strict 2-hour TTL, or force === true. Falls back cleanly if offline.
 */
export async function refreshTlesIfStale(
  force = false,
  options: RefreshTleOptions = {}
): Promise<TleRefreshResult> {
  const nowMs = options.nowMs ?? Date.now();
  const timeoutMs = options.timeoutMs ?? resolveAdaptiveTimeoutMs(8000);
  const cached = await readCachedBundleFromIdb();

  if (
    !force &&
    cached &&
    cached.records.length > 0 &&
    nowMs >= cached.fetchedAtMs - 60_000 &&
    nowMs - cached.fetchedAtMs < TLE_TTL_MS
  ) {
    return {
      records: cached.records,
      status: 'cached',
      provider: 'indexeddb-tle-cache',
      lastUpdatedMs: cached.fetchedAtMs,
      fromNetwork: false,
    };
  }

  const groupResults = await Promise.allSettled(
    GROUPS.map(async (group) => {
      const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
      const text = await fetchTextWithTimeout(url, {
        timeoutMs,
        signal: options.signal,
      });
      return { group, records: parseTleText(text, group) };
    })
  );

  const fetchedRecords: TleRecord[] = [];
  const failedGroups: string[] = [];
  const succeededGroups = new Set<SatelliteGroup>();

  for (let i = 0; i < GROUPS.length; i += 1) {
    const group = GROUPS[i];
    const res = groupResults[i];
    if (res.status === 'fulfilled' && res.value.records.length > 0) {
      fetchedRecords.push(...res.value.records);
      succeededGroups.add(group);
    } else {
      failedGroups.push(group);
    }
  }

  if (fetchedRecords.length > 0) {
    // Preserve cached records for any individual group that blipped
    if (failedGroups.length > 0 && cached && cached.records.length > 0) {
      for (const rec of cached.records) {
        if (!succeededGroups.has(rec.group)) {
          fetchedRecords.push(rec);
        }
      }
    }
    const merged = deduplicateTleRecords(fetchedRecords);
    await writeCachedBundleToIdb({
      key: TLE_CACHE_KEY,
      fetchedAtMs: nowMs,
      records: merged,
    });
    return {
      records: merged,
      status: 'live',
      provider: 'celestrak-gp',
      lastUpdatedMs: nowMs,
      fromNetwork: true,
    };
  }

  const errorMsg = `CelesTrak refresh unavailable (${failedGroups.join(', ')})`;

  if (cached && cached.records.length > 0) {
    return {
      records: cached.records,
      status: 'cached',
      provider: 'indexeddb-stale-cache',
      lastUpdatedMs: cached.fetchedAtMs,
      fromNetwork: false,
      errorMsg,
    };
  }

  const seeded = await loadInitialTles(options.signal);
  return {
    records: seeded,
    status: 'fallback',
    provider: 'seeded-tle-bundle',
    lastUpdatedMs: nowMs,
    fromNetwork: false,
    errorMsg,
  };
}
