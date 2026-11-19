// 스트리밍 리샘플러(창 함수 sinc 저역 통과 + 분수 위치 보간). 페이지·AudioWorklet·테스트가 이 파일 텍스트를 그대로 쓴다.
// createStreamResampler(48000, 16000).process(Float32Array) → Float32Array (내려 받을 때 출력 나이퀴스트의 90%에서 자른다)
function createStreamResampler(inRate, outRate, opts) {
  opts = opts || {};
  var ratio = inRate / outRate; // 출력 한 샘플당 입력 샘플 수
  var fc = 0.5 * Math.min(1, outRate / inRate) * (opts.rolloff || 0.9); // 입력 샘플 기준 차단 주파수(주기/샘플)
  var zeroCrossings = opts.zeroCrossings || 8;
  var half = Math.ceil(zeroCrossings / (2 * fc)); // 커널 반폭(입력 샘플)
  var phases = opts.phases || 256;
  var width = 2 * half + 1;
  // table[p*width + k]: 소수 위치 p/phases에서 입력 i = floor(center) - half + k 의 가중치(합 1로 정규화)
  var table = new Float32Array((phases + 1) * width);
  for (var p = 0; p <= phases; p++) {
    var frac = p / phases;
    var sum = 0;
    for (var k = 0; k < width; k++) {
      var t = k - half - frac; // i - center
      var x = 2 * fc * t;
      var s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      var w = Math.abs(t) >= half + 1 ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * t) / (half + 1));
      table[p * width + k] = s * w;
      sum += s * w;
    }
    for (var k2 = 0; k2 < width; k2++) table[p * width + k2] /= sum;
  }
  var buf = new Float32Array(half); // 앞쪽 0 채움: buf[0]의 절대 위치는 base
  var base = -half;
  var pos = 0; // 다음 출력의 입력 절대 위치

  function process(input) {
    var nb = new Float32Array(buf.length + input.length);
    nb.set(buf, 0);
    nb.set(input, buf.length);
    buf = nb;
    var lastAbs = base + buf.length - 1;
    var maxOut = Math.max(0, Math.floor((lastAbs - half - pos) / ratio) + 1);
    var out = new Float32Array(maxOut);
    var n = 0;
    while (pos + half + 1 <= lastAbs && n < maxOut) {
      var center = pos - base;
      var ci = Math.floor(center);
      var frac = center - ci;
      var pi = Math.round(frac * phases);
      var row = pi * width;
      var i0 = ci - half;
      var acc = 0;
      for (var k = 0; k < width; k++) acc += buf[i0 + k] * table[row + k];
      out[n++] = acc;
      pos += ratio;
    }
    var keepFrom = Math.floor(pos) - half - base;
    if (keepFrom > 0) {
      buf = buf.slice(keepFrom);
      base += keepFrom;
    }
    return n === out.length ? out : out.slice(0, n);
  }

  return { process: process, ratio: ratio, half: half, inRate: inRate, outRate: outRate };
}
