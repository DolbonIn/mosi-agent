import { describe, expect, test } from "bun:test";
import { FILE_AGAIN, fileFact, fileLine, fileLocked, toggleLabel } from "../src/screens/more/schedules/scheduleFile";

/**
 * A schedule's text file in 예약된 일 (DD 2014): the row's third line, the switch that cannot switch a schedule back on
 * once its file was deleted and it went off, and the sheet's 지시 파일 fact. Synthetic titles and file names only.
 */

const s = (p: { enabled?: boolean; file?: { name: string; deleted?: true } }) => ({ title: "하늘 브리핑", enabled: p.enabled ?? true, file: p.file });

describe("the third line says the file or why it stopped, never 꺼짐 alone (DD 2014 §1)", () => {
  test("three states and no file", () => {
    expect(fileLine(s({ file: { name: "지시문.md" } }))).toBe("지시문.md");
    expect(fileLine(s({ file: { name: "지시문.md" }, enabled: false }))).toBe("지시문.md");
    expect(fileLine(s({ file: { name: "지시문.md", deleted: true } }))).toBe("파일을 지웠어요");
    expect(fileLine(s({ file: { name: "지시문.md", deleted: true }, enabled: false }))).toBe("파일을 지워서 꺼졌어요");
    expect(fileLine(s({}))).toBeNull();
    expect(fileLine(s({ file: { name: "" } }))).toBeNull();
  });
  test("the state lines fit the narrow cell: 12 characters at most", () => {
    for (const t of ["파일을 지웠어요", "파일을 지워서 꺼졌어요"]) expect([...t].length).toBeLessThanOrEqual(12);
  });
});

describe("off for good: the switch does nothing and says why (DD 2014 §1)", () => {
  test("only a deleted file and off; who switched it off does not matter", () => {
    expect(fileLocked(s({ file: { name: "a.md", deleted: true }, enabled: false }))).toBe(true);
    expect(fileLocked(s({ file: { name: "a.md", deleted: true }, enabled: true }))).toBe(false);
    expect(fileLocked(s({ file: { name: "a.md" }, enabled: false }))).toBe(false);
    expect(fileLocked(s({ enabled: false }))).toBe(false);
  });
  test("the switch's name", () => {
    expect(toggleLabel(s({ file: { name: "a.md", deleted: true }, enabled: false }))).toBe("하늘 브리핑, 파일을 지워서 켤 수 없어요");
    expect(toggleLabel(s({ file: { name: "a.md", deleted: true } }))).toBe("하늘 브리핑 켜기");
    expect(toggleLabel(s({ enabled: false }))).toBe("하늘 브리핑 켜기");
  });
});

describe("the sheet (DD 2014 §4)", () => {
  test("지시 파일: the name, or 지웠어요; none without a file", () => {
    expect(fileFact(s({ file: { name: "지시문.md" } }))).toBe("지시문.md");
    expect(fileFact(s({ file: { name: "지시문.md", deleted: true }, enabled: false }))).toBe("지웠어요");
    expect(fileFact(s({}))).toBeNull();
    expect(FILE_AGAIN).toBe("파일을 다시 올리고 예약을 새로 만들면 다시 할 수 있어요.");
  });
});
