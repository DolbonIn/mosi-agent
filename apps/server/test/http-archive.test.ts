import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Artifact, Attachment, CredentialInfo, CredentialRequestCard, EnclaveInfo, Message, Thread } from "@pickle/protocol";
import { systemTools } from "@pickle/agent";
import { makeHarness, outcome, readSse, sseReader, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function upload(token: string, file: File, threadId?: string) {
  const form = new FormData();
  form.set("file", file);
  if (threadId) form.set("threadId", threadId);
  return h.req("POST", "/api/attachments", { token, raw: form });
}

describe("http hygiene", () => {
  test("security headers on every response (JSON, 404, HTML)", async () => {
    for (const path of ["/api/health", "/api/nope", "/i/whatever-token-123"]) {
      const res = await h.req("GET", path);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("permissions-policy")).toBe("camera=(), geolocation=(self), microphone=(self)");
      const csp = res.headers.get("content-security-policy")!;
      for (const d of ["default-src 'self'", "connect-src 'self'", "img-src 'self' data: blob:", "style-src 'self' 'unsafe-inline'", "script-src 'self'", "media-src 'self' blob:", "worker-src 'self' blob:"])
        expect(csp).toContain(d);
    }
    const nf = await h.req("GET", "/api/nope");
    // the html artifact frame's own script (and nothing else inline) runs: its hash, from the string the app inlines
    const { createHash } = await import("node:crypto");
    const { HTML_FRAME_SCRIPT } = await import("@pickle/protocol");
    const hash = createHash("sha256").update(HTML_FRAME_SCRIPT, "utf8").digest("base64");
    const scriptSrc = nf.headers.get("content-security-policy")!.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBe(`script-src 'self' 'sha256-${hash}'`);
    expect(nf.status).toBe(404);
    expect(((await nf.json()) as { error: string }).error).toBe("not_found");
    expect((await h.req("PUT", "/api/threads")).status).toBe(405);
  });

  test("health shape", async () => {
    const res = await h.req("GET", "/api/health");
    expect(await res.json()).toMatchObject({ ok: true, llm: "configured", model: "fake-model", db: "ok", version: expect.any(String), packages: {}, skills: null });
  });

  test("health exposes k-skill proxy counters, numbers only", async () => {
    h.app.core.deps.skills.httpStats = () => ({ network: 12, cacheHits: 5, cached: 7, tokens: 3, lastUrl: "https://proxy/x?key=secret", nan: Number.NaN });
    const body = (await (await h.req("GET", "/api/health")).json()) as { skills: Record<string, number> };
    expect(body.skills).toEqual({ network: 12, cacheHits: 5, cached: 7, tokens: 3 });
    h.app.core.deps.skills.httpStats = () => {
      throw new Error("boom");
    };
    expect(((await (await h.req("GET", "/api/health")).json()) as { skills: unknown }).skills).toBeNull();
  });

  test("CORS only for the dev origins and only in dev", async () => {
    const plain = await h.req("GET", "/api/health", { headers: { origin: "http://localhost:5173" } });
    expect(plain.headers.get("access-control-allow-origin")).toBeNull();
    await h.close();
    h = await makeHarness({ config: { dev: true } });
    const ok = await h.req("OPTIONS", "/api/threads", { headers: { origin: "http://127.0.0.1:5173", "access-control-request-method": "POST" } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect(ok.headers.get("access-control-allow-headers")).toContain("Authorization");
    const evil = await h.req("GET", "/api/health", { headers: { origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("JSON body limit 64 KB and invalid JSON", async () => {
    const { token } = await h.signup("haneul");
    const big = await h.req("PATCH", "/api/settings", { token, raw: JSON.stringify({ x: "a".repeat(70_000) }), headers: { "content-type": "application/json" } });
    expect(big.status).toBe(413);
    const broken = await h.req("PATCH", "/api/settings", { token, raw: "{nope", headers: { "content-type": "application/json" } });
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { error: string }).error).toBe("invalid_json");
  });

  test("serves the built PWA with SPA fallback and long-cached assets", async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "pickle-dist-"));
    const dist = join(root, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>모시</title>");
    writeFileSync(join(dist, "assets", "app-abc123.js"), "console.log(1)");
    writeFileSync(join(root, "secret.txt"), "nope");
    await h.close();
    h = await makeHarness({ config: { staticDir: dist } });
    const idx = await h.req("GET", "/");
    expect(idx.status).toBe(200);
    expect(await idx.text()).toContain("<title>모시</title>");
    expect(idx.headers.get("content-security-policy")).toContain("script-src 'self'");
    const asset = await h.req("GET", "/assets/app-abc123.js");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const route = await h.req("GET", "/explore/benefit");
    expect(await route.text()).toContain("<title>모시</title>");
    expect((await h.req("GET", "/missing.png")).status).toBe(404);
    expect((await h.req("GET", "/%2e%2e/secret.txt")).status).toBe(404);
    expect((await h.req("GET", "/api/unknown")).headers.get("content-type")).toContain("application/json");
  });

  test("/api/events: hello over ?token=, 401 without", async () => {
    const { token } = await h.signup("haneul");
    expect((await h.req("GET", "/api/events")).status).toBe(401);
    const res = await h.req("GET", `/api/events?token=${token}`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const r = sseReader(res);
    expect(await r.next((e) => e.type === "hello")).toMatchObject({ type: "hello", at: h.clock.t });
    await r.cancel();
  });
});

describe("threads", () => {
  test("CRUD, pagination and isolation between users", async () => {
    const a = await h.signup("alice");
    const b = await h.signup("bobby");
    const t = (await (await h.req("POST", "/api/threads", { token: a.token, body: { kind: "task", title: "이사 준비" } })).json()) as Thread;
    expect(t).toMatchObject({ kind: "task", title: "이사 준비", archived: false, unread: false });
    expect((await h.req("POST", "/api/threads", { token: a.token, body: { kind: "main" } })).status).toBe(400);
    const listA = (await (await h.req("GET", "/api/threads", { token: a.token })).json()) as Thread[];
    expect(listA.map((x) => x.kind).sort()).toEqual(["main", "task"]);
    const listB = (await (await h.req("GET", "/api/threads", { token: b.token })).json()) as Thread[];
    expect(listB.map((x) => x.id)).not.toContain(t.id);
    expect((await h.req("GET", `/api/threads/${t.id}/messages`, { token: b.token })).status).toBe(404);
    expect((await h.req("PATCH", `/api/threads/${t.id}`, { token: b.token, body: { archived: true } })).status).toBe(404);
    const patched = (await (await h.req("PATCH", `/api/threads/${t.id}`, { token: a.token, body: { archived: true, title: "이사 체크리스트" } })).json()) as Thread;
    expect(patched).toMatchObject({ archived: true, title: "이사 체크리스트" });

    for (let i = 0; i < 5; i++) {
      h.clock.t += 1000;
      h.turns.set(async () => outcome(`답 ${i}`));
      await readSse(await h.req("POST", `/api/threads/${t.id}/messages`, { token: a.token, body: { text: `질문 ${i}` } }));
    }
    const last4 = (await (await h.req("GET", `/api/threads/${t.id}/messages?limit=4`, { token: a.token })).json()) as Message[];
    expect(last4.map((m) => m.text)).toEqual(["질문 3", "답 3", "질문 4", "답 4"]);
    const older = (await (await h.req("GET", `/api/threads/${t.id}/messages?limit=4&before=${last4[0]!.createdAt}`, { token: a.token })).json()) as Message[];
    expect(older.map((m) => m.text)).toEqual(["질문 1", "답 1", "질문 2", "답 2"]);
  });
});

describe("archive", () => {
  test("artifacts created by tools are listed, served raw and deletable", async () => {
    const { token, session } = await h.signup("haneul");
    h.turns.set(async (input) => {
      const { id } = await input.ctx.store.createArtifact({ title: "제주 2박 3일", kind: "document", content: "# 1일차\n- 성산일출봉" });
      return outcome("문서를 만들었어요", { cards: [{ type: "artifact", artifactId: id, title: "제주 2박 3일", kind: "document", preview: "1일차" }] });
    });
    await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "제주 일정 문서로" } }));
    const list = (await (await h.req("GET", "/api/artifacts", { token })).json()) as Artifact[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "제주 2박 3일", kind: "document", threadId: session.mainThreadId });
    const raw = await h.req("GET", `/api/blobs/${list[0]!.id}?token=${token}`);
    expect(raw.headers.get("content-type")).toContain("text/markdown");
    expect(await raw.text()).toContain("성산일출봉");
    const other = await h.signup("other");
    expect((await h.req("GET", `/api/artifacts/${list[0]!.id}`, { token: other.token })).status).toBe(404);
    expect((await h.req("DELETE", `/api/artifacts/${list[0]!.id}`, { token })).status).toBe(200);
    expect((await h.req("GET", `/api/artifacts/${list[0]!.id}`, { token })).status).toBe(404);
  });

  test("an agent-rendered html card (deep search '전부') may be 300 KB after cleaning; the model's 150 KB stays", async () => {
    const { token, session } = await h.signup("haneul");
    const row = '<li><a href="https://clinic.example.jp/p">도쿄 롯폰기 클리닉</a> · 도쿄 · 39,800엔 · 전화 · 확인</li>';
    const rows = (kb: number) => `<style>.l{font-size:14px}</style><ul class="l">${row.repeat(Math.ceil((kb * 1024) / Buffer.byteLength(row)))}</ul>`;
    const seen: { made?: string; card?: string; errors: string[] } = { errors: [] };
    h.turns.set(async (input) => {
      const store = input.ctx.store;
      const attempt = async (content: string, opts?: { agentCard?: boolean }, kind: "html" | "document" = "html") => {
        try {
          return (await store.createArtifact({ title: "일본 마운자로 전부", kind, content }, opts)).id;
        } catch (err) {
          seen.errors.push((err as Error).message);
          return null;
        }
      };
      await attempt(rows(200)); // the model's path: over 150 KB
      seen.made = (await attempt(rows(200), { agentCard: true })) ?? undefined;
      await attempt(rows(310), { agentCard: true }); // over 300 KB cleaned
      await attempt(rows(520), { agentCard: true }); // over the 512 KB hand-over bound
      await attempt("x".repeat(270 * 1024), { agentCard: true }, "document"); // other kinds keep 256 KB
      // explore.ts' path: sys_create_artifact's saveAgentCard over the real store (cleaned, 300 KB)
      const card = await systemTools().find((t) => t.name === "sys_create_artifact")!.saveAgentCard!({ title: "도쿄 전부", html: rows(250) }, input.ctx);
      seen.card = card.ok ? (card.data as { artifactId: string }).artifactId : `refused ${JSON.stringify(card.data)}`;
      return outcome("만들었어요");
    });
    await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "일본 마운자로 전부 카드로" } }));
    expect(seen.errors).toEqual(["화면이 너무 커요 (150KB 이하)", "화면이 너무 커요 (300KB 이하)", "화면이 너무 커요 (300KB 이하)", "문서가 너무 커요 (256KB 이하)"]);
    const one = (await (await h.req("GET", `/api/artifacts/${seen.made}`, { token })).json()) as Artifact;
    expect(one.kind).toBe("html");
    expect(Buffer.byteLength(one.content)).toBeGreaterThan(200 * 1024);
    expect(Buffer.byteLength(one.content)).toBeLessThanOrEqual(300 * 1024);
    expect(one.content.startsWith('<style>.l{font-size:14px}</style><ul class="l"><li><a href="https://clinic.example.jp/p">')).toBe(true);
    const card = (await (await h.req("GET", `/api/artifacts/${seen.card}`, { token })).json()) as Artifact;
    expect(Buffer.byteLength(card.content)).toBeGreaterThan(250 * 1024);
  });

  test("html artifacts: the store cleans and tunes them, the API returns the stored copy, the blob is a sandboxed download", async () => {
    const { token, session } = await h.signup("haneul");
    const seen: { mode?: string; made?: Awaited<ReturnType<import("@pickle/agent").ToolStore["createArtifact"]>>; errors: string[] } = { errors: [] };
    h.turns.set(async (input) => {
      seen.mode = input.ctx.mode;
      const dirty =
        '<!doctype html><html><head><title>t</title><script>steal()</script><link rel="stylesheet" href="https://x/a.css"></head>' +
        '<body><style>.c{background:url(https://x/p.png)}.m{font-size:11px;color:var(--text-3)}</style><div class="c" onclick="x()"><h1>갤러리</h1><img src="https://x/t.png"><a href="javascript:alert(1)">링크</a></div></body></html>';
      seen.made = await input.ctx.store.createArtifact({ title: "갤러리 스레드", kind: "html", content: dirty });
      for (const content of [`<p>${"가".repeat(52_000)}</p>`, "<script>only()</script>"]) {
        try {
          await input.ctx.store.createArtifact({ title: "x", kind: "html", content });
        } catch (err) {
          seen.errors.push((err as Error).message);
        }
      }
      return outcome("만들었어요");
    });
    await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "디시 스타일 스레드 만들어줘" } }));
    const clean = '<style>.c{background:none}.m{font-size:13px;color:var(--text-2)}</style><div class="c"><h1>갤러리</h1><img><a>링크</a></div>';
    expect(seen.mode).toBe("text");
    expect(seen.made).toEqual({
      id: seen.made!.id,
      html: { content: clean, removed: { elements: 2, handlers: 1, remote: 2, links: 1 }, tuned: { fontSize: 1, textColor: 1 } },
    });
    expect(seen.errors).toEqual(["화면이 너무 커요 (150KB 이하)", "화면에 남은 내용이 없어요 (스크립트·외부 자원만 있었어요)"]);

    const list = (await (await h.req("GET", "/api/artifacts", { token })).json()) as Artifact[];
    expect(list.map((a) => [a.kind, a.title, a.content])).toEqual([["html", "갤러리 스레드", clean]]);
    const one = (await (await h.req("GET", `/api/artifacts/${list[0]!.id}`, { token })).json()) as Artifact;
    expect(one.content).toBe(clean);
    const raw = await h.req("GET", `/api/blobs/${list[0]!.id}?token=${token}`);
    expect(raw.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(raw.headers.get("content-disposition")).toStartWith("attachment;");
    expect(raw.headers.get("content-security-policy")).toStartWith("sandbox; default-src 'none';");
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
    expect(raw.headers.get("x-frame-options")).toBe("DENY");
    expect(await raw.text()).toBe(clean);
    const other = await h.signup("other");
    expect((await h.req("GET", `/api/artifacts/${list[0]!.id}`, { token: other.token })).status).toBe(404);
    expect((await h.req("GET", `/api/blobs/${list[0]!.id}?token=${other.token}`)).status).toBe(404);

    // a voice turn tells the tools it is spoken
    await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "일정 말해줘", mode: "voice" } }));
    expect(seen.mode).toBe("voice");
  });

  test("attachments: upload, list, raw, attach to a message, limits, delete", async () => {
    const { token, session } = await h.signup("haneul");
    const res = await upload(token, new File([PNG], "../../etc/사진 1.png", { type: "image/png" }), session.mainThreadId);
    expect(res.status).toBe(201);
    const a = (await res.json()) as Attachment;
    expect(a).toMatchObject({ filename: "사진 1.png", mime: "image/png", size: PNG.length, threadId: session.mainThreadId, url: `/api/attachments/${a.id}/raw` });

    const raw = await h.req("GET", a.url, { token });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect(raw.headers.get("content-disposition")).toStartWith("inline;");
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(PNG);
    expect((await h.req("GET", `${a.url}?token=${token}`)).status).toBe(200);
    const other = await h.signup("other");
    expect((await h.req("GET", a.url, { token: other.token })).status).toBe(404);

    const txt = (await (await upload(token, new File(["메모 내용"], "memo.txt", { type: "text/plain" }))).json()) as Attachment;
    h.turns.set(async (input) => {
      expect(input.userText).toContain("[첨부: memo.txt]");
      expect(input.userText).toContain("메모 내용");
      return outcome("봤어요");
    });
    const events = await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "이거 봐줘", attachmentIds: [txt.id] } }));
    expect((events[0] as { userMessage: Message }).userMessage.attachments.map((x) => x.id)).toEqual([txt.id]);

    expect((await upload(token, new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }))).status).toBe(415);
    expect((await upload(token, new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }))).status).toBe(413);
    expect(((await (await h.req("GET", "/api/attachments", { token })).json()) as Attachment[]).length).toBe(2);
    expect((await h.req("DELETE", `/api/attachments/${a.id}`, { token })).status).toBe(200);
    expect((await h.req("GET", a.url, { token })).status).toBe(404);
  });
});

describe("credential enclave", () => {
  const envelope = (aad: string) => ({ v: 1, alg: "ECDH-P256+HKDF-SHA256+A256GCM", kid: "kid-test", epk: { kty: "EC", crv: "P-256", x: "a", y: "b" }, iv: "aXY", ct: "Y3Q", aad });

  test("saving a login flips pending credential_request cards to saved and pushes thread_updated", async () => {
    const { token, session } = await h.signup("haneul");
    const uid = session.user.id;
    const card: CredentialRequestCard = {
      type: "credential_request",
      service: "kakaotalk",
      serviceName: "카카오톡",
      reason: "안 읽은 대화를 읽으려면 로그인이 필요해요",
      fields: [{ key: "username", label: "이메일", type: "email" }],
      status: "pending",
    };
    h.turns.set(async () =>
      outcome("카카오톡 로그인을 저장해 주세요", { cards: [card], pendingCredential: { service: "kakaotalk", serviceName: "카카오톡", reason: card.reason, fields: card.fields } }),
    );
    const done = (await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "카톡 요약해줘" } }))).at(-1) as {
      message: Message;
    };
    expect((done.message.cards[0] as CredentialRequestCard).status).toBe("pending");

    const info = (await (await h.req("GET", "/api/enclave", { token })).json()) as EnclaveInfo;
    expect(info.kid).toBe("kid-test");

    const ev = sseReader(await h.req("GET", `/api/events?token=${token}`));
    await ev.next((e) => e.type === "hello");
    const base = { service: "kakaotalk", label: "카카오톡 (ha***@gmail.com)", kind: "login", hint: "ha***@gmail.com", keepFor: "7d" };
    const wrongAad = await h.req("POST", "/api/credentials", { token, body: { ...base, envelope: envelope(`someone:kakaotalk:login`) } });
    expect(wrongAad.status).toBe(400);
    const saved = await h.req("POST", "/api/credentials", { token, body: { ...base, envelope: envelope(`${uid}:kakaotalk:login`) } });
    expect(saved.status).toBe(201);
    const cred = (await saved.json()) as CredentialInfo;
    expect(cred).toMatchObject({ service: "kakaotalk", kind: "login", hint: "ha***@gmail.com" });
    expect(JSON.stringify(cred)).not.toContain("sealed");

    const msg = await ev.next((e) => e.type === "message" && e.message.id === done.message.id);
    expect((msg as { message: Message }).message.cards[0]).toMatchObject({ type: "credential_request", status: "saved" });
    expect(await ev.next((e) => e.type === "thread_updated" && e.thread.id === session.mainThreadId)).toBeTruthy();
    await ev.cancel();

    const stored = (await (await h.req("GET", `/api/threads/${session.mainThreadId}/messages`, { token })).json()) as Message[];
    expect((stored.at(-1)!.cards[0] as CredentialRequestCard).status).toBe("saved");

    // list / renew / delete; profile counts
    expect(((await (await h.req("GET", "/api/credentials", { token })).json()) as CredentialInfo[]).length).toBe(1);
    const renewed = await h.req("PATCH", `/api/credentials/${cred.id}`, { token, body: { keepFor: "forever" } });
    expect(((await renewed.json()) as CredentialInfo).keepFor).toBe("forever");
    expect(((await (await h.req("GET", "/api/profile", { token })).json()) as { savedLogins: number }).savedLogins).toBe(1);
    expect((await h.req("DELETE", `/api/credentials/${cred.id}`, { token })).status).toBe(200);
    expect((await h.req("DELETE", `/api/credentials/${cred.id}`, { token })).status).toBe(404);
  });

  test("connections: list, connect pushes a connection event, chats, disconnect", async () => {
    const { token } = await h.signup("haneul");
    const ev = sseReader(await h.req("GET", `/api/events?token=${token}`));
    await ev.next((e) => e.type === "hello");
    const list = (await (await h.req("GET", "/api/connections", { token })).json()) as { providers: { id: string }[]; connections: unknown[] };
    expect(list.providers.map((p) => p.id)).toEqual(["kakaotalk", "slack"]);
    expect(list.connections).toEqual([]);
    const c = await h.req("POST", "/api/connections/slack", { token, body: {} });
    expect(c.status).toBe(200);
    expect(await ev.next((e) => e.type === "connection")).toMatchObject({ connection: { provider: "slack", status: "connected" } });
    expect(((await (await h.req("GET", "/api/connections/slack/chats", { token })).json()) as unknown[]).length).toBe(1);
    expect((await h.req("POST", "/api/connections/myspace", { token, body: {} })).status).toBe(404);
    expect((await h.req("DELETE", "/api/connections/slack", { token })).status).toBe(200);
    await ev.cancel();
  });
});
