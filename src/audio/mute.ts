import type { AudioBufferLike } from '../types';

/**
 * 敏感片段消音（纯函数）：把若干「秒」区间裁剪到音频范围、换算为采样帧、
 * 合并重叠或相接的区间，再对合并后的每个区间施加消音包络——起点处至多
 * 20ms 线性衰减到 0，区间内保持静音，终点处至多 20ms 线性恢复到原音量。
 *
 * 处理产出与源音频等长、同声道数、同采样率的新声道数据；源数据不被修改。
 * 帧区间一律为左闭右开 [startFrame, endFrame)。
 */

/** 消音起止包络的最大时长（秒）。 */
export const MAX_MUTE_FADE_SEC = 0.02;

/** 面板中的一个消音标记（秒，未裁剪）。 */
export interface MuteRange {
  id: string;
  start: number;
  end: number;
}

/** 左闭右开帧区间 [startFrame, endFrame)。 */
export interface FrameRange {
  startFrame: number;
  endFrame: number;
}

/** 消音起止各至多 20ms，换算为帧数（至少 1 帧，保证短区间也有包络语义）。 */
export function maxFadeFrames(sampleRate: number): number {
  if (!(sampleRate > 0)) return 1;
  return Math.max(1, Math.round(MAX_MUTE_FADE_SEC * sampleRate));
}

/**
 * 秒区间 → 帧区间：先裁剪到 [0, duration]，再按采样率取整为帧索引并钳到
 * [0, length]。裁剪后为零长度（越界 / 起止重合 / 倒置 / 非有限值）返回 null。
 */
export function muteRangeToFrames(
  start: number,
  end: number,
  buffer: AudioBufferLike,
): FrameRange | null {
  const { length, sampleRate } = buffer;
  if (!(length > 0) || !(sampleRate > 0)) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const duration = length / sampleRate;
  const s = Math.min(Math.max(start, 0), duration);
  const e = Math.min(Math.max(end, 0), duration);
  const startFrame = Math.min(Math.max(Math.round(s * sampleRate), 0), length);
  const endFrame = Math.min(Math.max(Math.round(e * sampleRate), 0), length);
  if (endFrame <= startFrame) return null;
  return { startFrame, endFrame };
}

/**
 * 合并重叠或首尾相接的帧区间（gap <= 0 即合一），返回按起点排序的新数组。
 * 输入不被修改；无效区间（end <= start）被忽略。
 */
export function mergeFrameRanges(ranges: FrameRange[]): FrameRange[] {
  const sorted = ranges
    .filter((r) => r.endFrame > r.startFrame)
    .map((r) => ({ startFrame: r.startFrame, endFrame: r.endFrame }))
    .sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
  const merged: FrameRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.startFrame <= last.endFrame) {
      last.endFrame = Math.max(last.endFrame, r.endFrame);
    } else {
      merged.push(r);
    }
  }
  return merged;
}

/**
 * 消音区间 → 帧区间列表（裁剪 + 合并）。返回按起点排序、互不重叠也不相接
 * 的帧区间；全部区间越界 / 零长度时返回空数组。
 */
export function buildMuteFrameRanges(ranges: MuteRange[], buffer: AudioBufferLike): FrameRange[] {
  const frames: FrameRange[] = [];
  for (const r of ranges) {
    const f = muteRangeToFrames(r.start, r.end, buffer);
    if (f) frames.push(f);
  }
  return mergeFrameRanges(frames);
}

/**
 * 帧 i 在合并后区间 [start, end) 内的消音包络增益（0..1）。
 * 起点侧至多 fadeFrames 帧线性衰减到 0，终点侧至多 fadeFrames 帧线性恢复；
 * 区间短于两侧包络之和时包络等比例压缩、在中点相接（增益最低点为中点，
 * 偶数帧时为 0）；单帧区间直接静音。区间外的帧增益恒为 1。
 */
export function muteEnvelopeGain(i: number, start: number, end: number, fadeFrames: number): number {
  const n = end - start;
  if (n <= 0 || i < start || i >= end) return 1;
  const f = Math.max(0, Math.floor(fadeFrames));
  if (f <= 0) return 0;
  if (n === 1) return 0;
  if (n <= 2 * f) {
    // 包络等比例压缩到中点相接：左半衰减、右半恢复
    const half = n / 2;
    const k = i - start + 1;
    return k <= half ? 1 - k / half : (k - half) / half;
  }
  const k = i - start + 1;
  if (k <= f) return 1 - k / f;
  if (i >= end - f) return (i - (end - f)) / f;
  return 0;
}

/**
 * 把消音包络应用到逐声道数据上，返回新的声道数组（源数组不被修改）。
 * 输出与输入等长；静音段写入确定的 0（源数据中的 NaN 不会泄漏到静音段）。
 */
export function applyMuteToChannelData(
  channels: Float32Array[],
  merged: FrameRange[],
  fadeFrames: number,
): Float32Array[] {
  const out = channels.map((c) => new Float32Array(c));
  if (merged.length === 0) return out;
  const f = Math.max(0, Math.floor(fadeFrames));
  for (const { startFrame, endFrame } of merged) {
    for (const data of out) {
      const end = Math.min(endFrame, data.length);
      for (let i = Math.max(0, startFrame); i < end; i++) {
        const g = muteEnvelopeGain(i, startFrame, endFrame, f);
        if (g === 0) data[i] = 0;
        else if (g !== 1) {
          const v = data[i];
          data[i] = Number.isNaN(v) ? 0 : v * g;
        }
      }
    }
  }
  return out;
}

/**
 * 对类 AudioBuffer 数据做整段消音处理：返回新的声道数据与源参数
 * （采样率 / 声道数 / 帧数原样保留）。区间先裁剪到音频范围再合并。
 */
export function processMuteChannelData(
  buffer: AudioBufferLike,
  ranges: MuteRange[],
): { channels: Float32Array[]; sampleRate: number; numberOfChannels: number; length: number } {
  const numberOfChannels = buffer.numberOfChannels;
  if (!(numberOfChannels >= 1)) throw new Error('音频没有可用声道。');
  if (!(buffer.sampleRate > 0) || !(buffer.length > 0)) throw new Error('音频采样率或长度无效。');
  const src: Float32Array[] = [];
  for (let ch = 0; ch < numberOfChannels; ch++) src.push(buffer.getChannelData(ch));
  const merged = buildMuteFrameRanges(ranges, buffer);
  const channels = applyMuteToChannelData(src, merged, maxFadeFrames(buffer.sampleRate));
  return { channels, sampleRate: buffer.sampleRate, numberOfChannels, length: buffer.length };
}
