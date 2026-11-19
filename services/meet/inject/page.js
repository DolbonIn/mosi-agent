// services/meet 페이지 주입 스크립트(addInitScript). Node가 앞에 resampler.js와 `var __MOSI_CFG = {...}`를 붙여서 넣는다.
//  - 가상 마이크: getUserMedia의 오디오를 WebAudio MediaStreamDestination 트랙으로 바꾼다(실제 마이크는 열지 않음).
//    Node가 page.evaluate로 base64 s16le PCM을 밀어 넣으면 끊김 없이 이어서 재생한다. stop()으로 즉시 끊는다.
//  - 영상: 요청이 와도 실제 카메라 대신 합성 캔버스 트랙을 준다.
//  - 원격 오디오 캡처: RTCPeerConnection의 오디오 track을 모두 섞어 16 kHz mono s16le ~200 ms 묶음으로
//    window.__mosiPcm(b64, epochMs) 바인딩(Playwright exposeBinding)에 넘긴다.
//  - probe(): Meet 화면 상태(이름 칸, 참여 버튼, 나가기 버튼, 마이크/카메라, 안내 문구 키, 참석자 수)를 요약한다.
//    문구 원문·이름은 돌려주지 않는다(키만).
/* global createStreamResampler, __MOSI_CFG */
(function () {
  "use strict";
  var CFG = typeof __MOSI_CFG === "object" && __MOSI_CFG ? __MOSI_CFG : {};
  var w = window;
  // 하위 프레임에서는 getUserMedia·enumerateDevices만 바꾼다(그 프레임이 마이크를 열어도 가짜 장치의 삐 소리 대신 무음 가상 트랙).
  // 캡처·말하기·화면 점검은 최상위 프레임에서만.
  var IS_TOP = w.top === w;
  if (w.__mosiFrame) return;
  Object.defineProperty(w, "__mosiFrame", { value: true, enumerable: false });

  var MIC_ID = "mosi-virtual-mic";
  var CAM_ID = "mosi-virtual-cam";
  var GROUP_ID = "mosi-virtual-group";
  var MIC_LABEL = CFG.micLabel || "모시 마이크";
  var CAM_LABEL = CFG.camLabel || "모시 카메라";
  var SPK_LABEL = CFG.speakerLabel || "스피커";
  var MIC_RATE = CFG.micRate || 44100;
  var CAP_RATE = 16000;
  var CHUNK = CFG.chunkSamples || 3200; // 200 ms @ 16 kHz

  function hidden(obj, key, value) {
    Object.defineProperty(obj, key, { value: value, enumerable: false, configurable: true, writable: true });
  }

  // ---------------------------------------------------------------- 가상 마이크
  // 줄(sayId)마다 소리 조각을 이어서 예약한다. 다음 줄은 앞 줄이 끝나는 시각에 바로 붙는다(끊김 없음).
  var mic = { ctx: null, dest: null, gain: null, nextTime: 0, sources: [], waiters: [], pushed: 0, holdUntil: 0, underruns: 0, clips: {}, sched: [] };

  function ensureMic() {
    if (mic.ctx) return mic;
    var ctx = new AudioContext({ sampleRate: MIC_RATE, latencyHint: "interactive" });
    var dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    var gain = ctx.createGain();
    gain.connect(dest);
    mic.ctx = ctx;
    mic.dest = dest;
    mic.gain = gain;
    mic.t0 = performance.now();
    if (ctx.state !== "running") ctx.resume().catch(function () {});
    return mic;
  }

  function b64ToFloat(b64) {
    var bin = atob(b64);
    var n = bin.length >> 1;
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      out[i] = v / 32768;
    }
    return out;
  }

  function hasSources(sayId) {
    if (sayId == null) return mic.sources.length > 0;
    for (var i = 0; i < mic.sources.length; i++) if (mic.sources[i].__sayId === sayId) return true;
    return false;
  }

  function settleWaiters() {
    var keep = [];
    var ws = mic.waiters;
    mic.waiters = [];
    for (var i = 0; i < ws.length; i++) {
      if (hasSources(ws[i].sayId)) keep.push(ws[i]);
      else ws[i].fn();
    }
    mic.waiters = keep.concat(mic.waiters);
  }

  function noteSched(sayId, start, end) {
    var last = mic.sched.length ? mic.sched[mic.sched.length - 1] : null;
    if (last && last.sayId === sayId) last.end = end;
    else {
      mic.sched.push({ sayId: sayId, start: start, end: end });
      if (mic.sched.length > 20) mic.sched.shift();
    }
  }

  /** AudioBuffer 하나를 이어서 예약. lead: 앞 소리가 없을 때 지금부터 얼마 뒤에 시작할지(초) */
  function schedule(buf, sayId, first, quick) {
    var m = ensureMic();
    var ctx = m.ctx;
    if (ctx.state !== "running") ctx.resume().catch(function () {});
    var now = ctx.currentTime;
    var start = Math.max(m.nextTime, now + 0.005, m.holdUntil);
    var underrun = false;
    if (m.nextTime < now + 0.005) {
      // 앞에 예약된 소리가 없음: 첫 묶음은 60 ms(캐시된 짧은 소리는 15 ms) 뒤에 바로 시작.
      // 말하는 도중에 TTS가 늦어 바닥나면(underrun) 250 ms를 모아 두고 다시 시작해 더 끊기지 않게 한다.
      underrun = !first;
      if (underrun) m.underruns++;
      start = Math.max(now + (underrun ? 0.25 : quick ? 0.015 : 0.06), m.holdUntil);
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(m.gain);
    src.start(start);
    src.__sayId = sayId == null ? null : sayId;
    m.nextTime = start + buf.duration;
    m.sources.push(src);
    m.pushed++;
    noteSched(src.__sayId, start, m.nextTime);
    src.onended = function () {
      var i = m.sources.indexOf(src);
      if (i >= 0) m.sources.splice(i, 1);
      try { src.disconnect(); } catch (e) {}
      settleWaiters();
    };
    return { queuedMs: (m.nextTime - now) * 1000, startInMs: (start - now) * 1000, underrun: underrun };
  }

  var micApi = {
    /** PCM 한 묶음을 이어서 예약. → {queuedMs, startInMs, underrun} */
    push: function (b64, sampleRate, first, sayId) {
      var m = ensureMic();
      var data = b64ToFloat(b64);
      if (!data.length) return { queuedMs: Math.max(0, (m.nextTime - m.ctx.currentTime) * 1000), startInMs: 0 };
      var buf = m.ctx.createBuffer(1, data.length, sampleRate || MIC_RATE);
      buf.copyToChannel(data, 0);
      return schedule(buf, sayId, first, false);
    },
    /** 짧은 소리(맞장구)를 페이지에 올려 둔다 */
    loadClip: function (key, b64, sampleRate) {
      var m = ensureMic();
      var data = b64ToFloat(b64);
      var buf = m.ctx.createBuffer(1, Math.max(1, data.length), sampleRate || MIC_RATE);
      buf.copyToChannel(data, 0);
      m.clips[key] = buf;
      return { ms: buf.duration * 1000 };
    },
    hasClip: function (key) { return !!mic.clips[key]; },
    /** 올려 둔 소리를 바로 예약(TTS 없음). 없으면 null */
    playClip: function (key, sayId) {
      var buf = mic.clips[key];
      if (!buf) return null;
      return schedule(buf, sayId, true, true);
    },
    /** 예약된 소리를 15 ms 페이드아웃 후 모두 끊는다(끼어들기). */
    stop: function () {
      if (!mic.ctx) return { stopped: 0 };
      var ctx = mic.ctx;
      var now = ctx.currentTime;
      var n = mic.sources.length;
      mic.gain.gain.cancelScheduledValues(now);
      mic.gain.gain.setValueAtTime(mic.gain.gain.value, now);
      mic.gain.gain.linearRampToValueAtTime(0, now + 0.015);
      var srcs = mic.sources.slice();
      mic.sources = [];
      for (var i = 0; i < srcs.length; i++) {
        try { srcs[i].onended = null; srcs[i].stop(now + 0.02); } catch (e) {}
      }
      mic.gain.gain.setValueAtTime(1, now + 0.03);
      mic.nextTime = 0;
      mic.holdUntil = now + 0.035;
      for (var k = 0; k < mic.sched.length; k++) if (mic.sched[k].end > now) mic.sched[k].end = now;
      settleWaiters();
      return { stopped: n };
    },
    /** 그 줄(sayId, 없으면 전부)의 소리가 다 나갈 때까지 기다린다(최대 timeoutMs). */
    drain: function (timeoutMs, sayId) {
      if (!mic.ctx || !hasSources(sayId)) return Promise.resolve({ drained: true });
      return new Promise(function (resolve) {
        var done = false;
        var t = setTimeout(function () { if (!done) { done = true; resolve({ drained: false }); } }, timeoutMs || 120000);
        mic.waiters.push({ sayId: sayId == null ? null : sayId, fn: function () { if (!done) { done = true; clearTimeout(t); resolve({ drained: true }); } } });
      });
    },
    status: function () {
      var now = mic.ctx ? mic.ctx.currentTime : 0;
      return {
        ready: !!mic.ctx,
        state: mic.ctx ? mic.ctx.state : null,
        rate: mic.ctx ? mic.ctx.sampleRate : null,
        queuedMs: mic.ctx ? Math.max(0, (mic.nextTime - now) * 1000) : 0,
        playing: mic.sources.length,
        underruns: mic.underruns,
        tracksIssued: tracksIssued,
        clips: Object.keys(mic.clips).length,
        // 오디오 시계가 벽시계보다 얼마나 뒤처졌는지(ms): 시스템이 멈칫하면 커진다
        clockLagMs: mic.ctx ? Math.round(performance.now() - mic.t0 - mic.ctx.currentTime * 1000) : null,
        // 최근 줄들의 예약 구간(지금 기준 ms): 줄 사이 틈을 재는 데 쓴다
        sched: mic.sched.map(function (x) { return { sayId: x.sayId, startMs: Math.round((x.start - now) * 1000), endMs: Math.round((x.end - now) * 1000) }; }),
      };
    },
  };

  // ---------------------------------------------------------------- 트랙 꾸미기
  var tracksIssued = 0;

  function decorateTrack(t, info) {
    var origSettings = t.getSettings.bind(t);
    var origCaps = t.getCapabilities ? t.getCapabilities.bind(t) : function () { return {}; };
    var origConstraints = t.getConstraints.bind(t);
    var applied = {};
    Object.defineProperty(t, "label", { get: function () { return info.label; }, configurable: true });
    hidden(t, "getSettings", function getSettings() {
      var s = origSettings();
      s.deviceId = info.deviceId;
      s.groupId = GROUP_ID;
      if (info.kind === "audio") {
        s.echoCancellation = applied.echoCancellation !== undefined ? !!applied.echoCancellation : true;
        s.noiseSuppression = applied.noiseSuppression !== undefined ? !!applied.noiseSuppression : true;
        s.autoGainControl = applied.autoGainControl !== undefined ? !!applied.autoGainControl : true;
        s.channelCount = 1;
        s.sampleRate = s.sampleRate || 48000;
      }
      return s;
    });
    hidden(t, "getCapabilities", function getCapabilities() {
      var c = origCaps() || {};
      c.deviceId = info.deviceId;
      c.groupId = GROUP_ID;
      if (info.kind === "audio") {
        c.echoCancellation = [true, false];
        c.noiseSuppression = [true, false];
        c.autoGainControl = [true, false];
        c.channelCount = { min: 1, max: 1 };
      }
      return c;
    });
    hidden(t, "getConstraints", function getConstraints() {
      var c = origConstraints() || {};
      for (var k in applied) c[k] = applied[k];
      return c;
    });
    hidden(t, "applyConstraints", function applyConstraints(c) {
      if (c && typeof c === "object") for (var k in c) applied[k] = c[k];
      return Promise.resolve();
    });
    return t;
  }

  function newMicTrack() {
    var m = ensureMic();
    tracksIssued++;
    var t = m.dest.stream.getAudioTracks()[0].clone();
    return decorateTrack(t, { kind: "audio", deviceId: MIC_ID, label: MIC_LABEL });
  }

  var cam = { canvas: null, timer: null, frame: 0 };
  function newCamTrack() {
    if (!cam.canvas) {
      var c = document.createElement("canvas");
      c.width = 640;
      c.height = 360;
      cam.canvas = c;
      var draw = function () {
        var g = c.getContext("2d");
        if (!g) return;
        cam.frame++;
        g.fillStyle = "#1f2430";
        g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = "rgba(255,255,255," + (0.85 + 0.1 * Math.sin(cam.frame / 10)) + ")";
        g.font = "600 56px -apple-system, 'Apple SD Gothic Neo', sans-serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(CFG.selfName || "모시", c.width / 2, c.height / 2);
      };
      draw();
      cam.timer = setInterval(draw, 200);
    }
    var t = cam.canvas.captureStream(5).getVideoTracks()[0];
    return decorateTrack(t, { kind: "video", deviceId: CAM_ID, label: CAM_LABEL });
  }

  // ---------------------------------------------------------------- getUserMedia / enumerateDevices
  var MD = w.MediaDevices && w.MediaDevices.prototype;
  if (MD && MD.getUserMedia) {
    var gumDesc = Object.getOwnPropertyDescriptor(MD, "getUserMedia");
    var gum = new Proxy(MD.getUserMedia, {
      apply: function (target, thisArg, args) {
        var c = args[0];
        if (!c || typeof c !== "object" || (!c.audio && !c.video)) return Reflect.apply(target, thisArg, args);
        return new Promise(function (resolve, reject) {
          try {
            var tracks = [];
            if (c.audio) tracks.push(newMicTrack());
            if (c.video) tracks.push(newCamTrack());
            resolve(new MediaStream(tracks));
          } catch (e) {
            reject(e);
          }
        });
      },
    });
    Object.defineProperty(MD, "getUserMedia", { value: gum, writable: gumDesc ? gumDesc.writable : true, enumerable: gumDesc ? gumDesc.enumerable : true, configurable: true });
  }

  function fakeDevice(kind, deviceId, label, groupId) {
    var proto = (kind !== "audiooutput" && w.InputDeviceInfo ? w.InputDeviceInfo : w.MediaDeviceInfo).prototype;
    var d = Object.create(proto);
    var plain = { deviceId: deviceId, kind: kind, label: label, groupId: groupId };
    Object.defineProperty(d, "deviceId", { get: function () { return deviceId; }, enumerable: true });
    Object.defineProperty(d, "kind", { get: function () { return kind; }, enumerable: true });
    Object.defineProperty(d, "label", { get: function () { return label; }, enumerable: true });
    Object.defineProperty(d, "groupId", { get: function () { return groupId; }, enumerable: true });
    hidden(d, "toJSON", function toJSON() { return plain; });
    if (kind !== "audiooutput") {
      hidden(d, "getCapabilities", function getCapabilities() {
        return kind === "audioinput"
          ? { deviceId: deviceId, groupId: groupId, echoCancellation: [true, false], noiseSuppression: [true, false], autoGainControl: [true, false], channelCount: { min: 1, max: 1 }, sampleRate: { min: 48000, max: 48000 } }
          : { deviceId: deviceId, groupId: groupId, width: { min: 1, max: 640 }, height: { min: 1, max: 360 }, frameRate: { min: 1, max: 5 } };
      });
    }
    return d;
  }

  if (MD && MD.enumerateDevices) {
    var enumDesc = Object.getOwnPropertyDescriptor(MD, "enumerateDevices");
    var en = new Proxy(MD.enumerateDevices, {
      apply: function (target, thisArg, args) {
        return Reflect.apply(target, thisArg, args).then(function (list) {
          var labels = list.some(function (d) { return !!d.label; });
          var out = [
            fakeDevice("audioinput", "default", labels ? "기본값 - " + MIC_LABEL : "", GROUP_ID),
            fakeDevice("audioinput", MIC_ID, labels ? MIC_LABEL : "", GROUP_ID),
            fakeDevice("videoinput", CAM_ID, labels ? CAM_LABEL : "", GROUP_ID),
          ];
          // 출력 장치는 id를 그대로 두고(setSinkId용) 이름만 중립적으로 바꾼다(가짜 장치 플래그의 "Fake ..." 이름이 보이지 않게).
          var spk = 0;
          for (var i = 0; i < list.length; i++) {
            var d = list[i];
            if (d.kind !== "audiooutput") continue;
            var name = d.deviceId === "default" ? "기본값 - " + SPK_LABEL : d.deviceId === "communications" ? "통신 - " + SPK_LABEL : SPK_LABEL + (spk++ ? " " + spk : "");
            out.push(fakeDevice("audiooutput", d.deviceId, labels ? name : "", d.groupId || GROUP_ID));
          }
          return out;
        });
      },
    });
    Object.defineProperty(MD, "enumerateDevices", { value: en, writable: enumDesc ? enumDesc.writable : true, enumerable: enumDesc ? enumDesc.enumerable : true, configurable: true });
  }

  if (!IS_TOP) return;

  // ---------------------------------------------------------------- 원격 오디오 캡처
  var cap = { ready: null, ctx: null, mix: null, node: null, mode: null, tracks: {}, chunks: 0, enabled: true, error: null, lastPeak: 0 };

  var WORKLET_BODY =
    "\nvar ZERO = new Float32Array(128);\n" +
    "class MosiCapture extends AudioWorkletProcessor {\n" +
    "  constructor(o) { super(); var p = o.processorOptions; this.rs = createStreamResampler(p.inRate, p.outRate); this.size = p.chunk; this.buf = new Int16Array(this.size); this.n = 0; }\n" +
    "  process(inputs) {\n" +
    "    var ch = inputs[0] && inputs[0][0];\n" +
    "    var out = this.rs.process(ch && ch.length ? ch : ZERO);\n" +
    "    for (var i = 0; i < out.length; i++) {\n" +
    "      var v = out[i]; v = v > 1 ? 1 : v < -1 ? -1 : v;\n" +
    "      this.buf[this.n++] = v < 0 ? v * 32768 : v * 32767;\n" +
    "      if (this.n === this.size) { this.port.postMessage(this.buf.buffer, [this.buf.buffer]); this.buf = new Int16Array(this.size); this.n = 0; }\n" +
    "    }\n" +
    "    return true;\n" +
    "  }\n" +
    "}\n" +
    "registerProcessor('mosi-capture', MosiCapture);\n";

  function bytesToB64(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function emitChunk(arrayBuffer) {
    cap.chunks++;
    if (!cap.enabled) return;
    var fn = w.__mosiPcm;
    if (typeof fn !== "function") return;
    var i16 = new Int16Array(arrayBuffer);
    var peak = 0;
    for (var i = 0; i < i16.length; i += 4) { var a = i16[i] < 0 ? -i16[i] : i16[i]; if (a > peak) peak = a; }
    cap.lastPeak = peak;
    try { fn(bytesToB64(new Uint8Array(arrayBuffer)), Date.now()); } catch (e) {}
  }

  function ensureCapture() {
    if (cap.ready) return cap.ready;
    cap.ready = (async function () {
      var ctx = new AudioContext({ sampleRate: 48000, latencyHint: "playback" });
      var mix = ctx.createGain();
      mix.channelCount = 1;
      mix.channelCountMode = "explicit";
      mix.channelInterpretation = "speakers";
      var sink = ctx.createGain();
      sink.gain.value = 0;
      sink.connect(ctx.destination);
      var node = null;
      if (!CFG.forceScriptProcessor && ctx.audioWorklet && w.AudioWorkletNode) {
        try {
          var src = createStreamResampler.toString() + WORKLET_BODY;
          var url = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
          await ctx.audioWorklet.addModule(url);
          URL.revokeObjectURL(url);
          node = new AudioWorkletNode(ctx, "mosi-capture", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: "explicit",
            processorOptions: { inRate: ctx.sampleRate, outRate: CAP_RATE, chunk: CHUNK },
          });
          node.port.onmessage = function (e) { emitChunk(e.data); };
          cap.mode = "worklet";
        } catch (e) {
          cap.error = "worklet:" + (e && e.name ? e.name : "error");
          node = null;
        }
      }
      if (!node) {
        node = ctx.createScriptProcessor(4096, 1, 1);
        var rs = createStreamResampler(ctx.sampleRate, CAP_RATE);
        var acc = new Int16Array(CHUNK);
        var n = 0;
        node.onaudioprocess = function (ev) {
          var out = rs.process(ev.inputBuffer.getChannelData(0));
          for (var i = 0; i < out.length; i++) {
            var v = out[i];
            v = v > 1 ? 1 : v < -1 ? -1 : v;
            acc[n++] = v < 0 ? v * 32768 : v * 32767;
            if (n === CHUNK) { emitChunk(acc.buffer); acc = new Int16Array(CHUNK); n = 0; }
          }
        };
        cap.mode = "script";
      }
      mix.connect(node);
      node.connect(sink);
      if (ctx.state !== "running") await ctx.resume().catch(function () {});
      cap.ctx = ctx;
      cap.t0 = performance.now() - ctx.currentTime * 1000;
      cap.mix = mix;
      cap.node = node;
      return cap;
    })();
    return cap.ready;
  }

  function attachTrack(track) {
    if (!track || track.kind !== "audio" || cap.tracks[track.id]) return;
    cap.tracks[track.id] = { pending: true };
    ensureCapture().then(function (c) {
      if (track.readyState === "ended") { delete cap.tracks[track.id]; return; }
      var stream = new MediaStream([track]);
      // Chrome: 원격 WebRTC 트랙은 미디어 요소에 붙어 있어야 WebAudio로 샘플이 흐른다. 음소거 요소에 붙여 둔다.
      var el = new Audio();
      el.muted = true;
      el.autoplay = true;
      el.srcObject = stream;
      var p = el.play();
      if (p && p.catch) p.catch(function () {});
      var node = c.ctx.createMediaStreamSource(stream);
      node.connect(c.mix);
      cap.tracks[track.id] = { el: el, node: node };
      track.addEventListener("ended", function () { detachTrack(track.id); });
    }).catch(function (e) {
      cap.error = "capture:" + (e && e.name ? e.name : "error");
      delete cap.tracks[track.id];
    });
  }

  function detachTrack(id) {
    var t = cap.tracks[id];
    if (!t) return;
    try { t.node && t.node.disconnect(); } catch (e) {}
    try { if (t.el) { t.el.pause(); t.el.srcObject = null; } } catch (e) {}
    delete cap.tracks[id];
  }

  var pcs = [];
  function hookPc(pc) {
    pcs.push({ pc: pc, prev: null });
    if (pcs.length > 8) pcs.shift();
    pc.addEventListener("track", function (ev) {
      if (ev.track && ev.track.kind === "audio") attachTrack(ev.track);
    });
  }

  if (w.RTCPeerConnection) {
    var OrigPC = w.RTCPeerConnection;
    var PCProxy = new Proxy(OrigPC, {
      construct: function (target, args, newTarget) {
        var pc = Reflect.construct(target, args, newTarget);
        try { hookPc(pc); } catch (e) {}
        return pc;
      },
    });
    var pcDesc = Object.getOwnPropertyDescriptor(w, "RTCPeerConnection");
    Object.defineProperty(w, "RTCPeerConnection", { value: PCProxy, writable: true, enumerable: pcDesc ? pcDesc.enumerable : false, configurable: true });
    if (w.webkitRTCPeerConnection) Object.defineProperty(w, "webkitRTCPeerConnection", { value: PCProxy, writable: true, enumerable: false, configurable: true });
  }

  /** 받는 쪽 지터 버퍼(NetEq) 지연: 지난번 호출 이후 평균(ms). 시스템이 멈칫하면 몇백 ms로 커지고 오래 남는다 */
  function rxJitter() {
    var jobs = pcs.filter(function (x) { return x.pc.connectionState !== "closed"; }).map(function (x) {
      return x.pc.getStats().then(function (st) {
        var d = 0, n = 0, tgt = 0;
        st.forEach(function (r) {
          if (r.type !== "inbound-rtp" || r.kind !== "audio") return;
          d += r.jitterBufferDelay || 0; n += r.jitterBufferEmittedCount || 0; tgt += r.jitterBufferTargetDelay || 0;
        });
        var p = x.prev;
        x.prev = { d: d, n: n, tgt: tgt };
        if (!p || n <= p.n) return null;
        return { jbMs: Math.round(((d - p.d) / (n - p.n)) * 1000), targetMs: Math.round(((tgt - p.tgt) / (n - p.n)) * 1000) };
      }).catch(function () { return null; });
    });
    return Promise.all(jobs).then(function (rs) {
      var best = null;
      for (var i = 0; i < rs.length; i++) if (rs[i] && (!best || rs[i].jbMs > best.jbMs)) best = rs[i];
      return best;
    });
  }

  var captureApi = {
    enable: function (on) { cap.enabled = !!on; return cap.enabled; },
    rxJitter: rxJitter,
    status: function () {
      var live = 0;
      for (var k in cap.tracks) if (cap.tracks[k].node) live++;
      return { mode: cap.mode, state: cap.ctx ? cap.ctx.state : null, rate: cap.ctx ? cap.ctx.sampleRate : null, tracks: live, chunks: cap.chunks, error: cap.error, lastPeak: cap.lastPeak, clockLagMs: cap.ctx ? Math.round(performance.now() - cap.t0 - cap.ctx.currentTime * 1000) : null };
    },
  };

  // ---------------------------------------------------------------- Meet 화면 상태
  var SEL = CFG.selectors || {};
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }
  function anyVisible(sel) {
    if (!sel) return null;
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) if (visible(els[i])) return els[i];
    return null;
  }
  function btnText(el) {
    return ((el.getAttribute("aria-label") || el.innerText || el.textContent || "") + "").replace(/\s+/g, " ").trim();
  }
  function findJoin() {
    var labels = SEL.joinLabels || [];
    var els = document.querySelectorAll("button, [role=button]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!visible(el)) continue;
      var t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      var a = (el.getAttribute("aria-label") || "").trim();
      for (var j = 0; j < labels.length; j++) {
        if (t === labels[j].label || a === labels[j].label) {
          return { kind: labels[j].kind, disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true" };
        }
      }
    }
    return null;
  }
  function toggleState(words, icons) {
    var els = document.querySelectorAll("[data-is-muted]");
    var byIcon = null;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!visible(el)) continue;
      var st = el.getAttribute("data-is-muted") === "true" ? "off" : "on";
      var a = (el.getAttribute("aria-label") || "").toLowerCase();
      for (var j = 0; j < words.length; j++) if (a.indexOf(words[j].toLowerCase()) >= 0) return st;
      var t = (el.innerText || "").trim();
      if (!byIcon && icons && icons.indexOf(t) >= 0) byIcon = st;
    }
    return byIcon;
  }
  function findLeave() {
    var el = anyVisible(SEL.leaveButton);
    if (el) return el;
    if (!SEL.leaveIcon) return null;
    var bs = document.querySelectorAll("button, [role=button]");
    for (var i = 0; i < bs.length; i++) if ((bs[i].innerText || "").trim() === SEL.leaveIcon && visible(bs[i])) return bs[i];
    return null;
  }
  function participantCount() {
    var ids = {};
    var n = 0;
    var tiles = document.querySelectorAll("[data-participant-id]");
    for (var i = 0; i < tiles.length; i++) {
      var id = tiles[i].getAttribute("data-participant-id");
      if (id && !ids[id]) { ids[id] = 1; n++; }
    }
    var badge = 0;
    var re = SEL.peopleButtonRe ? new RegExp(SEL.peopleButtonRe, "i") : null;
    if (re) {
      var bs = document.querySelectorAll("button[aria-label], [role=button][aria-label]");
      for (var k = 0; k < bs.length; k++) {
        var a = bs[k].getAttribute("aria-label") || "";
        if (!re.test(a)) continue;
        var m = (bs[k].textContent || "").match(/\d+/) || a.match(/\d+/);
        if (m) badge = Math.max(badge, parseInt(m[0], 10));
      }
    }
    var c = Math.max(n, badge);
    return c || null;
  }
  var SIGNALS = [];
  var sigSrc = SEL.signals || {};
  for (var key in sigSrc) SIGNALS.push([key, new RegExp(sigSrc[key], "i")]);

  function probe() {
    var text = document.body ? (document.body.innerText || "").slice(0, 30000) : "";
    var signals = [];
    for (var i = 0; i < SIGNALS.length; i++) if (SIGNALS[i][1].test(text)) signals.push(SIGNALS[i][0]);
    var join = findJoin();
    return {
      ready: document.readyState,
      nameInput: !!anyVisible(SEL.nameInput),
      join: join,
      leave: !!findLeave(),
      waitingCopy: signals.indexOf("waiting") >= 0,
      mic: toggleState(SEL.micWords || [], SEL.micIcons),
      cam: toggleState(SEL.camWords || [], SEL.camIcons),
      signals: signals,
      participants: participantCount(),
    };
  }

  // ---------------------------------------------------------------- 말하는 사람(최선 노력)
  var spk = { obs: null, act: {} };
  function tileName(tile) {
    var el = tile.querySelector("[data-self-name]");
    var n = el ? el.getAttribute("data-self-name") : null;
    if (!n) { var nt = tile.querySelector(".notranslate"); n = nt ? nt.textContent : null; }
    n = (n || "").replace(/\s+/g, " ").trim();
    return n && n.length <= 60 ? n : null;
  }
  function watchSpeakers(on) {
    if (!on) { if (spk.obs) spk.obs.disconnect(); spk.obs = null; return false; }
    if (spk.obs || !document.body) return !!spk.obs;
    spk.obs = new MutationObserver(function (records) {
      var now = performance.now();
      for (var i = 0; i < records.length; i++) {
        var t = records[i].target;
        if (!t || !t.closest) continue;
        var tile = t.closest("[data-participant-id]");
        if (!tile || tile === t) continue;
        var id = tile.getAttribute("data-participant-id");
        var e = spk.act[id] || (spk.act[id] = { t: 0, n: 0, tile: tile });
        if (now - e.t > 1500) e.n = 0;
        e.t = now;
        e.n++;
        e.tile = tile;
      }
    });
    spk.obs.observe(document.body, { attributes: true, attributeFilter: ["class"], subtree: true });
    return true;
  }
  function activeSpeaker() {
    var now = performance.now();
    var hits = [];
    for (var id in spk.act) {
      var e = spk.act[id];
      if (now - e.t > 1200 || e.n < 2 || !e.tile.isConnected) continue;
      var name = tileName(e.tile);
      if (!name || name === CFG.selfName) continue;
      hits.push(name);
    }
    return hits.length === 1 ? hits[0] : null;
  }

  hidden(w, "__mosi", {
    mic: micApi,
    capture: captureApi,
    probe: probe,
    watchSpeakers: watchSpeakers,
    activeSpeaker: activeSpeaker,
    attachTrack: attachTrack,
    version: 1,
  });
})();
