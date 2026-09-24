import { useEffect, useState } from 'react';
import type { MuteRange } from '../audio/mute';
import { formatTime } from '../utils/time';

interface MutePanelProps {
  ranges: MuteRange[];
  duration: number;
  playhead: number;
  /** 处理结果与当前标记同步（可直接下载） */
  processedReady: boolean;
  /** 已处理结果摘要（仅 processedReady 时有值） */
  processedInfo: { segments: number; mutedSeconds: number } | null;
  previewing: boolean;
  /** 载入新音频时变化，用于清空草稿输入 */
  resetKey: string | null;
  onAdd: (start: number, end: number) => void;
  onUpdate: (id: string, start: number, end: number) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onPreview: () => void;
  onStopPreview: () => void;
  onDownload: () => void;
  onError: (msg: string) => void;
}

/** 解析秒数输入；空串 / 非有限值返回 null。 */
function parseSec(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** 校验区间；合法返回 null，否则返回错误提示。 */
function validateRange(start: number | null, end: number | null, duration: number): string | null {
  if (start === null || end === null) return '请输入有效的起止秒数。';
  if (start < 0) return '起点不能为负。';
  if (end > duration) return `终点不能超出音频时长（${duration.toFixed(2)}s）。`;
  if (start >= end) return '起点必须小于终点。';
  return null;
}

function fmtSec(v: number): string {
  return v.toFixed(3);
}

interface MuteRangeRowProps {
  range: MuteRange;
  index: number;
  duration: number;
  onUpdate: (id: string, start: number, end: number) => void;
  onRemove: (id: string) => void;
  onError: (msg: string) => void;
}

/** 单个消音区间：秒数可直接修订（失焦 / 回车提交，非法输入回退并提示）。 */
function MuteRangeRow({ range, index, duration, onUpdate, onRemove, onError }: MuteRangeRowProps) {
  const [startText, setStartText] = useState(fmtSec(range.start));
  const [endText, setEndText] = useState(fmtSec(range.end));
  // 提交后外部值规范化时同步本地输入
  useEffect(() => {
    setStartText(fmtSec(range.start));
    setEndText(fmtSec(range.end));
  }, [range.start, range.end]);

  const commit = () => {
    const s = parseSec(startText);
    const e = parseSec(endText);
    const err = validateRange(s, e, duration);
    if (err) {
      onError(err);
      setStartText(fmtSec(range.start));
      setEndText(fmtSec(range.end));
      return;
    }
    if (s === range.start && e === range.end) return;
    onUpdate(range.id, s!, e!);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  };

  return (
    <li className="mute-range-row">
      <span className="mute-idx">{index + 1}</span>
      <input
        type="number"
        min={0}
        step={0.01}
        value={startText}
        title="起点（秒）"
        onChange={(e) => setStartText(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
      />
      <span className="mute-sep">~</span>
      <input
        type="number"
        min={0}
        step={0.01}
        value={endText}
        title="终点（秒）"
        onChange={(e) => setEndText(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
      />
      <span className="mute-dur">{(range.end - range.start).toFixed(2)}s</span>
      <button className="mute-del danger" title="删除该消音区间" onClick={() => onRemove(range.id)}>
        ✕
      </button>
    </li>
  );
}

/**
 * 敏感片段消音面板：用播放头标记起止点（或直接输入秒数）维护多个消音区间；
 * 「处理并试听」把区间裁剪到音频范围、合并重叠 / 相接区间并以 ≤20ms 包络
 * 消音后从头播放；「下载处理后 WAV」导出与试听相同的处理结果。
 */
export function MutePanel(props: MutePanelProps) {
  const { ranges, duration, playhead, processedReady, processedInfo, previewing, resetKey } = props;
  const [draftStart, setDraftStart] = useState('');
  const [draftEnd, setDraftEnd] = useState('');
  // 载入新音频时清空草稿（标记区间本身由 App 一并清空）
  useEffect(() => {
    setDraftStart('');
    setDraftEnd('');
  }, [resetKey]);

  const add = () => {
    const s = parseSec(draftStart);
    const e = parseSec(draftEnd);
    const err = validateRange(s, e, duration);
    if (err) {
      props.onError(err);
      return;
    }
    props.onAdd(s!, e!);
    setDraftStart('');
    setDraftEnd('');
  };

  const draftReady = draftStart.trim() !== '' && draftEnd.trim() !== '';

  return (
    <section className="silence-panel mute-panel">
      <h2>敏感片段消音</h2>
      <div className="mute-draft-times">
        <input
          type="number"
          min={0}
          step={0.01}
          placeholder="起点(s)"
          value={draftStart}
          title="新区间起点（秒）"
          onChange={(e) => setDraftStart(e.target.value)}
        />
        <span className="mute-sep">~</span>
        <input
          type="number"
          min={0}
          step={0.01}
          placeholder="终点(s)"
          value={draftEnd}
          title="新区间终点（秒）"
          onChange={(e) => setDraftEnd(e.target.value)}
        />
      </div>
      <div className="mute-draft-buttons">
        <button onClick={() => setDraftStart(fmtSec(playhead))} title={`取当前播放头（${formatTime(playhead)}）为起点`}>
          标记起点
        </button>
        <button onClick={() => setDraftEnd(fmtSec(playhead))} title={`取当前播放头（${formatTime(playhead)}）为终点`}>
          标记终点
        </button>
        <button className="primary" disabled={!draftReady} onClick={add}>
          添加区间
        </button>
      </div>
      {ranges.length > 0 ? (
        <ul className="mute-range-list">
          {ranges.map((r, i) => (
            <MuteRangeRow
              key={r.id}
              range={r}
              index={i}
              duration={duration}
              onUpdate={props.onUpdate}
              onRemove={props.onRemove}
              onError={props.onError}
            />
          ))}
        </ul>
      ) : (
        <div className="silence-info">
          播放头走到敏感处点「标记起点 / 标记终点」，或直接输入秒数；可添加多个区间，逐个删除。
        </div>
      )}
      <div className="mute-actions">
        <button
          className="primary"
          disabled={ranges.length === 0}
          onClick={props.onPreview}
          title="裁剪到音频范围、合并重叠 / 相接区间，起止各加 ≤20ms 包络后从头试听"
        >
          {previewing ? '重新处理并试听' : '处理并试听'}
        </button>
        {previewing && <button onClick={props.onStopPreview}>停止试听</button>}
        <button
          disabled={!processedReady}
          onClick={props.onDownload}
          title={processedReady ? '下载与试听相同的处理结果（完整音频，16-bit PCM WAV）' : '请先「处理并试听」生成处理结果'}
        >
          下载处理后 WAV
        </button>
        {ranges.length > 0 && (
          <button className="danger" onClick={props.onClear}>
            清空标记
          </button>
        )}
      </div>
      <div className="silence-info">
        {processedReady && processedInfo
          ? `已处理：${processedInfo.segments} 个消音段 · 共 ${processedInfo.mutedSeconds.toFixed(2)}s · 起止包络 ≤20ms；下载与试听为同一结果。`
          : ranges.length > 0
            ? `共 ${ranges.length} 个标记区间；处理时裁剪到音频范围并合并重叠 / 相接区间，修改标记后需重新处理。`
            : '处理保持总时长、声道数与采样率不变；原始音频与章节导出不受影响。'}
      </div>
    </section>
  );
}
