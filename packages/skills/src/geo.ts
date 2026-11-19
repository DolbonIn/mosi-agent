/**
 * Coordinate helpers (original implementation, standard geodesy formulas).
 *
 * Opinet (한국석유공사) expects KATEC coordinates: a Transverse Mercator projection on the Bessel 1841
 * ellipsoid (lat0 38°N, lon0 128°E, k0 0.9999, false easting 400 000 m, false northing 600 000 m).
 * Kakao returns WGS84, so we shift the datum (WGS84 → Korean Bessel, 3-parameter geocentric shift)
 * and then project.
 */

interface Ellipsoid {
  a: number;
  f: number;
}

const WGS84: Ellipsoid = { a: 6378137, f: 1 / 298.257223563 };
const BESSEL: Ellipsoid = { a: 6377397.155, f: 1 / 299.1528128 };
/** Korean Bessel → WGS84 geocentric translation (metres); we apply its inverse. */
const BESSEL_TO_WGS84 = { dx: -146.43, dy: 507.89, dz: 681.46 };

const KATEC = { lat0: 38, lon0: 128, k0: 0.9999, fe: 400000, fn: 600000 };

const rad = (deg: number): number => (deg * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;

function toEcef(latDeg: number, lonDeg: number, e: Ellipsoid): [number, number, number] {
  const es = 2 * e.f - e.f * e.f;
  const lat = rad(latDeg);
  const lon = rad(lonDeg);
  const n = e.a / Math.sqrt(1 - es * Math.sin(lat) ** 2);
  return [n * Math.cos(lat) * Math.cos(lon), n * Math.cos(lat) * Math.sin(lon), n * (1 - es) * Math.sin(lat)];
}

function fromEcef(x: number, y: number, z: number, e: Ellipsoid): { lat: number; lon: number } {
  const es = 2 * e.f - e.f * e.f;
  const p = Math.sqrt(x * x + y * y);
  const lon = Math.atan2(y, x);
  let lat = Math.atan2(z, p * (1 - es));
  for (let i = 0; i < 6; i++) {
    const n = e.a / Math.sqrt(1 - es * Math.sin(lat) ** 2);
    lat = Math.atan2(z + es * n * Math.sin(lat), p);
  }
  return { lat: deg(lat), lon: deg(lon) };
}

/** Meridional arc length from the equator to latitude `phi` (radians). */
function meridianArc(phi: number, e: Ellipsoid): number {
  const es = 2 * e.f - e.f * e.f;
  const e4 = es * es;
  const e6 = e4 * es;
  return (
    e.a *
    ((1 - es / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * es) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi))
  );
}

/** WGS84 latitude/longitude (degrees) → KATEC x/y (metres), as Opinet `aroundAll` expects. */
export function wgs84ToKatec(lat: number, lon: number): { x: number; y: number } {
  const [wx, wy, wz] = toEcef(lat, lon, WGS84);
  const b = fromEcef(wx - BESSEL_TO_WGS84.dx, wy - BESSEL_TO_WGS84.dy, wz - BESSEL_TO_WGS84.dz, BESSEL);
  const e = BESSEL;
  const es = 2 * e.f - e.f * e.f;
  const ep2 = es / (1 - es);
  const phi = rad(b.lat);
  const n = e.a / Math.sqrt(1 - es * Math.sin(phi) ** 2);
  const t = Math.tan(phi) ** 2;
  const c = ep2 * Math.cos(phi) ** 2;
  const a = (rad(b.lon) - rad(KATEC.lon0)) * Math.cos(phi);
  const m = meridianArc(phi, e);
  const m0 = meridianArc(rad(KATEC.lat0), e);
  const x =
    KATEC.fe +
    KATEC.k0 * n * (a + ((1 - t + c) * a ** 3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * ep2) * a ** 5) / 120);
  const y =
    KATEC.fn +
    KATEC.k0 *
      (m -
        m0 +
        n *
          Math.tan(phi) *
          ((a * a) / 2 + ((5 - t + 9 * c + 4 * c * c) * a ** 4) / 24 + ((61 - 58 * t + t * t + 600 * c - 330 * ep2) * a ** 6) / 720));
  return { x, y };
}

/** Great-circle distance in metres. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371008.8;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface LatLon {
  lat: number;
  lon: number;
}

/** Fallback coordinates for major Korean places when geocoding is unavailable. */
export const CITY_COORDS: Record<string, LatLon> = {
  서울: { lat: 37.5665, lon: 126.978 },
  부산: { lat: 35.1796, lon: 129.0756 },
  대구: { lat: 35.8714, lon: 128.6014 },
  인천: { lat: 37.4563, lon: 126.7052 },
  광주: { lat: 35.1595, lon: 126.8526 },
  대전: { lat: 36.3504, lon: 127.3845 },
  울산: { lat: 35.5384, lon: 129.3114 },
  세종: { lat: 36.48, lon: 127.289 },
  수원: { lat: 37.2636, lon: 127.0286 },
  성남: { lat: 37.42, lon: 127.1265 },
  고양: { lat: 37.6584, lon: 126.832 },
  용인: { lat: 37.2411, lon: 127.1776 },
  창원: { lat: 35.2281, lon: 128.6811 },
  청주: { lat: 36.6424, lon: 127.489 },
  전주: { lat: 35.8242, lon: 127.148 },
  천안: { lat: 36.8151, lon: 127.1139 },
  포항: { lat: 36.019, lon: 129.3435 },
  제주: { lat: 33.4996, lon: 126.5312 },
  서귀포: { lat: 33.2541, lon: 126.56 },
  강릉: { lat: 37.7519, lon: 128.8761 },
  춘천: { lat: 37.8813, lon: 127.7298 },
  원주: { lat: 37.3422, lon: 127.9202 },
  여수: { lat: 34.7604, lon: 127.6622 },
  목포: { lat: 34.8118, lon: 126.3922 },
  경주: { lat: 35.8562, lon: 129.2247 },
  안동: { lat: 36.5684, lon: 128.7294 },
  김해: { lat: 35.2285, lon: 128.8894 },
  속초: { lat: 38.207, lon: 128.5918 },
};

/** Best-effort lookup in the built-in table ("서울특별시 강남구" → 서울, "부산역" → 부산). */
export function cityFallback(place: string): (LatLon & { name: string }) | null {
  const p = place.trim();
  // "부산", "부산 해운대", "부산시", "부산광역시", "부산역" — but not "세종문화회관" or "고양이카페"
  const boundary = /^(?:특별시|광역시|특별자치시|특별자치도|시|도|역|공항|\s|$)/;
  for (const [name, c] of Object.entries(CITY_COORDS)) {
    if (p.startsWith(name) && boundary.test(p.slice(name.length))) return { name, ...c };
  }
  return null;
}
