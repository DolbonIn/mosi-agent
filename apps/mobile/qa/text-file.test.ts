// The composer takes .md and .txt files, and text longer than a message holds goes as a .txt (snap-long-text, the
// person's request; DD 1736/1738): the picker names the extensions (iOS lists .md only by them), every upload says its
// type (browsers leave .md without one), the file takes a short first line as its name (else "긴 글"), and past 4,000
// characters the composer says the field goes as a file instead of refusing to send (textFile.ts, Composer.tsx). The
// paste and send paths run in the stub captures (LT scene).
//   bun test ./qa/text-file.test.ts
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_MESSAGE_CHARS, type ID } from "@pickle/protocol";
import { Composer } from "../src/screens/chat/Composer";
import { setComposerText } from "../src/screens/chat/composerStore";
import { checkFile } from "../src/lib/uploadTypes";
import { ACCEPT, asUpload, textFile, textFileName, tooLongForMessage } from "../src/screens/chat/textFile";
import { MAX_CHARS } from "../src/screens/chat/util";

describe("what the composer takes", () => {
  test("the picker lists .md, .markdown, .txt and .pdf by extension as well as by type", () => {
    const parts = ACCEPT.split(",");
    for (const p of [".md", ".markdown", ".txt", ".pdf", "text/markdown", "text/plain", "application/pdf", "image/png", "image/jpeg", "image/heic"]) expect(parts).toContain(p);
  });

  // the type a picked file goes up with (Bun adds ";charset=utf-8" to a text File's type: the part before it)
  const typeOf = (name: string, type: string) => asUpload(new File(["x"], name, { type }))?.type.split(";")[0] ?? null;

  test("markdown goes by its extension whatever type the browser gave; .pdf/.txt by theirs when it gave none or octet-stream (보관함's rule)", () => {
    expect(typeOf("회의록.md", "")).toBe("text/markdown");
    expect(typeOf("README.MARKDOWN", "")).toBe("text/markdown");
    expect(typeOf("notes.md", "text/x-markdown")).toBe("text/markdown");
    expect(typeOf("notes.md", "application/octet-stream")).toBe("text/markdown");
    expect(typeOf("메모.txt", "")).toBe("text/plain");
    expect(typeOf("메모.TXT", "")).toBe("text/plain");
    expect(typeOf("메모.txt", "application/octet-stream")).toBe("text/plain");
    expect(typeOf("계약서.PDF", "")).toBe("application/pdf");
    expect(typeOf("계약서.pdf", "application/octet-stream")).toBe("application/pdf");
    expect(typeOf("메모.txt", "text/plain")).toBe("text/plain");
  });

  test("other files go by their type; what the composer does not take is null", () => {
    expect(typeOf("a.png", "image/png")).toBe("image/png");
    expect(typeOf("a.heic", "image/heic")).toBe("image/heic");
    expect(typeOf("a.bmp", "image/bmp")).toBe("image/bmp");
    expect(typeOf("계약서.pdf", "application/pdf")).toBe("application/pdf");
    expect(typeOf("notes", "text/markdown")).toBe("text/markdown");
    expect(typeOf("a.svg", "image/svg+xml")).toBeNull();
    expect(typeOf("a.tiff", "image/tiff")).toBeNull();
    expect(typeOf("a.docx", "")).toBeNull();
    expect(typeOf("a.docx", "application/octet-stream")).toBeNull();
    expect(typeOf("a.html", "text/html")).toBeNull();
    expect(typeOf("archive.md.zip", "application/zip")).toBeNull();
  });

  test("a document 보관함에 올리기 takes the composer takes, and one it refuses the composer refuses (DD 1736 §5)", () => {
    const docs: Array<[string, string]> = [
      ["회의록.md", ""], ["회의록.md", "application/octet-stream"], ["회의록.md", "text/x-markdown"], ["회의록.markdown", ""],
      ["메모.txt", ""], ["메모.txt", "application/octet-stream"], ["메모.txt", "text/plain"],
      ["계약서.pdf", ""], ["계약서.pdf", "application/octet-stream"], ["계약서.pdf", "application/pdf"],
      ["a.png", "image/png"], ["a.bmp", "image/bmp"], ["a.tiff", "image/tiff"], ["a.svg", "image/svg+xml"], ["a.html", "text/html"], ["a.csv", "text/csv"],
      ["a.docx", ""], ["a.zip", "application/zip"], ["a", "application/octet-stream"],
    ];
    for (const [name, type] of docs) expect([name, type, asUpload(new File(["x"], name, { type })) !== null]).toEqual([name, type, checkFile(new File(["x"], name, { type })) === null]);
  });

  test("asUpload keeps a file that already says its type and re-types one that does not (same name and bytes)", async () => {
    const png = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    expect(asUpload(png)).toBe(png);
    const md = new File(["# 제목\n본문"], "회의록.md", { type: "" });
    const up = asUpload(md)!;
    expect(up).not.toBe(md);
    expect(up.type).toBe("text/markdown");
    expect(up.name).toBe("회의록.md");
    expect(await up.text()).toBe("# 제목\n본문");
    expect(asUpload(new File(["x"], "a.exe", { type: "application/x-msdownload" }))).toBeNull();
  });
});

describe("text longer than a message goes as a .txt", () => {
  test("the line is the server's: more than 4,000 characters", () => {
    expect(MAX_CHARS).toBe(MAX_MESSAGE_CHARS);
    expect(tooLongForMessage("가".repeat(4000))).toBe(false);
    expect(tooLongForMessage("가".repeat(4001))).toBe(true);
  });

  test("the file is text/plain and holds the text as it was", async () => {
    const body = "첫 줄\r\n\n둘째 줄 😀\n" + "가".repeat(5000);
    const f = textFile(body, "첫 줄.txt");
    expect(f.type.split(";")[0]).toBe("text/plain"); // Bun adds ";charset=utf-8" to string parts, browsers do not
    expect(f.name).toBe("첫 줄.txt");
    expect(await f.text()).toBe(body);
    expect(f.size).toBe(new TextEncoder().encode(body).length);
  });

  test("its name is a short first line (DD 1736 §2 examples)", () => {
    expect(textFileName("# 모시 작업 지시문\n본문")).toBe("모시 작업 지시문.txt");
    expect(textFileName("아래 내용 정리해 줘\n\n" + "가".repeat(5000))).toBe("아래 내용 정리해 줘.txt");
    expect(textFileName("오늘 회의에서 나온 이야기를 빠짐없이 정리해서 다음 주 월요일까지 공유해 주세요\n")).toBe("긴 글.txt");
    expect(textFileName("---\n제목")).toBe("긴 글.txt");
    expect(textFileName("{\n  \"a\": 1\n}")).toBe("긴 글.txt");
  });

  test("the first non-blank line, tidied: heads in front, * _ ` inside, spaces collapsed", () => {
    expect(textFileName("\n\n  회의록   정리  \n본문")).toBe("회의록 정리.txt");
    expect(textFileName("> - 인용한 목록\n")).toBe("인용한 목록.txt");
    expect(textFileName("1. 첫째 할 일\n2. 둘째")).toBe("첫째 할 일.txt");
    expect(textFileName("* 별표 목록")).toBe("별표 목록.txt");
    expect(textFileName("**굵게** 시작")).toBe("굵게 시작.txt");
    expect(textFileName("`code` 설명과 snake_case")).toBe("code 설명과 snakecase.txt");
    expect(textFileName("-5도까지 내려가요")).toBe("-5도까지 내려가요.txt");
    expect(textFileName("#해시태그")).toBe("#해시태그.txt");
  });

  test("the characters a file name cannot hold are left out (control characters too)", () => {
    expect(textFileName('a/b\\c:d*e?f"g<h>i|j\tk')).toBe("abcdefghij k.txt");
    expect(textFileName("메모\u0007장")).toBe("메모장.txt");
  });

  test("1–24 code points and a letter or digit, never cut", () => {
    expect(textFileName("가".repeat(24))).toBe(`${"가".repeat(24)}.txt`);
    expect(textFileName("가".repeat(25))).toBe("긴 글.txt");
    const family = "👨‍👩‍👧‍👦"; // seven code points
    expect(textFileName("가".repeat(17) + family)).toBe(`${"가".repeat(17)}${family}.txt`);
    expect(textFileName("가".repeat(18) + family)).toBe("긴 글.txt");
    expect(textFileName("2026")).toBe("2026.txt");
    expect(textFileName("!!! ???")).toBe("긴 글.txt");
    expect(textFileName("😀😀")).toBe("긴 글.txt");
  });

  test("DD 2058: dates keep their numbers, task boxes go, code / markup / links name nothing, format characters go", () => {
    expect(textFileName("2026. 11. 26. 주간 회의\n본문")).toBe("2026. 11. 26. 주간 회의.txt");
    expect(textFileName("11. 26. 회의\n")).toBe("11. 26. 회의.txt");
    expect(textFileName("```python\nprint(1)\n```")).toBe("긴 글.txt");
    expect(textFileName("~~~\ncode")).toBe("긴 글.txt");
    expect(textFileName("https://example.com/news/123\n기사")).toBe("긴 글.txt");
    expect(textFileName("기사 https://a.kr")).toBe("긴 글.txt");
    expect(textFileName("<!DOCTYPE html>\n<html>")).toBe("긴 글.txt");
    expect(textFileName("- [ ] 장보기\n- [x] 빨래")).toBe("장보기.txt");
    expect(textFileName("- [x] 빨래")).toBe("빨래.txt");
    expect(textFileName("1. [ ] 첫째")).toBe("첫째.txt");
    expect(textFileName("a\u200bb")).toBe("ab.txt");
    expect(textFileName("\u202e메모\u202c\u00ad장\ufeff")).toBe("메모장.txt");
  });

  test("list numbers: once, 1–3 digits; the dash before a number is still a list mark", () => {
    expect(textFileName("1. 2. 둘째")).toBe("1. 2. 둘째.txt"); // a number after it: read as a date, kept whole
    expect(textFileName("12) 열두째")).toBe("열두째.txt");
    expect(textFileName("2026. 회고")).toBe("2026. 회고.txt");
    expect(textFileName("- 3개 사기")).toBe("3개 사기.txt");
    expect(textFileName("> 1. 인용한 번호")).toBe("인용한 번호.txt");
  });

  test("the joiners that hold an emoji together stay", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(textFileName(`가족 ${family}`)).toBe(`가족 ${family}.txt`);
    const england = "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
    expect(textFileName(`여행 ${england}`)).toBe(`여행 ${england}.txt`);
  });

  test("nothing left → 긴 글; a name already in the row gets a number", () => {
    expect(textFileName("   \n\t\n")).toBe("긴 글.txt");
    expect(textFileName("###\n본문은 둘째 줄")).toBe("긴 글.txt");
    expect(textFileName("메모", ["메모.txt"])).toBe("메모 2.txt");
    expect(textFileName("메모", ["메모.txt", "메모 2.txt"])).toBe("메모 3.txt");
    expect(textFileName("", ["긴 글.txt"])).toBe("긴 글 2.txt");
  });
});

describe("the composer past 4,000 characters", () => {
  const render = (threadId: string, text: string) => {
    setComposerText(threadId as ID, text);
    return renderToStaticMarkup(createElement(Composer, { threadId: threadId as ID, placeholder: "메시지", streaming: false, onSubmit: async () => false, onStop: () => {} }));
  };

  test("the file input takes ACCEPT", () => {
    expect(render("t_lt0", "")).toContain(`accept="${ACCEPT}"`);
  });

  test("near the line (3,501–4,000): the counter", () => {
    expect(render("t_lt0b", "가".repeat(3500))).not.toContain("composer-foot");
    const m = render("t_lt1", "가".repeat(3501));
    expect(m).toContain("3,501/4,000");
    expect(m).not.toContain("composer-note");
    const at = render("t_lt2", "가".repeat(4000));
    expect(at).toContain("4,000/4,000");
    expect(at).not.toContain("composer-note");
  });

  test("past it: the status line alone (no counter: DD 2058 §3), no error state, send stays on", () => {
    const m = render("t_lt3", "가".repeat(4001));
    const note = /<span class="composer-note t-copy" role="status">(.*?)<\/span><\/div>/.exec(m)?.[1] ?? "";
    expect(note.replace(/<[^>]+>/g, "").replace(/\u00a0/g, " ")).toBe("4,000자가 넘어서 파일로 보내요");
    expect(m).not.toContain("composer-count");
    expect(m).not.toContain("data-over");
    expect(m).not.toContain("aria-invalid");
    expect(m).not.toContain("composer-err");
    const send = /<button[^>]*data-mode="send"[^>]*>/.exec(m)?.[0] ?? "";
    expect(send).not.toBe("");
    expect(send).not.toContain("aria-disabled");
  });
});
