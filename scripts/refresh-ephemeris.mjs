import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(SCRIPT_DIR, '../public/data');
const TLE_DIR = path.join(DATA_DIR, 'tle');

const FETCH_TIMEOUT_MS = 12_000;
const STARLINK_MAX_ENTRIES = 600;
const FLIGHTS_MAX_ENTRIES = 160;
const ORIGIN = { lat: 38.8512, lon: -77.0402 };

const CELESTRAK_GROUP_URLS = {
  stations: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
  visual: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle',
  starlink: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle',
};

const ADSB_LIVE_URL = `https://api.adsb.lol/v2/point/${ORIGIN.lat}/${ORIGIN.lon}/100`;

const FAA_UASFM_URL =
  'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/ArcGIS/rest/services/FAA_UAS_FacilityMap_Data/FeatureServer/0/query' +
  `?where=${encodeURIComponent('LATITUDE BETWEEN 38.80 AND 39.04 AND LONGITUDE BETWEEN -77.58 AND -77.30')}` +
  '&outFields=CEILING,UNIT,APT1_FAAID,APT1_ICAO,APT1_NAME,AIRSPACE_1&resultRecordCount=1000&f=geojson';

const FAA_SUA_URL =
  'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/ArcGIS/rest/services/Special_Use_Airspace/FeatureServer/0/query' +
  '?geometry=-77.6,38.5,-76.8,39.2&geometryType=esriGeometryEnvelope&inSR=4326' +
  '&spatialRel=esriSpatialRelIntersects&outFields=NAME,TYPE_CODE,UPPER_VAL,UPPER_UOM,LOWER_VAL,LOWER_UOM' +
  '&returnGeometry=true&outSR=4326&f=geojson';

const BASELINE_TLES = {
  stations: `ISS (ZARYA)
1 25544U 98067A   26323.26944509  .00013909  00000+0  25567-3 0  9994
2 25544  51.6317 252.6441 0007410  42.3196 317.8363 15.49482233595793
CSS (TIANHE)
1 48274U 21035A   26323.55661522  .00021030  00000+0  24862-3 0  9994
2 48274  41.4685  97.7847 0004903 262.8853  97.1429 15.60775386317435
POISK
1 36086U 09060A   26323.26944509  .00013909  00000+0  25567-3 0  9992
2 36086  51.6317 252.6441 0007410  42.3196 317.8363 15.49482233586808
ISS (NAUKA)
1 49044U 21066A   26323.26944509  .00013909  00000+0  25567-3 0  9990
2 49044  51.6317 252.6441 0007410  42.3196 317.8363 15.49482233586840`,

  visual: `HST
1 20580U 90037B   26323.61983704  .00006856  00000+0  20567-3 0  9995
2 20580  28.4715  96.9716 0002525  80.3200 279.7682 15.32362956812429
NOAA 19
1 33591U 09005A   26273.59308864  .00000011  00000+0  29755-4 0  9991
2 33591  98.9424 344.4922 0014802  92.4535 267.8332 14.13487508909370
NOAA 15
1 25338U 98030A   26273.55995750  .00000043  00000+0  35038-4 0  9995
2 25338  98.5045 291.3358 0011029  43.6395 316.5657 14.27171937476325
NOAA 18
1 28654U 05018A   26273.57529228  .00000040  00000+0  44082-4 0  9994
2 28654  98.8043 351.6864 0013789 207.5858 152.4584 14.13745474101208
TERRA
1 25994U 99068A   26323.62140354  .00000339  00000+0  77813-4 0  9996
2 25994  97.9259   6.8458 0003619  97.5158  53.8420 14.61201500432301
AQUA
1 27424U 02022A   26323.61011075  .00000767  00000+0  16196-3 0  9997
2 27424  98.4498 296.1804 0001291 106.5025  24.9768 14.62288695305987
SUOMI NPP
1 37849U 11061A   26323.61984380  .00000071  00000+0  54776-4 0  9995
2 37849  98.8125 263.5321 0000902 210.2715 149.8409 14.19544508780491`,

  starlink: `STARLINK-1008
1 44714U 19074B   26323.57192211  .00149335  00000+0  11636-2 0  9998
2 44714  53.1435  31.7169 0004843   7.1443 352.9643 15.70746394388498
STARLINK-37410
1 68823U 26089X   26323.15123876  .00027853  00000+0  86169-3 0  9998
2 68823  97.2808 168.1155 0002588  84.2178 275.9360 15.33450475 32401
STARLINK-30515
1 57983U 23151V   26323.16990222  .00003911  00000+0  15159-3 0  9998
2 57983  42.9953 356.8442 0001247 228.7071 131.3673 15.27574201174469
STARLINK-2361
1 47901U 21021AT  26323.58335648  .00064378  00000+0  45533-3 0  9995
2 47901  53.1485 129.7449 0001224  91.2421  85.7769 15.73417260  5961
STARLINK-1012
1 44718U 19074F   26323.61287655  .00057092  00000+0  44631-3 0  9994
2 44718  53.1467  31.6205 0001392 128.5656 231.5487 15.71098901388490
STARLINK-1114
1 44927U 20001P   26323.59883941  .01281868  13286-2  71365-3 0  9993
2 44927  53.0201 141.6413 0003365 298.5532  61.5166 16.19062888380230
STARLINK-1042
1 44747U 19074AL  26323.21549198  .00066902  00000+0  61351-3 0  9993
2 44747  53.0370 300.1387 0001146  55.1458 304.9665 15.67150314389723
STARLINK-1063
1 44768U 19074BH  26323.58203137  .00204285  00000+0  15271-2 0  9993
2 44768  53.1448  74.1594 0002808 353.2666   6.8314 15.71561124387918
STARLINK-1134
1 45048U 20006E   26322.49344646  .00105897  00000+0  62614-3 0  9995
2 45048  53.0171  78.7349 0004110 297.2975  62.7625 15.77316665376792
STARLINK-1168
1 45072U 20006AE  26323.66671296 -.00043572  00000+0 -33796-3 0  9998
2 45072  53.1487 136.5631 0001532  72.8248  55.0985 15.70992680  5818
STARLINK-1020
1 44725U 19074N   26323.42426975  .00085325  00000+0  50888-3 0  9992
2 44725  53.1450  50.5652 0001167   4.9696 355.1337 15.77221730388195
STARLINK-1131
1 45047U 20006D   26322.52465759  .00080142  00000+0  56870-3 0  9999
2 45047  53.1466 135.6778 0000703  66.1764 293.9329 15.73252098376054
STARLINK-1153
1 45080U 20006AN  26323.66671296 -.00048359  00000+0 -38349-3 0  9994
2 45080  53.1484 132.3928 0001509  67.8005  72.2764 15.70512724  4931
STARLINK-1043
1 44748U 19074AM  26323.37724391  .00128178  00000+0  54846-3 0  9996
2 44748  53.0407  21.3214 0004902  27.1353 332.9925 15.84267474388579
STARLINK-1183
1 45088U 20006AW  26323.60963512  .00049171  00000+0  43696-3 0  9993
2 45088  53.1497 121.2952 0001830  60.0355 300.0844 15.68055810376351
STARLINK-1167
1 45071U 20006AD  26322.49615953  .00052264  00000+0  50961-3 0  9994
2 45071  53.1482 138.7695 0001458  64.9714 295.1453 15.65727831376011
STARLINK-1156
1 45054U 20006L   26323.66671296  .00041660  00000+0  36594-3 0  9991
2 45054  53.1508 160.3572 0001611  97.2240  95.2721 15.68413807  4934
STARLINK-1230
1 45189U 20012M   26323.66671296  .00355131  00000+0  30927-2 0  9991
2 45189  53.1500 279.5496 0001391  95.9340 244.0046 15.67387714  5845
STARLINK-1123
1 44930U 20001S   26323.61430268  .00095377  00000+0  48275-3 0  9998
2 44930  53.1305 186.4734 0005344 128.3876 231.7627 15.80796787379659
STARLINK-1046
1 44751U 19074AQ  26323.39850382  .00100300  00000+0  52989-3 0  9995
2 44751  53.0410  47.7612 0001255  15.2019 344.9039 15.79853200388207
STARLINK-1166
1 45060U 20006S   26323.66671296  .00295319  45751-4  70983-3 0  9997
2 45060  53.0278  96.0712 0001912 302.3919 138.4121 15.96009620  5875`,
};

const BASELINE_FLIGHTS = [
  { dLat: 0.0824, dLon: -0.1142, alt_baro: 4200, alt_geom: 4325, gs: 218.4, track: 184.2, baro_rate: -960, flight: 'AAL1421', hex: 'a12b34', r: 'N912AA', t: 'A319', dbFlags: 0, squawk: '2140', category: 'A3' },
  { dLat: -0.145, dLon: 0.212, alt_baro: 11800, alt_geom: 12050, gs: 312.5, track: 35.1, baro_rate: 1472, flight: 'UAL418', hex: 'a45d92', r: 'N37518', t: 'B739', dbFlags: 0, squawk: '3412', category: 'A3' },
  { dLat: 0.241, dLon: -0.318, alt_baro: 34000, alt_geom: 34950, gs: 468.2, track: 72.6, baro_rate: 0, flight: 'DAL882', hex: 'a7c811', r: 'N822DN', t: 'B739', dbFlags: 0, squawk: '1521', category: 'A3' },
  { dLat: -0.312, dLon: -0.194, alt_baro: 28500, alt_geom: 29400, gs: 442.0, track: 256.8, baro_rate: -640, flight: 'JIA5473', hex: 'a6652b', r: 'N511AE', t: 'CRJ7', dbFlags: 0, squawk: '3624', category: 'A2' },
  { dLat: 0.165, dLon: 0.278, alt_baro: 18400, alt_geom: 18925, gs: 355.8, track: 144.3, baro_rate: 1920, flight: 'SWA2104', hex: 'a91f44', r: 'N8721J', t: 'B38M', dbFlags: 0, squawk: '4215', category: 'A3' },
  { dLat: -0.068, dLon: -0.052, alt_baro: 1500, alt_geom: 1625, gs: 112.0, track: 318.0, baro_rate: 0, flight: 'PAT21', hex: 'ae104f', r: '19-21041', t: 'UH60', dbFlags: 1, squawk: '0342', category: 'A7' },
  { dLat: 0.415, dLon: 0.104, alt_baro: 24000, alt_geom: 24750, gs: 388.4, track: 205.5, baro_rate: -512, flight: 'RCH409', hex: 'ae5c12', r: '08-8194', t: 'C17', dbFlags: 1, squawk: '5107', category: 'A5' },
  { dLat: -0.228, dLon: 0.412, alt_baro: 37000, alt_geom: 38100, gs: 486.7, track: 54.9, baro_rate: 0, flight: 'BAW216', hex: '40768a', r: 'G-ZBKB', t: 'B789', dbFlags: 0, squawk: '2204', category: 'A5' },
  { dLat: 0.044, dLon: -0.342, alt_baro: 6800, alt_geom: 7025, gs: 234.1, track: 98.4, baro_rate: -832, flight: 'RPA4512', hex: 'a24720', r: 'N246JQ', t: 'E75L', dbFlags: 0, squawk: '1702', category: 'A3' },
  { dLat: -0.442, dLon: -0.285, alt_baro: 9400, alt_geom: 9675, gs: 176.2, track: 19.8, baro_rate: 512, flight: 'N418CP', hex: 'a4f310', r: 'N418CP', t: 'PC12', dbFlags: 0, squawk: '1200', category: 'A1' },
];

const BASELINE_AIRSPACE = {
  uasfm: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          CEILING: 0,
          UNIT: 'Feet',
          APT1_FAAID: 'IAD',
          APT1_ICAO: 'KIAD',
          APT1_NAME: 'Washington Dulles Intl',
          AIRSPACE_1: 'B',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[[-77.48, 38.92], [-77.43, 38.92], [-77.43, 38.97], [-77.48, 38.97], [-77.48, 38.92]]],
        },
      },
      {
        type: 'Feature',
        properties: {
          CEILING: 100,
          UNIT: 'Feet',
          APT1_FAAID: 'IAD',
          APT1_ICAO: 'KIAD',
          APT1_NAME: 'Washington Dulles Intl',
          AIRSPACE_1: 'B',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[[-77.53, 38.90], [-77.48, 38.90], [-77.48, 38.95], [-77.53, 38.95], [-77.53, 38.90]]],
        },
      },
      {
        type: 'Feature',
        properties: {
          CEILING: 200,
          UNIT: 'Feet',
          APT1_FAAID: 'HEF',
          APT1_ICAO: 'KHEF',
          APT1_NAME: 'Manassas Regional',
          AIRSPACE_1: 'D',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[[-77.55, 38.80], [-77.50, 38.80], [-77.50, 38.85], [-77.55, 38.85], [-77.55, 38.80]]],
        },
      },
      {
        type: 'Feature',
        properties: {
          CEILING: 400,
          UNIT: 'Feet',
          APT1_FAAID: 'IAD',
          APT1_ICAO: 'KIAD',
          APT1_NAME: 'Washington Dulles Intl',
          AIRSPACE_1: 'B',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[[-77.40, 38.86], [-77.33, 38.86], [-77.33, 38.92], [-77.40, 38.92], [-77.40, 38.86]]],
        },
      },
    ],
  },
  sua: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          NAME: 'P-56A WASHINGTON DC FRZ',
          TYPE_CODE: 'P',
          UPPER_VAL: '18000',
          UPPER_UOM: 'FT',
          LOWER_VAL: '0',
          LOWER_UOM: 'FT',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[[-77.08, 38.87], [-77.00, 38.87], [-77.00, 38.92], [-77.08, 38.92], [-77.08, 38.87]]],
        },
      },
    ],
  },
};

function computeTleChecksum(line) {
  let sum = 0;
  for (let i = 0; i < 68; i += 1) {
    const ch = line[i];
    if (ch >= '0' && ch <= '9') {
      sum += ch.charCodeAt(0) - 48;
    } else if (ch === '-') {
      sum += 1;
    }
  }
  return sum % 10;
}

function isValidTleLine(line, lineNum) {
  if (typeof line !== 'string' || line.length < 69) return false;
  if (!line.startsWith(`${lineNum} `) || !/^\d{5}/.test(line.slice(2, 7))) return false;
  const expected = computeTleChecksum(line);
  const actual = Number.parseInt(line[68], 10);
  return Number.isInteger(actual) && expected === actual;
}

function parseThreeLineTles(rawText, { filterOperational = false, limit = Infinity } = {}) {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const entries = [];
  const seenNorad = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // Handle 2-line entry lacking a name header
      if (line.startsWith('1 ') && i + 1 < lines.length && lines[i + 1].startsWith('2 ')) {
        const line1 = line;
        const line2 = lines[i + 1];
        const noradId = line1.slice(2, 7).trim();
        if (
          isValidTleLine(line1, 1) &&
          isValidTleLine(line2, 2) &&
          noradId === line2.slice(2, 7).trim() &&
          !seenNorad.has(noradId)
        ) {
          const name = `NORAD ${noradId}`;
          const meanMotion = Number.parseFloat(line2.slice(52, 63));
          if (!filterOperational || (Number.isFinite(meanMotion) && meanMotion <= 16.2)) {
            seenNorad.add(noradId);
            entries.push({ name, line1, line2 });
          }
          i += 1;
        }
      }
      continue;
    }

    if (i + 2 >= lines.length) break;
    const rawName = line.replace(/^0\s+/, '').trim();
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    const noradId = line1.slice(2, 7).trim();

    if (
      rawName.length > 0 &&
      isValidTleLine(line1, 1) &&
      isValidTleLine(line2, 2) &&
      noradId === line2.slice(2, 7).trim() &&
      !seenNorad.has(noradId)
    ) {
      const meanMotion = Number.parseFloat(line2.slice(52, 63));
      const operationalOk =
        !filterOperational ||
        (!/\b(DEB|R\/B)\b/i.test(rawName) &&
          !/\[DECAYED\]/i.test(rawName) &&
          Number.isFinite(meanMotion) &&
          meanMotion <= 16.2);

      if (operationalOk) {
        seenNorad.add(noradId);
        entries.push({ name: rawName, line1, line2 });
        if (entries.length >= limit) break;
      }
      i += 2;
    }
  }

  return entries;
}

function serializeThreeLineTles(entries) {
  return `${entries.map((entry) => `${entry.name}\n${entry.line1}\n${entry.line2}`).join('\n')}\n`;
}

async function fetchWithTimeout(url, accept) {
  const response = await fetch(url, {
    headers: { Accept: accept },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response;
}

async function readExistingTleEntries(filePath, options) {
  try {
    const content = await readFile(filePath, 'utf8');
    return parseThreeLineTles(content, options);
  } catch {
    return [];
  }
}

async function readExistingJson(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function seedTleGroup(group) {
  const outPath = path.join(TLE_DIR, `${group}.tle`);
  const parseOpts =
    group === 'starlink'
      ? { filterOperational: true, limit: STARLINK_MAX_ENTRIES }
      : { filterOperational: false, limit: Infinity };

  const baselineEntries = parseThreeLineTles(BASELINE_TLES[group], parseOpts);
  let liveEntries = [];

  try {
    const response = await fetchWithTimeout(CELESTRAK_GROUP_URLS[group], 'text/plain, */*');
    const text = await response.text();
    liveEntries = parseThreeLineTles(text, parseOpts);
  } catch (err) {
    console.warn(`[tle:${group}] CelesTrak fetch failed: ${err.message}`);
  }

  if (liveEntries.length > 0) {
    await writeFile(outPath, serializeThreeLineTles(liveEntries), 'utf8');
    console.log(`[tle:${group}] wrote ${liveEntries.length} live entries -> ${outPath}`);
    return;
  }

  const existingEntries = await readExistingTleEntries(outPath, parseOpts);
  if (existingEntries.length > baselineEntries.length) {
    console.log(
      `[tle:${group}] preserved existing snapshot (${existingEntries.length} entries) -> ${outPath}`
    );
    return;
  }

  await writeFile(outPath, serializeThreeLineTles(baselineEntries), 'utf8');
  console.log(`[tle:${group}] wrote ${baselineEntries.length} baseline entries -> ${outPath}`);
}

function normalizeFlightRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.lat !== 'number' || !Number.isFinite(raw.lat)) return null;
  if (typeof raw.lon !== 'number' || !Number.isFinite(raw.lon)) return null;
  if (typeof raw.hex !== 'string' || raw.hex.trim().length === 0) return null;

  return {
    dLat: Number((raw.lat - ORIGIN.lat).toFixed(6)),
    dLon: Number((raw.lon - ORIGIN.lon).toFixed(6)),
    alt_baro:
      raw.alt_baro === 'ground' || (typeof raw.alt_baro === 'number' && Number.isFinite(raw.alt_baro))
        ? raw.alt_baro
        : null,
    alt_geom: typeof raw.alt_geom === 'number' && Number.isFinite(raw.alt_geom) ? raw.alt_geom : null,
    gs: typeof raw.gs === 'number' && Number.isFinite(raw.gs) ? raw.gs : null,
    track: typeof raw.track === 'number' && Number.isFinite(raw.track) ? raw.track : null,
    baro_rate:
      typeof raw.baro_rate === 'number' && Number.isFinite(raw.baro_rate) ? raw.baro_rate : null,
    flight: typeof raw.flight === 'string' ? raw.flight.trim() : '',
    hex: raw.hex.trim().toLowerCase(),
    r: typeof raw.r === 'string' ? raw.r.trim() : '',
    t: typeof raw.t === 'string' ? raw.t.trim() : '',
    dbFlags: typeof raw.dbFlags === 'number' && Number.isFinite(raw.dbFlags) ? raw.dbFlags : 0,
    squawk: typeof raw.squawk === 'string' ? raw.squawk.trim() : '',
    category: typeof raw.category === 'string' ? raw.category.trim() : '',
  };
}

async function seedFlights() {
  const outPath = path.join(DATA_DIR, 'fallback-flights.json');
  let records = [];
  let source = 'embedded-baseline';

  try {
    const response = await fetchWithTimeout(ADSB_LIVE_URL, 'application/json');
    const payload = await response.json();
    if (Array.isArray(payload?.ac)) {
      records = payload.ac
        .map(normalizeFlightRecord)
        .filter(Boolean)
        .sort((a, b) => a.dLat * a.dLat + a.dLon * a.dLon - (b.dLat * b.dLat + b.dLon * b.dLon))
        .slice(0, FLIGHTS_MAX_ENTRIES);
      if (records.length > 0) {
        source = 'adsb.lol';
      }
    }
  } catch (err) {
    console.warn(`[flights] ADS-B fetch failed: ${err.message}`);
  }

  if (records.length === 0) {
    const existing = await readExistingJson(outPath);
    if (Array.isArray(existing?.ac) && existing.ac.length > BASELINE_FLIGHTS.length) {
      console.log(`[flights] preserved existing snapshot (${existing.ac.length} records) -> ${outPath}`);
      return;
    }
    records = BASELINE_FLIGHTS;
  }

  const output = {
    origin: ORIGIN,
    generatedAt: new Date().toISOString(),
    source,
    count: records.length,
    ac: records,
  };

  await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`[flights] wrote ${records.length} records (${source}) -> ${outPath}`);
}

function isValidFeatureCollection(data) {
  return Boolean(data && data.type === 'FeatureCollection' && Array.isArray(data.features));
}

async function fetchGeoJsonLayer(url, label) {
  try {
    const response = await fetchWithTimeout(url, 'application/geo+json, application/json');
    const payload = await response.json();
    if (isValidFeatureCollection(payload) && payload.features.length > 0) {
      return { fc: payload, live: true };
    }
    console.warn(`[airspace:${label}] upstream returned empty/invalid GeoJSON`);
  } catch (err) {
    console.warn(`[airspace:${label}] fetch failed: ${err.message}`);
  }
  return { fc: null, live: false };
}

async function seedAirspace() {
  const outPath = path.join(DATA_DIR, 'fallback-airspace.geojson');
  const existing = await readExistingJson(outPath);

  const [uasfmResult, suaResult] = await Promise.all([
    fetchGeoJsonLayer(FAA_UASFM_URL, 'uasfm'),
    fetchGeoJsonLayer(FAA_SUA_URL, 'sua'),
  ]);

  const uasfm =
    uasfmResult.fc ??
    (isValidFeatureCollection(existing?.uasfm) && existing.uasfm.features.length > 0
      ? existing.uasfm
      : BASELINE_AIRSPACE.uasfm);

  const sua =
    suaResult.fc ??
    (isValidFeatureCollection(existing?.sua) && existing.sua.features.length > 0
      ? existing.sua
      : BASELINE_AIRSPACE.sua);

  const output = { uasfm, sua };
  await writeFile(outPath, `${JSON.stringify(output)}\n`, 'utf8');
  console.log(
    `[airspace] wrote uasfm=${uasfm.features.length} (${uasfmResult.live ? 'live' : 'fallback'}), ` +
      `sua=${sua.features.length} (${suaResult.live ? 'live' : 'fallback'}) -> ${outPath}`
  );
}

async function main() {
  await mkdir(TLE_DIR, { recursive: true });
  await seedTleGroup('stations');
  await seedTleGroup('visual');
  await seedTleGroup('starlink');
  await seedFlights();
  await seedAirspace();
}

await main();
