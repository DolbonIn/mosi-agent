import { describe, expect, test } from "bun:test";
import { agentState, getAgentState } from "../src/app/agentState";
import { stepsSummary, toolLabel, toolSource } from "../src/app/agentVocab";
import { bannerHold, island, islandStore } from "../src/app/island";

describe("agent-state vocabulary (MOTION-SPEC §8.3)", () => {
  test("labels come from the real tool name", () => {
    expect(toolLabel("k_weather")).toBe("날씨 보는 중");
    expect(toolLabel("k.weather")).toBe("날씨 보는 중");
    expect(toolLabel("msg_read")).toBe("메시지 읽는 중");
    expect(toolLabel("msg_read", "카카오톡 대화 읽기")).toBe("카카오톡 읽는 중");
    expect(toolLabel("sys_call_me")).toBe("전화 거는 중");
    expect(toolLabel("sys_phone_call")).toBe("전화 거는 중");
    expect(toolLabel("totally_new_tool")).toBe("작업하는 중");
    expect(toolLabel("web_search")).toBe("웹 찾는 중");
    expect(toolLabel("web_read")).toBe("페이지 읽는 중");
    expect(toolSource("web_read")).toBe("웹");
    expect(toolSource("k_weather")).toBe("기상청");
    expect(stepsSummary(4, 12_300)).toBe("4단계 · 12초");
    expect(stepsSummary(2, 93_000)).toBe("2단계 · 1분 33초");
    expect(stepsSummary(3, 120_200)).toBe("3단계 · 2분");
  });

  test("states: idle is still (no level), thinking hides its text for the first second, tool/streaming/done", () => {
    island.idle();
    expect(getAgentState()).toMatchObject({ kind: "idle", label: "", level: 0, slow: false, elapsedS: 0 });
    island.thinking("t1");
    expect(getAgentState()).toMatchObject({ kind: "thinking", label: "", threadId: "t1" });
    island.tool("k_weather");
    expect(islandStore.get().state).toBe("tool:k_weather");
    expect(getAgentState()).toMatchObject({ kind: "tool", tool: "k_weather", label: "날씨 보는 중", threadId: "t1" });
    island.tokens(12);
    expect(getAgentState()).toMatchObject({ kind: "streaming", label: "답하는 중" });
    agentState.set("awaiting_approval", { label: "메일 보내기" });
    expect(islandStore.get().announce).toBe("승인이 필요해요: 메일 보내기");
    island.done();
    expect(getAgentState().kind).toBe("done");
    island.idle();
    expect(getAgentState()).toMatchObject({ kind: "idle", level: 0 });
  });

  test("level only from real values, only in states that show bars", () => {
    island.idle();
    agentState.level(0.8);
    expect(getAgentState().level).toBe(0);
    island.listening();
    island.micLevel(0.6);
    expect(getAgentState().level).toBeCloseTo(0.6);
    island.idle();
    expect(getAgentState().level).toBe(0);
  });

  test("stall after 15 s without events → slow (not error); an event clears it", () => {
    island.thinking("t2");
    island.debugAge(16_000);
    expect(getAgentState()).toMatchObject({ kind: "thinking", slow: true, label: "생각하는 중" });
    expect(getAgentState().elapsedS).toBeGreaterThanOrEqual(16);
    agentState.pulse();
    expect(getAgentState().slow).toBe(false);
    island.idle();
  });

  test("banner hold = clamp(1.5 s + 60 ms × characters, 2–4 s)", () => {
    expect(bannerHold({ title: "복사했어요" })).toBe(2000);
    expect(bannerHold({ title: "결제 승인이 필요해요", body: "쿠팡 · 32,400원" })).toBe(1500 + 60 * ("결제 승인이 필요해요".length + "쿠팡 · 32,400원".length));
    expect(bannerHold({ title: "가".repeat(30), body: "나".repeat(30) })).toBe(4000);
  });

  test("banners queue one at a time; undo runs its action and skips onExpire", () => {
    let undone = 0;
    let expired = 0;
    const a = island.undo({ title: "모닝콜을 만들었어요", onUndo: () => void undone++, onExpire: () => void expired++ });
    const b = island.banner({ icon: "bell", title: "두 번째" });
    expect(islandStore.get().banner?.id).toBe(a);
    expect(islandStore.get().banner?.hold).toBe(5000);
    islandStore.get().banner?.action?.run?.();
    island.dismissBanner(a, "action");
    expect(undone).toBe(1);
    expect(expired).toBe(0);
    expect(islandStore.get().banner).toBeNull(); // the next one drops after the contraction (520 ms)
    expect(b).toBeGreaterThan(a);
    island.clearBanners();
  });
});
