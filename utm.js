// WGS84 UTM conversion. Stage106 only uses Zone 39N for NCC production data,
// but the functions accept any standard UTM zone and hemisphere.
const A = 6378137.0;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);

const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

export function normalizeHeading(value) {
  const n = Number(value);
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : 0;
}

export function wgs84ToUtm(lonDeg, latDeg, zone = 39) {
  const lon = rad(Number(lonDeg));
  const lat = rad(Number(latDeg));
  const lon0 = rad((zone - 1) * 6 - 180 + 3);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const tanLat = Math.tan(lat);
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const T = tanLat * tanLat;
  const C = EP2 * cosLat * cosLat;
  const AA = cosLat * (lon - lon0);
  const M = A * (
    (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256) * lat
    - (3 * E2 / 8 + 3 * E2 * E2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * lat)
    + (15 * E2 * E2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * lat)
    - (35 * E2 ** 3 / 3072) * Math.sin(6 * lat)
  );
  let easting = K0 * N * (AA + (1 - T + C) * AA ** 3 / 6 + (5 - 18 * T + T ** 2 + 72 * C - 58 * EP2) * AA ** 5 / 120) + 500000;
  let northing = K0 * (M + N * tanLat * (AA ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * AA ** 4 / 24 + (61 - 58 * T + T ** 2 + 600 * C - 330 * EP2) * AA ** 6 / 720));
  const northern = latDeg >= 0;
  if (!northern) northing += 10000000;
  return { easting, northing, zone, northern };
}

export function utmToWgs84(easting, northing, zone = 39, northern = true) {
  const x = Number(easting) - 500000;
  let y = Number(northing);
  if (!northern) y -= 10000000;
  const M = y / K0;
  const mu = M / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const J1 = 3 * e1 / 2 - 27 * e1 ** 3 / 32;
  const J2 = 21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32;
  const J3 = 151 * e1 ** 3 / 96;
  const J4 = 1097 * e1 ** 4 / 512;
  const fp = mu + J1 * Math.sin(2 * mu) + J2 * Math.sin(4 * mu) + J3 * Math.sin(6 * mu) + J4 * Math.sin(8 * mu);
  const sinFp = Math.sin(fp);
  const cosFp = Math.cos(fp);
  const tanFp = Math.tan(fp);
  const C1 = EP2 * cosFp ** 2;
  const T1 = tanFp ** 2;
  const N1 = A / Math.sqrt(1 - E2 * sinFp ** 2);
  const R1 = A * (1 - E2) / Math.pow(1 - E2 * sinFp ** 2, 1.5);
  const D = x / (N1 * K0);
  const lat = fp - (N1 * tanFp / R1) * (
    D ** 2 / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * EP2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * EP2 - 3 * C1 ** 2) * D ** 6 / 720
  );
  const lon0 = rad((zone - 1) * 6 - 180 + 3);
  const lon = lon0 + (
    D
    - (1 + 2 * T1 + C1) * D ** 3 / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * EP2 + 24 * T1 ** 2) * D ** 5 / 120
  ) / cosFp;
  return { longitude: deg(lon), latitude: deg(lat) };
}

export function runtimeUtmToModel(easting, northing, transform) {
  const { A: a, B: b, TE, TN } = transform;
  const denom = a * a + b * b;
  const de = Number(easting) - TE;
  const dn = Number(northing) - TN;
  return {
    x: (a * de + b * dn) / denom,
    z: (b * de - a * dn) / denom,
  };
}

export function projectStep(easting, northing, stepLengthM, headingDeg) {
  const heading = rad(normalizeHeading(headingDeg));
  return {
    easting: Number(easting) + Number(stepLengthM) * Math.sin(heading),
    northing: Number(northing) + Number(stepLengthM) * Math.cos(heading),
  };
}

export function wgs84ToUtm39(lonDeg, latDeg) {
  return wgs84ToUtm(lonDeg, latDeg, 39);
}

export function utm39ToWgs84(easting, northing) {
  return utmToWgs84(easting, northing, 39, true);
}
