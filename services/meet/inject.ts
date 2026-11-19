// 페이지 주입 스크립트 조립: 설정 + resampler.js + page.js 를 한 IIFE로 묶는다(전역 이름을 남기지 않는다).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SELECTORS } from "./selectors";

const DIR = join(import.meta.dir, "inject");

export interface InjectOptions {
  selfName?: string;
  micRate?: number;
  forceScriptProcessor?: boolean;
  /** 회의 소리를 노드로 넘기는 묶음 길이(16 kHz 샘플 수) */
  chunkSamples?: number;
}

export function resamplerSource(): string {
  return readFileSync(join(DIR, "resampler.js"), "utf8");
}

export function buildInitScript(opts: InjectOptions = {}): string {
  const cfg = {
    selfName: opts.selfName ?? "모시",
    micRate: opts.micRate ?? 44100,
    forceScriptProcessor: !!opts.forceScriptProcessor,
    ...(opts.chunkSamples ? { chunkSamples: opts.chunkSamples } : {}),
    selectors: SELECTORS,
  };
  const page = readFileSync(join(DIR, "page.js"), "utf8");
  return `(function(){\nvar __MOSI_CFG = ${JSON.stringify(cfg)};\n${resamplerSource()}\n${page}\n})();\n`;
}
