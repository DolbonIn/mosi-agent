import type { WeatherCard } from "@pickle/protocol";
import type { IconName } from "@pickle/protocol";
import { geocode, regionOf } from "../geocode";
import { proxyGet, type ProxyError } from "../http";
import { addDays, defineSkill, fail, failText, int, kst, mdDow, pad, schema, str, type Kst } from "../util";

interface KmaItem {
  category: string;
  obsrValue?: string;
  fcstDate?: string;
  fcstTime?: string;
  fcstValue?: string;
}
export interface KmaResponse {
  response?: { header?: { resultCode?: string; resultMsg?: string }; body?: { items?: { item?: KmaItem[] } } };
  query?: { baseDate?: string; baseTime?: string; nx?: number; ny?: number };
}

const PTY: Record<string, string> = { "1": "비", "2": "비/눈", "3": "눈", "4": "소나기", "5": "빗방울", "6": "빗방울/눈날림", "7": "눈날림" };
const SKY: Record<string, string> = { "1": "맑음", "3": "구름많음", "4": "흐림" };

export function condition(sky: string | undefined, pty: string | undefined): { text: string; icon: IconName } {
  if (pty && pty !== "0" && PTY[pty]) return { text: PTY[pty], icon: "cloud" };
  if (sky && SKY[sky]) return { text: SKY[sky], icon: sky === "1" ? "sun" : "cloud" };
  return { text: "정보 없음", icon: "cloud" };
}

interface Slot {
  date: string;
  time: string;
  [category: string]: string;
}

export function slotsOf(items: KmaItem[]): Slot[] {
  const map = new Map<string, Slot>();
  for (const it of items) {
    if (!it.fcstDate || !it.fcstTime || it.fcstValue === undefined) continue;
    const key = it.fcstDate + it.fcstTime;
    let s = map.get(key);
    if (!s) {
      s = { date: it.fcstDate, time: it.fcstTime };
      map.set(key, s);
    }
    s[it.category] = it.fcstValue;
  }
  return [...map.values()].sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
}

function n(v: string | undefined): number | null {
  if (v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) && x > -900 && x < 900 ? x : null;
}

/**
 * Daily high/low/condition. `fromHour` = first hour still covered by the forecast for that day: once the
 * daytime peak (15시) or the morning low (06시) is in the past and KMA no longer publishes TMX/TMN for the
 * day, we report null instead of the max/min of the remaining evening hours.
 */
export function dailySummary(
  slots: Slot[],
  date: string,
  fromHour = 0,
): { date: string; high: number | null; low: number | null; condition: string; pop: number | null } {
  const day = slots.filter((s) => s.date === date);
  const temps = day.map((s) => n(s.TMP)).filter((x): x is number => x !== null);
  const tmx = day.map((s) => n(s.TMX)).find((x) => x !== null) ?? null;
  const tmn = day.map((s) => n(s.TMN)).find((x) => x !== null) ?? null;
  const high = tmx ?? (temps.length && fromHour <= 15 ? Math.max(...temps) : null);
  const low = tmn ?? (temps.length && fromHour <= 6 ? Math.min(...temps) : null);
  const pops = day.map((s) => n(s.POP)).filter((x): x is number => x !== null);
  // representative condition: rain/snow anywhere in daytime wins, else the noon sky
  const daytime = day.filter((s) => s.time >= "0900" && s.time <= "1800");
  const wet = daytime.find((s) => s.PTY && s.PTY !== "0");
  const noon = day.find((s) => s.time === "1200") ?? daytime[0] ?? day[0];
  const cond = wet ? condition(undefined, wet.PTY).text : condition(noon?.SKY, noon?.PTY).text;
  return { date, high, low, condition: cond, pop: pops.length ? Math.max(...pops) : null };
}

/** KST hours shown as night: a clear sky reads as the moon from 19시 to 5시 */
export const isNightHour = (hh: number) => hh >= 19 || hh < 6;

/** `condition().icon` at a given hour: the clear-sky sun becomes the moon at night */
const iconAt = (icon: IconName, hh: number): IconName => (icon === "sun" && isNightHour(hh) ? "moon" : icon);

export function buildWeather(
  placeLabel: string,
  now: KmaResponse | null,
  forecast: KmaResponse | null,
  t: Kst,
  days: number,
): { card: WeatherCard; data: Record<string, unknown>; summary: string } | null {
  const obs = new Map<string, string>();
  for (const it of now?.response?.body?.items?.item ?? []) if (it.obsrValue !== undefined) obs.set(it.category, it.obsrValue);
  const slots = slotsOf(forecast?.response?.body?.items?.item ?? []);
  const nowKey = t.ymd + pad(t.hh) + "00";
  const upcoming = slots.filter((s) => s.date + s.time >= nowKey);
  const current = upcoming[0] ?? slots[slots.length - 1];

  const temp = n(obs.get("T1H")) ?? n(current?.TMP);
  if (temp === null) return null;
  // the observed precipitation type (초단기실황) beats the forecast, including an observed "0" (no rain)
  const cond = condition(current?.SKY, obs.has("PTY") ? obs.get("PTY") : current?.PTY);
  const today = dailySummary(slots, t.ymd, t.hh);
  const high = today.high !== null ? Math.max(today.high, temp) : null;
  const low = today.low !== null ? Math.min(today.low, temp) : null;
  const tomorrow = dailySummary(slots, addDays(t.ymd, 1));

  const hourly = upcoming.filter((s) => s.date + s.time > nowKey).slice(0, 8).flatMap((s) => {
    const tc = n(s.TMP);
    if (tc === null) return [];
    const c = condition(s.SKY, s.PTY);
    const hh = +s.time.slice(0, 2);
    return [{ hour: `${hh}시`, tempC: tc, icon: iconAt(c.icon, hh), pop: n(s.POP) ?? undefined, condition: c.text }];
  });

  const daily = days > 0 ? Array.from({ length: days }, (_, i) => dailySummary(slots, addDays(t.ymd, i + 1))).filter((d) => d.high !== null) : [];

  const card: WeatherCard = {
    type: "weather",
    place: placeLabel,
    now: { tempC: Math.round(temp * 10) / 10, condition: cond.text, icon: iconAt(cond.icon, t.hh) },
    high: high ?? undefined,
    low: low ?? undefined,
    hourly: hourly.map(({ hour, tempC, icon, pop }) => ({ hour, tempC, icon, pop })),
    source: "기상청",
  };
  const humidity = n(obs.get("REH"));
  const rain1h = n(obs.get("RN1"));
  const wind = n(obs.get("WSD"));
  const data: Record<string, unknown> = {
    place: placeLabel,
    observedAt: now?.query?.baseDate && now.query.baseTime ? `${now.query.baseDate} ${now.query.baseTime}` : undefined,
    now: { tempC: temp, condition: cond.text, humidity, rain1hMm: rain1h, windMs: wind },
    today: { high, low, maxPop: today.pop },
    tomorrow: tomorrow.high !== null ? { ...tomorrow, date: mdDow(tomorrow.date) } : undefined,
    hourly: hourly.map((h) => ({ hour: h.hour, tempC: h.tempC, condition: h.condition, pop: h.pop })),
    daily: daily.length ? daily.map((d) => ({ ...d, date: mdDow(d.date) })) : undefined,
    source: "기상청 초단기실황·단기예보",
  };
  const hl =
    high !== null && low !== null
      ? ` · 최고 ${Math.round(high)}° / 최저 ${Math.round(low)}°`
      : tomorrow.high !== null && tomorrow.low !== null
        ? ` · 내일 ${tomorrow.condition} ${Math.round(tomorrow.low)}~${Math.round(tomorrow.high)}°`
        : "";
  const pop = today.pop !== null && today.pop >= 30 ? ` · 강수확률 ${today.pop}%` : "";
  return { card, data, summary: `${placeLabel} ${Math.round(temp)}°, ${cond.text}${hl}${pop}` };
}

function weatherError(err: ProxyError): string {
  return err.kind === "timeout" ? "날씨: 기상청 응답이 늦어요" : err.kind === "upstream" ? "날씨: 지금은 기상청 응답이 원활하지 않아요" : "";
}

export const kWeather = defineSkill({
  name: "k_weather",
  description:
    "Current weather and short-term forecast for a place in South Korea (Korea Meteorological Administration, via k-skill). " +
    "Use for any Korean weather question (today/tomorrow/this week, rain, temperature). " +
    "`place` is a Korean place name (station, district, landmark or city, e.g. '강남역', '부산', '제주공항'); " +
    "`days` adds a daily outlook for the next N days (0-3, default 0 = today only).",
  parameters: schema(
    {
      place: { type: "string", description: "Korean place name, e.g. '강남역', '부산 해운대', '서울'" },
      days: { type: "integer", minimum: 0, maximum: 3, description: "extra forecast days (0-3), default 0" },
    },
    ["place"],
  ),
  icon: "sun",
  title: (a) => `${str(a.place, 30) || "현재 위치"} 날씨 확인`,
  meta: {
    source: "korea-weather",
    title: "날씨",
    description: "기상청 초단기실황·단기예보로 지금 날씨와 시간별·3일 예보를 알려줘요.",
    category: "생활",
    example: "내일 강남역 비 와?",
  },
  async run(a, rc) {
    const place = str(a.place, 60);
    if (!place) return failText("날씨: 어느 지역인지 알려주세요");
    const days = int(a.days, 0, 3, 0);
    rc.status(`${place} 위치 찾는 중`);
    const g = await geocode(place, rc.signal);
    if (!g.ok) return g.error ? fail(g.error, "날씨") : failText(`날씨: ‘${place}’ 위치를 찾지 못했어요`, "not_found");
    const { lat, lon } = g.loc;
    const coords = { lat: lat.toFixed(4), lon: lon.toFixed(4) };
    rc.status("기상청 예보 확인 중");
    const [nowR, fcR] = await Promise.all([
      proxyGet<KmaResponse>("/v1/korea-weather/now", coords, rc.signal),
      proxyGet<KmaResponse>("/v1/korea-weather/forecast", { ...coords, numOfRows: days > 1 ? 1000 : 600 }, rc.signal),
    ]);
    if (!nowR.ok && !fcR.ok) return fail(nowR.error, "날씨", weatherError(nowR.error) || undefined);
    const label = g.loc.via === "kakao" && g.loc.address ? place : g.loc.name;
    const built = buildWeather(label, nowR.ok ? nowR.body : null, fcR.ok ? fcR.body : null, kst(rc.now), days);
    if (!built) return failText("날씨: 기상청 데이터가 비어 있어요", "empty");
    built.data.location = { name: g.loc.name, area: regionOf(g.loc.address) || undefined, via: g.loc.via };
    return { ok: true, summary: built.summary, data: built.data, card: built.card };
  },
});
