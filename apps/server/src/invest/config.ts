/**
 * The invest switches from the environment (agent-runtime 2052 §B-1, team-lead 2045 §12-4·5). All three are off unless
 * the operator sets them: QA servers and tests never reach a real quote source or Toss.
 */
import type { ServerConfig } from "../deps.ts";

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]{2,39}$/;

export function investConfigFromEnv(env: Record<string, string | undefined>): ServerConfig["invest"] {
  const base = env.PICKLE_TOSS_BASE?.trim() ?? "";
  let tossBase: string | null = null;
  try {
    const u = base ? new URL(base) : null;
    if (u && u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash) tossBase = u.origin;
  } catch {
    tossBase = null;
  }
  const ip = env.PICKLE_OUTBOUND_IP?.trim() ?? "";
  return {
    sources: env.PICKLE_INVEST_SOURCES?.trim() === "on",
    tossBase,
    outboundIp: IPV4.test(ip) || (ip.includes(":") && IPV6.test(ip)) ? ip : null,
  };
}
