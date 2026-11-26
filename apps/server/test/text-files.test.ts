/**
 * Text files the model reads to the end: plain text and Markdown (.md, .markdown) are taken; each file's text goes
 * into the model's copy of the message up to TEXT_FILE_MAX_CHARS, all of them up to TEXT_MESSAGE_MAX_CHARS; a file cut
 * there says how much the model has, above the text and where it stops. Rows made before (text/plain of up to 8 KB
 * inline, a short note for the rest) are still found and made again by that rule when one of their files is deleted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { LlmMessage } from "@pickle/agent";
import type { Attachment, AttachmentRef } from "@pickle/protocol";
import { fileText, storedMime, TEXT_FILE_MAX_CHARS, TEXT_MESSAGE_MAX_CHARS } from "../src/archive.ts";
import { makeHarness, readSse, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

type Me = { token: string; session: { user: { id: string }; mainThreadId: string } };
let seq = 0;

async function upload(token: string, name: string, body: BlobPart, type = ""): Promise<Response> {
  const form = new FormData();
  form.set("file", new File([body], name, { type }));
  return h.req("POST", "/api/attachments", { token, raw: form });
}
async function file(token: string, name: string, body: BlobPart): Promise<Attachment> {
  const res = await upload(token, name, body);
  expect(res.status).toBe(201);
  return (await res.json()) as Attachment;
}
/** a multipart body written by hand: the file part with this Content-Type header, or none */
async function rawUpload(token: string, name: string, partType: string | null, body: string): Promise<Response> {
  const b = "tf-boundary";
  const head = `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n${partType === null ? "" : `Content-Type: ${partType}\r\n`}\r\n`;
  return h.req("POST", "/api/attachments", { token, raw: `${head}${body}\r\n--${b}--\r\n`, headers: { "content-type": `multipart/form-data; boundary=${b}` } });
}
const ref = (a: Attachment): AttachmentRef => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, url: a.url });
/** send a message with files; what the model got for it */
async function send(me: Me, text: string, atts: Attachment[]): Promise<string> {
  await readSse(await h.req("POST", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token, body: { text, attachmentIds: atts.map((a) => a.id) } }));
  return h.turns.inputs.at(-1)!.userText!;
}
async function turn(me: Me, text = "다음 거 알려줘"): Promise<LlmMessage[]> {
  await readSse(await h.req("POST", `/api/threads/${me.session.mainThreadId}/messages`, { token: me.token, body: { text } }));
  return h.turns.inputs.at(-1)!.history;
}
const del = (me: Me, id: string) => h.req("DELETE", `/api/attachments/${id}`, { token: me.token });
const llmOf = (id: string) => JSON.parse(h.db.getMessage(id)!.llm_json ?? "null") as LlmMessage[];
const n = (x: number) => x.toLocaleString("ko-KR");

/** `chars` characters of Korean prose in lines of 37 characters (36 and a line break), each line numbered */
function prose(chars: number, tag = "줄"): string {
  let s = "";
  for (let i = 0; s.length < chars; i++) s += `${tag}${String(i).padStart(5, "0")} 가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로`.slice(0, 36) + "\n";
  return s.slice(0, chars);
}
/** the first `cap` characters of a text up to its last line break within 2,000 of the cap (what the server keeps) */
function headOf(text: string, cap: number): string {
  const nl = text.lastIndexOf("\n", cap - 1);
  return nl >= cap - 2000 ? text.slice(0, nl) : text.slice(0, cap);
}
const cutNote = (name: string, text: string, head: string) =>
  `[첨부: ${name} — 전체 ${n(text.length)}자 중 앞 ${n(head.length)}자만 읽었어요. 뒤 ${n(text.length - head.length)}자는 이 대화에 없어요. ` +
  `이 파일을 두고 처음 답할 때 한 번, 앞부분만 읽었다는 것과 읽은 양을 사람에게 알려 주세요]\n${head}\n[첨부: ${name} — 여기서 잘렸어요]`;
/** the notes a row got before 11-26: text/plain of up to 8 KB inline (as Bun.file().text() read it), a short note for the rest */
async function notesBefore(uid: string, atts: Attachment[]): Promise<string> {
  const out: string[] = [];
  for (const a of atts) {
    if (a.mime === "text/plain" && a.size <= 8 * 1024) out.push(`[첨부: ${a.filename}]\n${await Bun.file(join(h.dir, "attachments", uid, a.id)).text()}`);
    else out.push(`[첨부: ${a.filename} (${a.mime}, ${Math.ceil(a.size / 1024)}KB) — 내용은 볼 수 없어요]`);
  }
  return out.join("\n");
}
function oldRow(me: Me, text: string, atts: Attachment[], content: string): string {
  const id = `m_old_${++seq}`;
  h.db.insertMessage({ id, threadId: me.session.mainThreadId, role: "user", text, attachments: atts.map(ref), llm: [{ role: "user", content }], createdAt: h.clock.t + seq });
  return id;
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

describe("which text files are taken", () => {
  test("Markdown (.md, .markdown, .MD) is taken and stored as text/markdown, .txt as text/plain; HTML, CSV and a name without a known extension are 415; Markdown goes out as text/plain; charset=utf-8", async () => {
    const me = (await h.signup("alice")) as Me;
    for (const [name, mime] of [["메모.md", "text/markdown"], ["README.markdown", "text/markdown"], ["NOTES.MD", "text/markdown"], ["목록.txt", "text/plain"], ["로그.log", "text/plain"]] as const) {
      const res = await upload(me.token, name, "# 제목\n본문");
      expect(res.status).toBe(201);
      expect(((await res.json()) as Attachment).mime).toBe(mime);
    }
    // the part's own Content-Type (none, octet-stream, text/x-markdown) does not decide: the name does
    for (const [name, type] of [["a.md", null], ["b.md", "application/octet-stream"], ["c.md", "text/x-markdown"], ["d.markdown", ""]] as const) {
      const res = await rawUpload(me.token, name, type, "# 제목");
      expect(res.status).toBe(201);
      expect(((await res.json()) as Attachment).mime).toBe("text/markdown");
    }
    for (const [name, type] of [["page.html", "text/html"], ["표.csv", "text/csv"], ["notes", "text/plain"], ["README", "text/markdown"]] as const) {
      const res = await upload(me.token, name, "<p>x</p>", type);
      expect(res.status).toBe(415);
      expect(((await res.json()) as { error: string }).error).toBe("unsupported_type");
    }
    const md = await file(me.token, "메모.md", "# 제목\n**굵게**");
    const raw = await h.req("GET", `/api/attachments/${md.id}/raw`, { token: me.token });
    expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await raw.text()).toBe("# 제목\n**굵게**");
  });

  test("storedMime: no type or octet-stream is told by the name (.txt, .md, .markdown); text/x-markdown is stored as text/markdown; any other text is refused", () => {
    expect(storedMime("", "a.md")).toBe("text/markdown");
    expect(storedMime("application/octet-stream", "b.markdown")).toBe("text/markdown");
    expect(storedMime("application/octet-stream", "c.TXT")).toBe("text/plain");
    expect(storedMime("text/x-markdown", "x")).toBe("text/markdown");
    expect(storedMime("text/markdown; charset=utf-8", "x")).toBe("text/markdown");
    expect(storedMime("text/plain;charset=utf-8", "x")).toBe("text/plain");
    expect(storedMime("image/png", "x")).toBe("image/png");
    expect(storedMime("application/pdf", "x")).toBe("application/pdf");
    for (const [type, name] of [["", "a.html"], ["", "notes"], ["application/octet-stream", "notes"], ["application/octet-stream", "a.png"], ["text/html", "a.md"], ["text/csv", "a.csv"], ["image/svg+xml", "a.svg"]])
      expect(storedMime(type!, name!)).toBeNull();
  });
});

describe("the model reads a text file to the end, up to the caps", () => {
  test("a Markdown file and a 12 KB text file (over the old 8 KB) go in whole", async () => {
    const me = (await h.signup("alice")) as Me;
    const md = "# 투자 원칙\n\n1. **분산**한다\n2. 길게 본다\n";
    const long = prose(5_000, "긴"); // ~13 KB of UTF-8
    expect(new TextEncoder().encode(long).length).toBeGreaterThan(12 * 1024);
    const a = await file(me.token, "원칙.md", md);
    const b = await file(me.token, "긴글.txt", long);
    expect(await send(me, "이 지시대로 해줘", [a, b])).toBe(`이 지시대로 해줘\n\n[첨부: 원칙.md]\n${md}\n[첨부: 긴글.txt]\n${long}`);
  });

  test("a file over 30,000 characters: its first part, up to its last line break near the cap, with how much was read above it and where it stops; nothing past the cut", async () => {
    const me = (await h.signup("alice")) as Me;
    expect(TEXT_FILE_MAX_CHARS).toBe(30_000);
    const text = prose(45_000) + "마지막-문장-ZZ";
    const head = headOf(text, 30_000);
    expect(head.length).toBeLessThan(30_000);
    expect(head.length).toBeGreaterThan(28_000);
    const big = await file(me.token, "지시문.md", text);
    const sent = await send(me, "읽어줘", [big]);
    expect(sent).toBe(`읽어줘\n\n${cutNote("지시문.md", text, head)}`);
    expect(sent).not.toContain("마지막-문장-ZZ");
    expect(sent).toContain(`전체 ${n(45_009)}자 중 앞 ${n(head.length)}자만 읽었어요`);
  });

  test("no line break near the cap: cut at 30,000 characters, or 29,999 when the 30,000th is the first half of a surrogate pair", async () => {
    const me = (await h.signup("alice")) as Me;
    const flat = "가".repeat(31_000);
    const pair = "나".repeat(29_999) + "😀" + "다".repeat(1_000);
    const a = await file(me.token, "a.txt", flat);
    const b = await file(me.token, "b.txt", pair);
    expect(await send(me, "하나", [a])).toBe(`하나\n\n${cutNote("a.txt", flat, flat.slice(0, 30_000))}`);
    const sent = await send(me, "둘", [b]);
    expect(sent).toBe(`둘\n\n${cutNote("b.txt", pair, pair.slice(0, 29_999))}`);
    expect(sent).not.toContain("\ud83d\n");
  });

  test("the message cap: the files take 50,000 characters in all, in order; the second is cut to what is left, the third, with nothing left, says it was not read", async () => {
    const me = (await h.signup("alice")) as Me;
    expect(TEXT_MESSAGE_MAX_CHARS).toBe(50_000);
    const one = prose(28_000, "일");
    const two = "이".repeat(30_000);
    const three = prose(5_000, "삼");
    const img = await file(me.token, "사진.png", PNG);
    const atts = [await file(me.token, "1.txt", one), img, await file(me.token, "2.md", two), await file(me.token, "3.txt", three)];
    expect(await send(me, "셋 다", atts)).toBe(
      `셋 다\n\n[첨부: 1.txt]\n${one}\n[첨부: 사진.png (image/png, 1KB) — 내용은 볼 수 없어요]\n${cutNote("2.md", two, two.slice(0, 22_000))}\n` +
        `[첨부: 3.txt (${n(5_000)}자) — 이 메시지에 실을 수 있는 글자 수를 넘어서 읽지 못했어요. 이 파일을 두고 처음 답할 때 한 번, 읽지 못했다는 것을 사람에게 알려 주세요]`,
    );
  });

  test("a UTF-16 file from Notepad over the cap: its first 30,000 characters as Bun.file().text() reads them, its length told from its size", async () => {
    const me = (await h.signup("alice")) as Me;
    const text = "메모장 ".repeat(10_000) + "끝";
    const units = Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)).flatMap((c) => [c & 255, c >> 8]);
    const bytes = new Uint8Array([0xff, 0xfe, ...units]);
    const f = await file(me.token, "유니코드.txt", bytes);
    const whole = fileText(bytes);
    expect(whole).toBe(text);
    expect(await send(me, "봐줘", [f])).toBe(`봐줘\n\n${cutNote("유니코드.txt", whole, whole.slice(0, 30_000))}`);
  });

  test("the next turn's history still holds the file (its request is the last one); the turn after, the 24 KB window has dropped it", async () => {
    const me = (await h.signup("alice")) as Me;
    const text = prose(20_000, "기억");
    await send(me, "이 글 요약해줘", [await file(me.token, "글.txt", text)]);
    const second = JSON.stringify(await turn(me, "더 자세히"));
    expect(second).toContain(JSON.stringify(text).slice(1, -1));
    const third = JSON.stringify(await turn(me, "고마워"));
    expect(third).not.toContain("기억00001");
    expect(third).toContain("더 자세히");
  });
});

describe("a deleted text file: rows made before (text/plain of up to 8 KB inline) and rows made now", () => {
  test("an old row whose small text file is deleted: found by the old rule and made again by it, so the 12 KB file keeps its short note (no text it never had); what came after the notes stays", async () => {
    const me = (await h.signup("alice")) as Me;
    const small = await file(me.token, "메모.txt", "비밀메모-7Q3");
    const big = await file(me.token, "긴글.txt", prose(5_000, "옛"));
    const img = await file(me.token, "사진.png", PNG);
    const before = await notesBefore(me.session.user.id, [small, big, img]);
    const bigNote = `[첨부: 긴글.txt (text/plain, ${Math.ceil(big.size / 1024)}KB) — 내용은 볼 수 없어요]`;
    expect(big.size).toBeGreaterThan(12 * 1024);
    expect(before).toContain(bigNote);
    const id = oldRow(me, "봐줘", [small, big, img], `봐줘\n\n${before}\n\n(둘러보기 안내)`);
    expect((await del(me, small.id)).status).toBe(200);
    expect(llmOf(id)).toEqual([
      { role: "user", content: `봐줘\n\n[첨부: 메모.txt — 보관함에서 지운 파일이라 내용이 없어요]\n${bigNote}\n[첨부: 사진.png (image/png, 1KB) — 내용은 볼 수 없어요]\n\n(둘러보기 안내)` },
    ]);
  });

  test("an old row whose 12 KB text file is deleted: its short note becomes the deleted-file note; the small file's text stays", async () => {
    const me = (await h.signup("alice")) as Me;
    const small = await file(me.token, "메모.txt", "우산\n충전기");
    const big = await file(me.token, "긴글.txt", prose(5_000, "옛"));
    const id = oldRow(me, "봐줘", [small, big], `봐줘\n\n${await notesBefore(me.session.user.id, [small, big])}`);
    expect((await del(me, big.id)).status).toBe(200);
    expect(llmOf(id)).toEqual([{ role: "user", content: "봐줘\n\n[첨부: 메모.txt]\n우산\n충전기\n[첨부: 긴글.txt — 보관함에서 지운 파일이라 내용이 없어요]" }]);
  });

  test("a row made now with a cut file: deleting the other file keeps the cut file's note to the byte; deleting the cut file leaves none of its text", async () => {
    const me = (await h.signup("alice")) as Me;
    const text = prose(40_000, "새") + "비밀-꼬리-ZZ";
    const small = await file(me.token, "메모.txt", "비밀메모-7Q3");
    const big = await file(me.token, "지시문.md", text);
    await send(me, "이대로 해줘", [small, big]);
    const id = h.db.listMessages(me.session.mainThreadId, null, 50).find((r) => r.role === "user" && r.text === "이대로 해줘")!.id;
    const cut = cutNote("지시문.md", text, headOf(text, 30_000));
    expect(llmOf(id)).toEqual([{ role: "user", content: `이대로 해줘\n\n[첨부: 메모.txt]\n비밀메모-7Q3\n${cut}` }]);
    expect((await del(me, small.id)).status).toBe(200);
    expect(llmOf(id)).toEqual([{ role: "user", content: `이대로 해줘\n\n[첨부: 메모.txt — 보관함에서 지운 파일이라 내용이 없어요]\n${cut}` }]);
    expect((await del(me, big.id)).status).toBe(200);
    expect(llmOf(id)).toEqual([{ role: "user", content: "이대로 해줘\n\n[첨부: 메모.txt — 보관함에서 지운 파일이라 내용이 없어요]\n[첨부: 지시문.md — 보관함에서 지운 파일이라 내용이 없어요]" }]);
    expect(JSON.stringify(llmOf(id))).not.toContain("새00001");
  });

  test("a copy not made the usual way: a cut file's text, as the message cap cut it, is still found and replaced", async () => {
    const me = (await h.signup("alice")) as Me;
    const one = "일".repeat(30_000);
    const two = prose(30_000, "둘");
    const a = await file(me.token, "1.txt", one);
    const b = await file(me.token, "2.txt", two);
    const cutTwo = cutNote("2.txt", two, headOf(two, 20_000));
    const id = oldRow(me, "봐줘", [a, b], `(다르게 만든 앞말)\n\n[첨부: 1.txt]\n${one}\n${cutTwo}\n끝`);
    expect((await del(me, b.id)).status).toBe(200);
    expect(llmOf(id)).toEqual([{ role: "user", content: `(다르게 만든 앞말)\n\n[첨부: 1.txt]\n${one}\n[첨부: 2.txt — 보관함에서 지운 파일이라 내용이 없어요]\n끝` }]);
  });
});
