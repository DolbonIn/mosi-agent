// 둘러보기 템플릿 (screens/more/explore/templateInfo.ts): what PreDelegateSheet reads off a template.
import { expect, test } from "bun:test";
import type { TaskTemplate } from "@pickle/protocol";
import { asksFirst } from "../src/screens/more/explore/templateInfo";

const tpl = (prompt: string, asks: boolean): TaskTemplate => ({
  id: "t", category: "daily", title: "하늘", description: "", icon: "chat", hue: 0, prompt, asksFirst: asks, count: 0, skills: [],
} as unknown as TaskTemplate);

test("'시작하기 전에 필요한 것만 짧게 물어봐요' follows the server's asksFirst, not words in the prompt", () => {
  expect(asksFirst(tpl("매일 아침 7시에 모닝 브리핑을 보내 줘.", true))).toBe(true);
  expect(asksFirst(tpl("오늘 주요 뉴스를 브리핑해 줘.", false))).toBe(false);
  // the old prompts said "모르면 먼저 물어봐"; a prompt that still says so does not turn the note on by itself
  expect(asksFirst(tpl("모르면 먼저 물어봐", false))).toBe(false);
});
