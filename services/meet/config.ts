import { homedir } from "node:os";
import { join } from "node:path";

function num(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function sttEngine(): "soniox" | "local" {
  const v = process.env.MEET_STT;
  if (v === "local") return "local";
  if (v === "soniox") return process.env.SONIOX_API_KEY ? "soniox" : "local";
  return process.env.SONIOX_API_KEY ? "soniox" : "local";
}

export const config = {
  host: "127.0.0.1",
  port: num("MEET_PORT", 8781),
  sttUrl: (process.env.MEET_STT_URL ?? "http://127.0.0.1:8782").replace(/\/$/, ""),
  ttsUrl: (process.env.MEET_TTS_URL ?? "http://127.0.0.1:8790").replace(/\/$/, ""),
  ttsVoice: process.env.MEET_TTS_VOICE || undefined,
  profileDir: process.env.MEET_PROFILE_DIR ?? join(homedir(), ".config", "pickle-clone", "meet-chrome"),
  headless: process.env.MEET_HEADLESS === "1",
  /** 테스트 전용: http://127.0.0.1 루프백 페이지를 회의 대신 연다(참여 흐름 생략). */
  testLoopback: process.env.MEET_TEST_LOOPBACK === "1",
  /** 점검용: 참여 전 화면에서 이름·마이크·카메라까지만 하고 참여 버튼은 누르지 않는다(prejoin에 머문다) */
  noJoin: process.env.MEET_NO_JOIN === "1",
  /** 시험 루프백에서도 TTS 데우기를 할지(기본: 실제 회의에서만) */
  warmTtsInTest: process.env.MEET_WARM_TTS === "1",
  /** 시험용: AudioWorklet 대신 ScriptProcessor 대체 경로로 캡처 */
  forceScriptProcessor: process.env.MEET_FORCE_SCRIPT_PROCESSOR === "1",
  admissionTimeoutMs: num("MEET_ADMISSION_TIMEOUT_MS", 5 * 60_000),
  aloneTimeoutMs: num("MEET_ALONE_TIMEOUT_MS", 2 * 60_000),
  prejoinTimeoutMs: num("MEET_PREJOIN_TIMEOUT_MS", 45_000),
  /** 회의 페이지 열기: 시도 횟수와 시도마다 제한(서버 응답 commit까지 / DOM까지). 실패하면 Chrome을 다시 띄워 한 번 더 */
  gotoAttempts: 2,
  gotoCommitTimeoutMs: num("MEET_GOTO_COMMIT_TIMEOUT_MS", 8_000),
  gotoTimeoutMs: num("MEET_GOTO_TIMEOUT_MS", 20_000),
  /** ctx.close()가 이보다 오래 걸리면 띄운 Chrome 프로세스(그룹)를 죽인다 */
  closeTimeoutMs: 5_000,
  /** goto 실패 때 ctx.cookies()가 이 안에 오는지 본다(쿠키 저장소는 macOS Keychain을 쓴다: Keychain 멈춤과 망 단절을 가르는 단서) */
  cookieProbeMs: 2_000,
  /** 받아 적기: soniox(실시간, 키가 있으면 기본) | local(services/stt). soniox가 치명적으로 실패하면 세션 안에서 local로 넘어간다 */
  stt: sttEngine(),
  /** Soniox 키: 이 프로세스 안에서만 쓴다(로그·페이지·응답에 넣지 않는다) */
  sonioxKey: process.env.SONIOX_API_KEY || undefined,
  sonioxUrl: process.env.MEET_SONIOX_URL || undefined,
  sonioxModel: process.env.MEET_SONIOX_MODEL || "stt-rt-v6",
  /** Soniox 자동 끝점(<end>). 기본 끔: 켜면 문장 안 0.1초 쉼에서도 발화가 조각난다(2026-11-12 측정). 끄면 finalize로만 닫는다 */
  sonioxEndpoint: process.env.MEET_SONIOX_ENDPOINT === "1",
  /** Soniox: 말이 이만큼 멈추면 finalize를 보내 발화를 바로 닫는다 */
  finalizeSilenceMs: Math.min(2000, Math.max(100, num("MEET_FINALIZE_SILENCE_MS", 300))),
  /** 말 끝 침묵 판정(VAD hangover, local 길). 계약 기본 700 ms */
  vadHangoverMs: Math.min(2000, Math.max(200, num("MEET_VAD_HANGOVER_MS", 700))),
  /** 세션 시작 때 TTS로 한 번 만들어 두는 맞장구 문장들('|'로 구분, 빈 값이면 끔) */
  ackTexts: (process.env.MEET_ACK_TEXTS ?? "네,|네, 잠시만요.|음,|네, 듣고 있을게요.|찾아볼게요.|잠시만요.").split("|").map((t) => t.trim()).filter(Boolean),
  defaultName: "모시",
  maxSayChars: 600,
};

export type Config = typeof config;

export const CHROME_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--use-fake-ui-for-media-stream",
  // 주입 스크립트가 어떤 이유로 빠져도 실제 마이크·카메라가 열리지 않게 가짜 장치를 쓴다(개인정보 보호용 이중 안전장치).
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--mute-audio",
  "--window-size=1280,860",
  "--no-default-browser-check",
  "--no-first-run",
];
