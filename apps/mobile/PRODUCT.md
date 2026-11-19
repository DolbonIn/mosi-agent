# Product

<!-- impeccable:product-schema 1 -->
<!--
  Written 2026-11-12 by design-director (impeccable `init` method). No interview round was run with the user directly:
  every fact below comes from the team-lead's brief (which relays the user's own instructions), the repo README, the
  server/app code, or docs/design/MOTION-SPEC.md. Lines marked (inferred) are readings of the code that the user has
  not confirmed; lines marked (open) are undecided. Impeccable is Apache-2.0 (github.com/pbakaus/impeccable); this file
  follows its PRODUCT.md template, the template text itself is not copied.
-->

## Platform

ios

iOS-first installable PWA (React 19 + Vite, `apps/mobile`), designed and verified at 390×844 in Safari/WebKit and
Chrome. It is a website, but its design language is deliberately iOS 26 (Liquid Glass, tab bar, sheets, large titles,
Dynamic Island as the agent's status), so iOS conventions govern structure and interaction. Android/desktop get the same
layout; desktop adds an adaptive pointer (MOTION-SPEC §4).

## Users

Korean consumers who hand everyday chores to a personal AI agent they named themselves (default name "깽이"). They are
not technical; they use the app one-handed on a phone, in short bursts between other things, and they expect it to talk
like a capable person, not like software. Typical jobs:

- ask in chat and get an answer with sources (weather, transit, news, government benefits);
- have the agent **phone a business or person on their behalf** and report back;
- have the agent **join a Google Meet** to listen, take notes and summarise;
- **summarise KakaoTalk / Slack** conversations, or send a message after approval;
- find **government support programmes** (정부 지원사업) they qualify for;
- **schedule** recurring work (morning call, briefing, attendance check);
- share a conversation with a **friend** and both agents.

## Product Purpose

모시 is a personal agent that does things, not a chatbot that only answers. Success = the person says one sentence and
the thing is done, with a clear record of what the agent did, and nothing leaves the phone (a message, a call, a
payment) without the person's explicit, device-signed approval.

## Positioning

A Korean-life agent: Korean tools out of the box (k-skill: 기상청, 정부24, 지하철, 뉴스…), Korean messengers through
the user's own account (KakaoTalk via a device-sealed login), real phone calls in a Korean voice, Meet attendance, and
approvals signed by a key that never leaves the device. A rebuild of the Pickle app (com.pickle.client); the
user-facing brand is **모시** (no final consonant: 모시가 / 모시를 / 모시예요).

## Operating Context

- One-handed phone use, frequently interrupted; turns can take seconds to minutes (tool calls, phone calls, meetings),
  so status must be glanceable (Dynamic Island, tool chips) and work must survive leaving the app.
- The chat thread is the home and the record: cards (briefing, weather, results, messenger, schedule, approval,
  credential request, artifact) sit inline in the conversation.
- High-stakes moments: approving a phone call / message / payment, typing a messenger password, letting the agent into
  a meeting with other people.
- Tabs: 채팅 · 둘러보기 · 보관함 · 나의 모시; the drawer holds threads (call, meeting, task, schedule, friend) and search.

## Capabilities and Constraints

- Chat with streaming text, tool chips that fold into "N단계 · 12초", stop/steer, attachments.
- Approvals by risk (MOTION-SPEC §8.6): low → do + 5 s undo; medium → full preview + 보내기/취소; high (call, payment,
  delete) → hold-to-confirm 1.2 s and an equivalent two-tap. Every approval is signed with the device key
  ("이 기기의 키로 확인했어요").
- **Credentials are encrypted on the device** (sealed to the enclave key) and never seen by the LLM or shown back.
  The vault hides values on `visibilitychange`.
- Voice call with the agent (STT → agent → TTS), outbound phone calls (Twilio), Google Meet bot, schedules, friends,
  archive of artifacts (document / dashboard / checklist) and media, connections to messengers, usage quota + tickets,
  payment methods, notification / privacy / display settings.
- Platform constraints (binding): HIG Liquid Glass **two layers** (content = opaque paper; function = glass, ≤3 glass
  elements visible, never glass on glass); **one accent** per screen; touch targets **≥44 px**; Hangul body
  line-height **1.5–1.7** with `word-break: keep-all`; inputs ≥16 px; reduced motion / transparency / contrast twins.
- Copy is Korean 해요체. No emoji in UI chrome.
- (open) Social sign-in (Kakao/Google) is designed in but not wired (no app keys).
- (open) Payments: the payment-method screen exists; real charging is not decided.

## Brand Commitments

- Name: 모시. Agent names are the user's (default 깽이); internal ids keep `pickle`.
- Voice: warm, plain 해요체, short sentences, no hype, no exclamation-mark enthusiasm, no marketing claims. The agent
  says what it will do and what it did. (team-lead brief, user instruction)
- The agent character (R3F blob, hue per agent) is the one expressive element; everything else is calm iOS-native UI.
- Motion is part of the brand: organic spring/morph motion (MOTION-SPEC §2–§3) stays. The user asked to **keep the
  organic motion and remove the slop** (2026-11-12), and replaced the 4-blob gradient wallpaper with a calm background
  ("뒤에 그라데이션 배경이 너무 slop인데 60fps 참고해서 깔끔하게 바꿔줘").
- Rejected by the user (do not reintroduce): tab-bar minimise on scroll/focus; any re-entrance or fade when returning
  to content (closing a sheet/drawer, popping a screen, revisiting a tab).

## Evidence on Hand

- REA of the real Pickle app: summarised in `docs/research/60fps-pickle-per-page.md` and MOTION-SPEC §8.
- QA screenshots: `docs/qa/{app,chat,more,foundation}/`, critique captures `docs/design/impeccable/shots/`.
- No testimonials, customer counts, press or benchmarks exist. Do not fabricate them (e.g. the explore template
  "people count" must come from the server, not design copy).

## Product Principles

1. **Done, then shown.** The agent acts and reports; the UI's job is to make the record of what happened legible.
2. **Nothing leaves without consent.** Outbound actions wait for a device-signed approval whose preview shows exactly
   what will be sent or said. The owner's card shows the full target (phone number, meeting code) from a separate card
   field sent to the device. Stored text, LLM context, logs and the spoken voice keep the masked form
   (`02-***-1234`, `rak-****-kud`). This is team-lead's decision of 2026-11-12, and calls and meetings follow the same rule.
3. **The phone keeps the secrets.** Credentials are sealed on the device; the UI says so plainly, once, where it matters.
4. **Calm by default, alive when working.** Idle is still; motion and the character respond to real state only.
5. **Korean first.** Korean tools, Korean services, Korean typography and Korean grammar (josa) handled correctly.

## Accessibility & Inclusion

- WCAG AA: 4.5:1 body, 3:1 large text; never colour alone (status pills carry icon + words).
- VoiceOver: buttons are buttons, sheets are dialogs with focus trap, streamed text announced per sentence.
- Respect reduced motion, reduced transparency, increased contrast, Dynamic-Type-like text scale (설정 › 화면 및 디자인).
