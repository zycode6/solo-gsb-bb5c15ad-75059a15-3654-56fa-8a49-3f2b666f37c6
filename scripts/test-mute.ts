import type { AudioBufferLike } from '../src/types';
import {
  MAX_MUTE_FADE_SEC,
  applyMuteToChannelData,
  buildMuteFrameRanges,
  maxFadeFrames,
  mergeFrameRanges,
  muteEnvelopeGain,
  muteRangeToFrames,
  processMuteChannelData,
  type MuteRange,
} from '../src/audio/mute';

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`ok ${msg}`);
  else {
    failures++;
    console.error(`FAIL ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`FAIL ${msg}: expected ${e}, got ${a}`);
  } else {
    console.log(`ok ${msg}`);
  }
}
function near(actual: number, expected: number, msg: string, tol = 1e-9) {
  if (Math.abs(actual - expected) > tol) {
    failures++;
    console.error(`FAIL ${msg}: expected ~${expected}, got ${actual}`);
  } else {
    console.log(`ok ${msg}`);
  }
}
function nearArr(actual: ArrayLike<number>, expected: number[], msg: string, tol = 1e-9) {
  const a = Array.from(actual);
  if (a.length !== expected.length || a.some((v, i) => Math.abs(v - expected[i]) > tol)) {
    failures++;
    console.error(`FAIL ${msg}: expected ~[${expected}], got [${a}]`);
  } else {
    console.log(`ok ${msg}`);
  }
}
function throws(fn: () => unknown, part: string, msg: string) {
  try {
    fn();
    failures++;
    console.error(`FAIL ${msg}: expected throw containing "${part}"`);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (!text.includes(part)) {
      failures++;
      console.error(`FAIL ${msg}: expected message containing "${part}", got "${text}"`);
    } else console.log(`ok ${msg}`);
  }
}

function makeBuffer(channels: Float32Array[], sampleRate: number): AudioBufferLike {
  return {
    duration: channels[0].length / sampleRate,
    length: channels[0].length,
    sampleRate,
    numberOfChannels: channels.length,
    getChannelData: (ch) => channels[ch],
  };
}

function range(id: string, start: number, end: number): MuteRange {
  return { id, start, end };
}

// ---- 常量与包络帧数 ----
ok(MAX_MUTE_FADE_SEC === 0.02, 'fade envelope is capped at 20ms');
eq(maxFadeFrames(48000), 960, '20ms at 48kHz = 960 frames');
eq(maxFadeFrames(44100), 882, '20ms at 44.1kHz = 882 frames');
eq(maxFadeFrames(8000), 160, '20ms at 8kHz = 160 frames');
eq(maxFadeFrames(10), 1, 'tiny sample rate still gets at least 1 fade frame');
eq(maxFadeFrames(0), 1, 'invalid sample rate falls back to 1 frame');

// ---- muteRangeToFrames：裁剪到音频范围 + 取整 ----
{
  const buf = makeBuffer([new Float32Array(48000)], 48000); // 1s
  eq(muteRangeToFrames(0.25, 0.5, buf), { startFrame: 12000, endFrame: 24000 }, 'seconds to frames');
  eq(muteRangeToFrames(-1, 2, buf), { startFrame: 0, endFrame: 48000 }, 'both ends clipped to audio range');
  eq(muteRangeToFrames(-1, 0.5, buf), { startFrame: 0, endFrame: 24000 }, 'negative start clips to 0');
  eq(muteRangeToFrames(0.5, 99, buf), { startFrame: 24000, endFrame: 48000 }, 'end beyond duration clips to length');
  eq(muteRangeToFrames(0.5, 0.5, buf), null, 'zero-length range rejected');
  eq(muteRangeToFrames(0.7, 0.3, buf), null, 'inverted range rejected');
  eq(muteRangeToFrames(2, 3, buf), null, 'fully out-of-range rejected');
  eq(muteRangeToFrames(NaN, 0.5, buf), null, 'NaN start rejected');
  eq(muteRangeToFrames(0.1, Infinity, buf), null, 'Infinite end rejected');
  eq(muteRangeToFrames(0, 1, makeBuffer([new Float32Array(0)], 48000)), null, 'empty buffer rejected');
}

// ---- mergeFrameRanges：重叠与相接都合并 ----
{
  eq(
    mergeFrameRanges([
      { startFrame: 10, endFrame: 20 },
      { startFrame: 15, endFrame: 30 },
    ]),
    [{ startFrame: 10, endFrame: 30 }],
    'overlapping ranges merge',
  );
  eq(
    mergeFrameRanges([
      { startFrame: 10, endFrame: 20 },
      { startFrame: 20, endFrame: 30 },
    ]),
    [{ startFrame: 10, endFrame: 30 }],
    'touching ranges merge',
  );
  eq(
    mergeFrameRanges([
      { startFrame: 10, endFrame: 20 },
      { startFrame: 21, endFrame: 30 },
    ]),
    [
      { startFrame: 10, endFrame: 20 },
      { startFrame: 21, endFrame: 30 },
    ],
    'ranges one frame apart stay separate',
  );
  eq(
    mergeFrameRanges([
      { startFrame: 40, endFrame: 50 },
      { startFrame: 0, endFrame: 10 },
      { startFrame: 5, endFrame: 45 },
    ]),
    [{ startFrame: 0, endFrame: 50 }],
    'unsorted nested ranges merge into one sorted span',
  );
  eq(
    mergeFrameRanges([
      { startFrame: 5, endFrame: 5 },
      { startFrame: 8, endFrame: 2 },
      { startFrame: 1, endFrame: 3 },
    ]),
    [{ startFrame: 1, endFrame: 3 }],
    'invalid ranges are dropped',
  );
  eq(mergeFrameRanges([]), [], 'empty input merges to empty');
  {
    const input = [
      { startFrame: 10, endFrame: 20 },
      { startFrame: 15, endFrame: 25 },
    ];
    mergeFrameRanges(input);
    eq(input, [
      { startFrame: 10, endFrame: 20 },
      { startFrame: 15, endFrame: 25 },
    ], 'input array is not mutated');
  }
}

// ---- buildMuteFrameRanges：裁剪 + 合并的整条流水线 ----
{
  const buf = makeBuffer([new Float32Array(48000)], 48000);
  eq(
    buildMuteFrameRanges(
      [range('b', 0.4, 0.6), range('a', 0.1, 0.2), range('c', 0.55, 0.7), range('x', 5, 6)],
      buf,
    ),
    [
      { startFrame: 4800, endFrame: 9600 },
      { startFrame: 19200, endFrame: 33600 },
    ],
    'ranges clipped, invalid dropped, touching pairs merged, sorted by start',
  );
  eq(buildMuteFrameRanges([], buf), [], 'no ranges -> nothing to mute');
  eq(buildMuteFrameRanges([range('x', 2, 3)], buf), [], 'all out of range -> empty');
}

// ---- muteEnvelopeGain：衰减 / 静音 / 恢复 ----
{
  // 区间 [0, 10)，包络 3 帧：1-2/3、2-1/3、3-0 … 0 … 7-0、8-1/3、9-2/3
  const g = (i: number) => muteEnvelopeGain(i, 0, 10, 3);
  nearArr([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(g), [2 / 3, 1 / 3, 0, 0, 0, 0, 0, 0, 1 / 3, 2 / 3],
    'long range: fade-out, silent hold, fade-in');
  eq(g(-1), 1, 'frame before the range is untouched');
  eq(g(10), 1, 'frame at end (half-open) is untouched');
  eq(g(100), 1, 'frame far after the range is untouched');

  // 包络恰好铺满区间（n = 2f）：无静音平台，中点相接
  const exact = (i: number) => muteEnvelopeGain(i, 0, 6, 3);
  nearArr([0, 1, 2, 3, 4, 5].map(exact), [2 / 3, 1 / 3, 0, 1 / 3, 2 / 3, 1],
    'fades exactly tiling the range meet at the midpoint');
  ok(exact(5) === 1, 'last frame fully recovers when fades tile exactly');

  // 区间短于 2f：包络等比例压缩到中点相接
  nearArr([0, 1, 2].map((i) => muteEnvelopeGain(i, 0, 3, 960)), [1 / 3, 1 / 3, 1],
    'odd tiny range: compressed fades cross at the midpoint');
  nearArr([0, 1].map((i) => muteEnvelopeGain(i, 0, 2, 960)), [0, 1],
    'two-frame range: mute then immediate recover');
  eq([muteEnvelopeGain(0, 0, 1, 960)], [0], 'single frame is fully muted');

  // 非零起点
  nearArr([4, 5, 6, 7, 8].map((i) => muteEnvelopeGain(i, 5, 8, 2)), [1, 1 / 3, 1 / 3, 1, 1],
    'offset range: envelope relative to range start');

  eq(muteEnvelopeGain(0, 0, 10, 0), 0, 'zero fade frames -> hard mute');
  eq(muteEnvelopeGain(0, 5, 5, 3), 1, 'empty range never mutes');
}

// ---- applyMuteToChannelData：声道数据实际处理 ----
{
  const src = new Float32Array(10).fill(1);
  const before = Array.from(src);
  const out = applyMuteToChannelData([src], [{ startFrame: 2, endFrame: 8 }], 2);
  eq(Array.from(src), before, 'source channel data is not modified');
  eq(out[0].length, 10, 'output length preserved');
  near(out[0][2], 0.5, 'fade-out first frame');
  near(out[0][3], 0, 'fade-out reaches silence');
  eq([4, 5, 6].map((i) => out[0][i]), [0, 0, 0], 'interior fully muted');
  near(out[0][7], 0.5, 'fade-in last frame');
  eq([0, 1, 8, 9].map((i) => out[0][i]), [1, 1, 1, 1], 'outside the range untouched');

  // 多声道同步处理（区间 [2,8)，包络 2 帧）
  const l = new Float32Array(10).fill(0.8);
  const r = new Float32Array(10).fill(-0.6);
  const stereo = applyMuteToChannelData([l, r], [{ startFrame: 2, endFrame: 8 }], 2);
  eq(stereo.length, 2, 'channel count preserved');
  near(stereo[0][2], 0.4, 'left fades out', 1e-6);
  near(stereo[1][2], -0.3, 'right fades out (sign-independent)', 1e-6);
  eq([stereo[0][4], stereo[1][4]], [0, 0], 'both channels fully muted inside');
  near(stereo[0][7], 0.4, 'left recovers over the fade-in', 1e-6);
  near(stereo[1][7], -0.3, 'right recovers over the fade-in', 1e-6);
  nearArr([stereo[0][0], stereo[1][0], stereo[0][9], stereo[1][9]], [0.8, -0.6, 0.8, -0.6],
    'both channels intact outside the range', 1e-6);

  // NaN 在静音段被写成确定的 0，包络帧也不产生 NaN
  const nan = new Float32Array(6).fill(NaN);
  const cleaned = applyMuteToChannelData([nan], [{ startFrame: 0, endFrame: 6 }], 2);
  ok(cleaned[0].every((v) => !Number.isNaN(v)), 'NaN inside a muted range becomes 0, never NaN');

  // 空合并列表 = 纯拷贝
  const copy = applyMuteToChannelData([src], [], 960);
  eq(Array.from(copy[0]), before, 'no ranges -> identical copy');
  ok(copy[0] !== src, 'no ranges -> still a new array');
}

// ---- processMuteChannelData：整段处理主入口 ----
{
  const rate = 48000;
  const fade = maxFadeFrames(rate); // 960
  const mono = new Float32Array(rate);
  for (let i = 0; i < rate; i++) mono[i] = 0.5;
  const buf = makeBuffer([mono], rate);

  const result = processMuteChannelData(buf, [range('a', 0.25, 0.75)]);
  eq(result.length, rate, 'total frames preserved');
  eq(result.sampleRate, rate, 'sample rate preserved');
  eq(result.numberOfChannels, 1, 'channel count preserved');
  eq(result.channels.length, 1, 'one output channel');
  const out = result.channels[0];
  const s = Math.round(0.25 * rate);
  const e = Math.round(0.75 * rate);
  ok(out.slice(0, s).every((v) => v === 0.5), 'audio before the range untouched');
  ok(out.slice(s + fade, e - fade).every((v) => v === 0), 'interior fully silent');
  ok(out.slice(e).every((v) => v === 0.5), 'audio after the range untouched');
  near(out[s], 0.5 * (1 - 1 / fade), 'fade-out starts at range start', 1e-6);
  eq(out[s + fade - 1], 0, 'fade-out ends at silence');
  eq(out[e - fade], 0, 'fade-in starts from silence');
  near(out[e - 1], 0.5 * ((fade - 1) / fade), 'fade-in recovers within 20ms', 1e-6);
  // 包络宽度恰好 20ms：静音平台两端各 960 帧
  eq(out.slice(s, s + fade).filter((v) => v === 0).length, 1, 'fade-out is exactly 20ms wide');
  eq(out.slice(e - fade, e).filter((v) => v === 0).length, 1, 'fade-in is exactly 20ms wide');

  // 相接区间合并后只有一个包络对（中间不出现恢复再衰减）
  const merged = processMuteChannelData(buf, [range('a', 0.2, 0.4), range('b', 0.4, 0.6)]);
  const m = Math.round(0.4 * rate);
  eq(merged.channels[0][m], 0, 'touching ranges merged: no recovery blip at the seam');

  // 源数据不被修改
  ok(mono.every((v) => v === 0.5), 'source buffer never modified');

  // 空区间列表 -> 内容一致的拷贝
  const passthrough = processMuteChannelData(buf, []);
  eq(Array.from(passthrough.channels[0]), Array.from(mono), 'no ranges -> identical content');

  // 越界区间被裁剪：整段消音（两端各留一对 20ms 包络）
  const all = processMuteChannelData(buf, [range('x', -5, 99)]);
  eq(all.channels[0].filter((v) => v === 0).length, rate - 2 * fade + 2,
    'clipped whole-file range mutes everything except the two 20ms envelopes');

  // 立体声
  const l = new Float32Array(rate).fill(0.25);
  const r = new Float32Array(rate).fill(-0.75);
  const sbuf = makeBuffer([l, r], rate);
  const st = processMuteChannelData(sbuf, [range('a', 0.5, 0.6)]);
  eq(st.numberOfChannels, 2, 'stereo channel count preserved');
  const mid = Math.round(0.55 * rate);
  eq([st.channels[0][mid], st.channels[1][mid]], [0, 0], 'both channels muted at the same frames');
  eq([st.channels[0][0], st.channels[1][0]], [0.25, -0.75], 'both channels intact outside');

  throws(() => processMuteChannelData(makeBuffer([new Float32Array(0)], rate), []), '无效', 'empty buffer throws');
  throws(
    () =>
      processMuteChannelData(
        { duration: 1, length: 10, sampleRate: rate, numberOfChannels: 0, getChannelData: () => new Float32Array(0) },
        [],
      ),
    '声道',
    'no channels throws',
  );
}

// ---- 不变量扫描：任意区间组合下增益都在 [0,1]、静音段确定为 0、长度不变 ----
{
  const rate = 100; // 小采样率便于穷举；20ms -> 2 帧包络
  const src = new Float32Array(rate).map((_, i) => Math.sin(i) * 0.9);
  const buf = makeBuffer([src], rate);
  let allOk = true;
  const cases: MuteRange[][] = [
    [],
    [range('a', 0, 1)],
    [range('a', -1, 0.1), range('b', 0.09, 0.2), range('c', 0.5, 0.5005), range('d', 0.9, 10)],
    [range('a', 0.3, 0.3)], // 零长度
    [range('a', 0.3, 0.3001)], // 亚帧区间
    [range('a', 0.1, 0.9), range('b', 0.2, 0.8), range('c', 0.4, 0.6)],
  ];
  for (const ranges of cases) {
    const res = processMuteChannelData(buf, ranges);
    if (res.length !== rate) allOk = false;
    const out = res.channels[0];
    const merged = buildMuteFrameRanges(ranges, buf);
    for (let i = 0; i < rate; i++) {
      if (!Number.isFinite(out[i])) allOk = false;
      const inside = merged.some((m) => {
        const f = maxFadeFrames(rate);
        const n = m.endFrame - m.startFrame;
        const lo = n <= 2 * f ? m.startFrame + Math.ceil(n / 2) : m.startFrame + f;
        const hi = n <= 2 * f ? m.startFrame + Math.floor(n / 2) : m.endFrame - f;
        return i >= lo && i < hi;
      });
      if (inside && out[i] !== 0) allOk = false; // 静音平台必须严格为 0
      if (!merged.some((m) => i >= m.startFrame && i < m.endFrame) && out[i] !== src[i]) {
        allOk = false; // 区间外逐采样不变
      }
    }
  }
  ok(allOk, 'invariants hold: length kept, silent plateaus exactly 0, outside samples bit-identical');
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log('all mute tests passed');
}
