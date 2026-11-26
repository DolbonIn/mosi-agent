// What goes up, for 보관함에 올리기 and the composer alike (DD 1736 §5), by the server's rules (archive.ts allowedMime and
// storedMime): photos (raster), PDF, text/plain, text/markdown and text/x-markdown by type; no type or
// application/octet-stream → by extension (.txt, .md, .markdown, .pdf); no other text/*, no SVG. .md/.markdown open as
// plain text like .txt. The 파일 고르기 picker offers them.
//   bun test ./qa/upload-types.test.ts
import { describe, expect, test } from "bun:test";
import { checkFile, FILE_ACCEPT, uploadTaken, uploadType, withUploadType } from "../src/lib/uploadTypes";

const NOT_TAKEN = "사진, PDF, 텍스트 파일만 올릴 수 있어요.";
const f = (name: string, type: string, size = 120) => ({ name, type, size });

describe("files that go up: types", () => {
  test("a markdown file with no type, application/octet-stream or text/x-markdown goes up as text/markdown", () => {
    for (const type of ["", "application/octet-stream", "Application/Octet-Stream", "text/markdown", "text/x-markdown"]) {
      for (const name of ["지시문.md", "notes.markdown", "README.MD"]) {
        expect(uploadType(f(name, type))).toBe("text/markdown");
        expect(checkFile(f(name, type))).toBeNull();
      }
    }
  });

  test("a type the browser did give is the one: a .md given text/plain goes as text/plain, a .txt given image/png as a photo", () => {
    expect(uploadType(f("지시문.md", "text/plain"))).toBe("text/plain");
    expect(checkFile(f("지시문.md", "text/plain"))).toBeNull();
    expect(uploadType(f("scan.txt", "image/png"))).toBe("image/png");
    expect(uploadType(f("notes", "text/x-markdown"))).toBe("text/markdown");
    expect(uploadType(f("a.bin", "application/octet-stream"))).toBe("application/octet-stream");
    expect(uploadType(f("a.constructor", ""))).toBe("");
    expect(uploadType(f("a.png", "Image/PNG"))).toBe("image/png");
  });

  test("PDF and .txt: by type, or by extension when the browser gave none or application/octet-stream", () => {
    expect(checkFile(f("a.pdf", "application/pdf"))).toBeNull();
    for (const type of ["", "application/octet-stream", "APPLICATION/OCTET-STREAM"]) {
      expect(uploadType(f("a.PDF", type))).toBe("application/pdf");
      expect(checkFile(f("a.PDF", type))).toBeNull();
      expect(uploadType(f("메모.TXT", type))).toBe("text/plain");
      expect(checkFile(f("메모.TXT", type))).toBeNull();
    }
  });

  test("the server's list: raster photos, PDF, text/plain, text/markdown, text/x-markdown; nothing else", () => {
    for (const t of ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/heic", "image/heif", "image/avif", "image/bmp", "application/pdf", "text/plain", "text/plain;charset=utf-8", "text/markdown", "text/x-markdown", "IMAGE/PNG"]) {
      expect(uploadTaken(t)).toBe(true);
    }
    for (const t of ["", "text/html", "text/csv", "text/css", "image/svg+xml", "image/tiff", "application/zip", "application/octet-stream", "application/json"]) {
      expect(uploadTaken(t)).toBe(false);
    }
  });

  test("other files are refused with the same words; SVG, empty and too large keep their own", () => {
    expect(checkFile(f("a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))).toBe(NOT_TAKEN);
    expect(checkFile(f("a.zip", ""))).toBe(NOT_TAKEN);
    expect(checkFile(f("a.md.zip", "application/zip"))).toBe(NOT_TAKEN);
    expect(checkFile(f("a.bin", "application/octet-stream"))).toBe(NOT_TAKEN);
    expect(checkFile(f("a.html", "text/html"))).toBe(NOT_TAKEN);
    expect(checkFile(f("표.csv", "text/csv"))).toBe(NOT_TAKEN);
    expect(checkFile(f("scan.tiff", "image/tiff"))).toBe(NOT_TAKEN);
    expect(checkFile(f("a.svg", "image/svg+xml"))).toBe("SVG 그림은 올릴 수 없어요. PNG나 JPG로 올려 주세요.");
    expect(checkFile(f("a.md", "", 0))).toBe("빈 파일은 올릴 수 없어요.");
    expect(checkFile(f("a.md", "", 10 * 1024 * 1024 + 1))).toBe("10MB보다 큰 파일은 올릴 수 없어요. 크기를 줄여서 다시 올려 주세요.");
    expect(checkFile(f("photo.heic", "image/heic"))).toBeNull();
  });

  test("the 파일 고르기 picker offers .md and .markdown next to PDF and .txt", () => {
    const parts = FILE_ACCEPT.split(",");
    for (const p of [".md", ".markdown", "text/markdown", ".pdf", ".txt", "application/pdf", "text/plain"]) expect(parts).toContain(p);
  });

  test("the file goes up with the corrected type, same name and bytes; one already right goes as it is", async () => {
    const md = new File(["# 할 일\n- 은행"], "지시문.md", { type: "" });
    const sent = withUploadType(md);
    expect(sent.type).toBe("text/markdown");
    expect(sent.name).toBe("지시문.md");
    expect(await sent.text()).toBe("# 할 일\n- 은행");
    const txt = withUploadType(new File(["은행 가기"], "메모.txt", { type: "application/octet-stream" }));
    expect(txt.type.split(";")[0]).toBe("text/plain"); // Bun's File adds ";charset=utf-8" to text/plain, browsers do not
    expect(await txt.text()).toBe("은행 가기");
    const png = new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" });
    expect(withUploadType(png)).toBe(png);
  });
});
