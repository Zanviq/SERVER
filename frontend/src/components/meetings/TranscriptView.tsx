import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, Pencil, RefreshCw } from "lucide-react";
import { api, Meeting, Transcript } from "../../lib/api";
import { toast } from "../../store/toast";

interface Props {
  meeting: Meeting;
  /** 시각을 누르면 플레이어를 그 자리로 옮긴다(초) */
  onSeek: (sec: number) => void;
  onRenameSpeaker: (label: string, name: string) => void;
  onRetry: () => void;
}

const SPEAKER_COLORS = [
  "text-accent-fg bg-accent-muted",
  "text-info bg-info/10",
  "text-positive bg-positive/10",
  "text-warning bg-warning/10",
  "text-danger bg-danger/10",
];

function toSec(stamp: string): number {
  const parts = stamp.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** 원본 받아쓰기 — 화자별 구분, 시각 클릭으로 되감기, 화자 이름 붙이기. */
export function TranscriptView({ meeting, onSeek, onRenameSpeaker, onRetry }: Props) {
  const [tr, setTr] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const ready = meeting.status === "ready";
  useEffect(() => {
    if (!ready) { setTr(null); return; }
    let alive = true;
    setLoading(true);
    api.meetingTranscript(meeting.id)
      .then((t) => { if (alive) setTr(t); })
      .catch((e) => { if (alive) toast.error(e instanceof Error ? e.message : "받아쓰기를 못 받았습니다"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // transcribed_at 이 바뀌면(다시 받아쓰기) 새로 받는다
  }, [meeting.id, ready, meeting.transcribed_at]);

  const labels = useMemo(() => {
    const seen: string[] = [];
    for (const s of tr?.segments ?? []) if (s.speaker && !seen.includes(s.speaker)) seen.push(s.speaker);
    return seen;
  }, [tr]);
  const colorOf = (label: string) => SPEAKER_COLORS[Math.max(0, labels.indexOf(label)) % SPEAKER_COLORS.length];
  const nameOf = (label: string) => meeting.speakers?.[label] || label;

  const commitName = (label: string) => {
    const name = draft.trim();
    setEditing(null);
    if (name !== (meeting.speakers?.[label] || "")) onRenameSpeaker(label, name);
  };

  if (meeting.status === "pending") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-fg-muted">
        <Loader2 size={22} className="animate-spin text-accent" />
        AI가 받아쓰는 중입니다. 긴 녹음은 몇 분 걸릴 수 있어요.
      </div>
    );
  }
  if (meeting.status === "failed") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-fg-muted">
        <AlertCircle size={22} className="text-danger" />
        <p>{meeting.error || "받아쓰기에 실패했습니다."}</p>
        <button type="button" onClick={onRetry} className="btn btn-secondary gap-1"><RefreshCw size={13} /> 다시 받아쓰기</button>
      </div>
    );
  }
  if (loading || !tr) {
    return <div className="flex flex-1 items-center justify-center text-fg-muted"><Loader2 size={18} className="animate-spin" /></div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {(meeting.summary || labels.length > 0) && (
        <div className="shrink-0 space-y-2 border-b border-line px-4 py-3">
          {meeting.summary && <p className="text-[13px] leading-relaxed text-fg2">{meeting.summary}</p>}
          {labels.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-fg-subtle">화자</span>
              {labels.map((label) => (
                editing === label ? (
                  <input key={label} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitName(label)}
                    onKeyDown={(e) => { if (e.key === "Enter") commitName(label); if (e.key === "Escape") setEditing(null); }}
                    placeholder={label} aria-label={`${label} 이름`}
                    className="input h-6 w-28 px-2 text-[11.5px]" />
                ) : (
                  <button key={label} type="button" onClick={() => { setEditing(label); setDraft(meeting.speakers?.[label] || ""); }}
                    title="이름 붙이기" className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] ${colorOf(label)}`}>
                    {nameOf(label)} <Pencil size={10} className="opacity-60" />
                  </button>
                )
              ))}
            </div>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {tr.segments.length === 0 ? (
          <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed">{tr.text}</pre>
        ) : (
          <ol className="space-y-2">
            {tr.segments.map((s, i) => (
              <li key={i} className="flex gap-2 text-[13px] leading-relaxed">
                <button type="button" onClick={() => onSeek(toSec(s.start))} title="여기부터 듣기"
                  className="mt-0.5 shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle hover:text-accent">
                  {s.start || "--:--"}
                </button>
                <div className="min-w-0 flex-1">
                  {s.speaker && (
                    <span className={`mr-1.5 rounded px-1.5 py-px text-[11px] font-medium ${colorOf(s.speaker)}`}>{nameOf(s.speaker)}</span>
                  )}
                  <span>{s.text}</span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
