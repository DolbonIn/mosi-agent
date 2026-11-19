import { describe, expect, test } from "bun:test";
import { letters, speakable } from "@pickle/protocol";
import { heardText, heardWords, SEC_PER_LETTER, type HeardSpan } from "../src/screens/chat/call/heard";

const span = (text: string, pieces: [number, number][], complete = true): HeardSpan => ({ text, pieces: pieces.map(([at, dur]) => ({ at, dur })), complete });

describe("heardWords", () => {
  test("whole words only, never more letters than heard", () => {
    expect(heardWords("내일 서울은 맑아요.", 0)).toBe("");
    expect(heardWords("내일 서울은 맑아요.", 3)).toBe("내일");
    expect(heardWords("내일 서울은 맑아요.", 5)).toBe("내일 서울은");
    expect(heardWords("내일 서울은 맑아요.", 99)).toBe("내일 서울은 맑아요.");
  });
});

describe("heardText", () => {
  const a = "내일 서울은 맑아요.";
  const b = "낮 최고 기온은 15도예요.";

  test("spans played to the end count whole; the one playing by the share of its audio played", () => {
    const spans = [span(a, [[1, 2]]), span(b, [[3, 1], [4, 1]])];
    expect(heardText(spans, 0.5)).toBe("");
    // 1 s of 2 → 4 of 8 letters: "내일 서울은" has 5, so only "내일"
    expect(heardText(spans, 2)).toBe("내일");
    expect(heardText(spans, 3)).toBe(a);
    // 1 s of 2 in the second span → 5 of its 11 letters: "낮 최고" (3), not "낮 최고 기온은" (6)
    expect(heardText(spans, 4)).toBe(`${a} 낮 최고`);
    expect(heardText(spans, 9)).toBe(`${a} ${b}`);
  });

  test("a gap between pieces (an underrun) doesn't count as played", () => {
    const spans = [span(a, [[1, 1], [5, 1]])];
    expect(heardText(spans, 4.5)).toBe("내일");
    expect(heardText(spans, 6)).toBe(a);
  });

  test("audio still arriving: its length is guessed from the letters when that is longer", () => {
    const guess = letters(a) * SEC_PER_LETTER;
    // 0.5 s arrived and played, not complete: 0.5 / 1.36 s of 8 letters → 2 letters → "내일"
    expect(heardText([span(a, [[0, 0.5]], false)], 0.5)).toBe("내일");
    // the same, complete: all of it played
    expect(heardText([span(a, [[0, 0.5]], true)], 0.5)).toBe(a);
    // more audio than the guess: the audio counts
    expect(heardText([span(a, [[0, guess + 1]], false)], guess + 1)).toBe(a);
  });

  test("Web Speech: a chunk counts once said whole", () => {
    const spans: HeardSpan[] = [
      { text: a, pieces: [], complete: false, web: true, said: true },
      { text: b, pieces: [], complete: false, web: true },
    ];
    expect(heardText(spans, 100)).toBe(a);
  });

  test("the text is speakable and a prefix of the reply's speakable text", () => {
    const reply = "**내일** 서울은 맑아요 😊 낮 최고 기온은 15도예요.";
    // the cutter hands out speech text (markdown and emoji gone)
    const spans = [span("내일 서울은 맑아요", [[0, 1.4]]), span(b, [[1.4, 1.9]])];
    const heard = heardText(spans, 2.4);
    expect(heard).toBe("내일 서울은 맑아요 낮 최고");
    expect(speakable(reply).startsWith(heard)).toBe(true);
  });
});
