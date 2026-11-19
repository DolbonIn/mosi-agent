import type { DashboardWidget } from "@pickle/protocol";
import { BarChart } from "../../../ui/BarChart";
import { Icon } from "../../../ui/Icon";
import { Odometer } from "../../../ui/Odometer";
import { ProgressBar } from "../../../ui/ProgressBar";
import { Note } from "../parts";
import { splitAmount } from "./text";

/**
 * Dashboard artifacts: content is JSON `{ widgets: DashboardWidget[] }`. No panels: the sections lie on the sheet paper
 * with a hairline between them. Stats are tabular figures (a numeric value rolls with the Odometer — only when it
 * changed since the last visit; a percentage also gets a capsule bar). Bars use the chart rule (BarChart: rise once per
 * session, scrub tooltip, hidden table); the accent bar is explained in words beside the section title ("4주 ·
 * 312,000원"). Lists are rows with any trailing amount in its own right-aligned tabular column. Widgets render only when
 * the sheet opens (research §4-5 5-6).
 */

/** "32,400원" → { n: 32400, prefix: "", suffix: "원", pct: false }; "12.5%" → pct; anything else → null */
export function parseStat(raw: string | number): { n: number; prefix: string; suffix: string; pct: boolean; decimals: number } | null {
  const s = String(raw).trim();
  const m = /^([^\d+\-.]{0,3}?)\s*([+-]?\d[\d,]*(?:\.\d+)?)\s*([^\d]{0,4})$/.exec(s);
  if (!m) return null;
  const digits = m[2]!.replace(/,/g, "");
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  const decimals = digits.includes(".") ? digits.split(".")[1]!.length : 0;
  const suffix = m[3] ?? "";
  return { n, prefix: m[1] ?? "", suffix, pct: suffix.trim() === "%", decimals };
}

/** text summary for copy / share */
export function dashboardText(title: string, widgets: DashboardWidget[]): string {
  const lines = [title, ""];
  for (const w of widgets) {
    if (w.type === "stat") lines.push(`${w.label}: ${w.value}${w.delta ? ` (${w.delta})` : ""}`);
    else if (w.type === "bars") lines.push(`${w.label}: ${w.points.map((p) => `${p.x} ${p.y}`).join(", ")}`);
    else lines.push(`${w.label}`, ...w.items.map((it) => `- ${it}`));
  }
  return lines.join("\n");
}

function Delta({ text }: { text: string }) {
  const t = text.trim();
  const dir = t.startsWith("+") || t.startsWith("▲") ? "up" : t.startsWith("-") || t.startsWith("−") || t.startsWith("▼") ? "down" : null;
  return (
    <span className="dash-delta tnum">
      {dir && <Icon name={dir === "up" ? "arrow-up" : "chevron-down"} size={12} weight="semibold" />}
      <span>
        {dir && <span className="sr-only">{dir === "up" ? "증가 " : "감소 "}</span>}
        {t.replace(/^[▲▼]\s*/, "")}
      </span>
    </span>
  );
}

function Stat({ w, id }: { w: Extract<DashboardWidget, { type: "stat" }>; id: string }) {
  const p = parseStat(w.value);
  return (
    <div className="dash-stat">
      <span className="dash-stat__label">{w.label}</span>
      <span className="dash-stat__value tnum">
        {p ? (
          <Odometer
            value={p.n}
            id={id}
            prefix={p.prefix}
            suffix={p.suffix}
            format={(n) => n.toLocaleString("ko-KR", { minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals })}
          />
        ) : (
          String(w.value)
        )}
      </span>
      {w.delta && <Delta text={w.delta} />}
      {p?.pct && (
        <div className="dash-stat__bar" aria-hidden="true">
          <ProgressBar value={p.n / 100} tone="label" height={6} />
        </div>
      )}
    </div>
  );
}

export function Dashboard({ artifactId, widgets }: { artifactId: string; widgets: DashboardWidget[] }) {
  if (!widgets.length) return <Note icon="info">대시보드에 보여 줄 항목이 아직 없어요.</Note>;
  const stats = widgets.map((w, i) => ({ w, i })).filter((x) => x.w.type === "stat");
  return (
    <div className="dash">
      {stats.length > 0 && (
        <div className={`dash-stats${stats.length === 1 ? " is-single" : ""}`}>
          {stats.map(({ w, i }) => (
            <Stat key={i} w={w as Extract<DashboardWidget, { type: "stat" }>} id={`art-${artifactId}-${i}`} />
          ))}
        </div>
      )}
      {widgets.map((w, i) => {
        if (w.type === "bars") return <Bars key={i} w={w} id={`art-${artifactId}-${i}`} />;
        if (w.type === "list") {
          return (
            <section key={i} className="dash-block" aria-label={w.label}>
              <h3 className="dash-block__title">{w.label}</h3>
              <ul className="dash-list">
                {w.items.map((it, j) => {
                  const [label, amount] = splitAmount(String(it));
                  return (
                    <li key={j}>
                      <span className="dash-list__label">{label}</span>
                      {amount && <span className="dash-list__amount tnum">{amount}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        }
        return null;
      })}
    </div>
  );
}

/** "원" sticks to its number (312,000원); a longer unit gets a space (1,200 토큰) */
const withUnit = (unit: string | undefined) => {
  const u = unit?.trim();
  return (n: number) => `${Math.round(n).toLocaleString("ko-KR")}${u ? (u.length === 1 ? u : ` ${u}`) : ""}`;
};

function Bars({ w, id }: { w: Extract<DashboardWidget, { type: "bars" }>; id: string }) {
  const data = w.points.map((p) => ({ label: String(p.x), value: Number(p.y) || 0 }));
  const unit = "unit" in w && typeof w.unit === "string" ? w.unit : undefined;
  const format = withUnit(unit);
  // the chart's accent marks the last bar at rest: the caption says which bar that is and what it holds
  const last = data[data.length - 1];
  return (
    <section className="dash-block" aria-label={w.label}>
      <div className="dash-block__head">
        <h3 className="dash-block__title">{w.label}</h3>
        {last && <p className="dash-block__caption tnum">{`${last.label} · ${format(last.value)}`}</p>}
      </div>
      {data.length ? <BarChart id={id} data={data} ariaLabel={w.label} height={140} format={format} /> : <Note>데이터가 아직 없어요.</Note>}
    </section>
  );
}
