/** Serves the built PWA (apps/mobile/dist) with SPA fallback; long-lived cache for hashed assets. */
import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";

export function createStatic(dir: string | null): ((path: string, method: string) => Promise<Response | null>) | null {
  if (!dir) return null;
  const root = resolve(dir);
  if (!existsSync(join(root, "index.html"))) return null;

  return async (path, method) => {
    if (method !== "GET" && method !== "HEAD") return null;
    let rel: string;
    try {
      rel = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (rel.includes("\0")) return null;
    const target = normalize(join(root, rel));
    if (target !== root && !target.startsWith(root + sep)) return null;
    if (rel !== "/" && existsSync(target) && statSync(target).isFile()) {
      const immutable = rel.startsWith("/assets/");
      return new Response(Bun.file(target), {
        headers: { "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate" },
      });
    }
    // SPA fallback only for route-like paths (no file extension)
    if (/\.[a-z0-9]{1,8}$/i.test(rel)) return null;
    return new Response(Bun.file(join(root, "index.html")), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
    });
  };
}
