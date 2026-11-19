import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "@pickle/agent";
import { setFetch } from "../src/http";

export const FIXTURES = join(import.meta.dir, "fixtures");

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}
export function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(fixture(name)) as T;
}

/** 2026-11-11 18:45 KST — matches the recorded fixtures. */
export const NOW = new Date("2026-11-11T09:45:00Z");

export const SECRET_IDS = { userId: "user-7f3a-SECRET", threadId: "thread-9c1d-SECRET", displayName: "김비밀", agentName: "깽이비밀" };

export function fakeCtx(over: Partial<ToolContext> = {}): ToolContext & { statuses: string[] } {
  const statuses: string[] = [];
  const ctx = {
    ...SECRET_IDS,
    workspaceDir: "/tmp/should-not-leak",
    signal: new AbortController().signal,
    credentials: {
      find: async () => null,
      use: async () => {
        throw new Error("skills must not touch credentials");
      },
    },
    store: {} as ToolContext["store"],
    status: (t: string) => statuses.push(t),
    now: () => NOW,
    statuses,
    ...over,
  };
  return ctx as ToolContext & { statuses: string[] };
}

export interface Recorded {
  url: string;
  path: string;
  params: Record<string, string>;
  headers: Record<string, string>;
}

type Reply = { status?: number; body: string | object; contentType?: string } | ((req: Recorded) => Response | Promise<Response>);

/**
 * Route-based fetch mock: keys are proxy paths ("/v1/korea-weather/now"); values are canned replies.
 * Unknown paths → 404 JSON. Every request is recorded.
 */
export function mockProxy(routes: Record<string, Reply | Reply[]>): { requests: Recorded[]; restore(): void } {
  const requests: Recorded[] = [];
  const counters = new Map<string, number>();
  setFetch(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const rec: Recorded = { url, path: u.pathname, params: Object.fromEntries(u.searchParams), headers };
    requests.push(rec);
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const entry = routes[u.pathname];
    if (!entry) return new Response(JSON.stringify({ error: "not_found", message: "no route" }), { status: 404, headers: { "content-type": "application/json" } });
    let reply: Reply;
    if (Array.isArray(entry)) {
      const i = counters.get(u.pathname) ?? 0;
      counters.set(u.pathname, i + 1);
      reply = entry[Math.min(i, entry.length - 1)]!;
    } else reply = entry;
    if (typeof reply === "function") return reply(rec);
    const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    const ct = reply.contentType ?? (typeof reply.body === "string" && body.trimStart().startsWith("<") ? "application/xml" : "application/json; charset=utf-8");
    return new Response(body, { status: reply.status ?? 200, headers: { "content-type": ct } });
  });
  return { requests, restore: () => setFetch(null) };
}

export function json(name: string, status = 200): Reply {
  return { status, body: fixture(name), contentType: "application/json; charset=utf-8" };
}
export function xml(name: string, status = 200): Reply {
  return { status, body: fixture(name), contentType: "application/xml" };
}
