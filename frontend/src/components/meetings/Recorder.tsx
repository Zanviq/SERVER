import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Mic, Square, Upload } from "lucide-react";
import { Modal } from "../ui/Modal";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 이미 있는 카테고리(자동완성) */
  categories: string[];
  /** 녹음 파일과 함께 제목·카테고리·날짜를 넘긴다. 올리기가 끝날 때까지 기다린다. */
  onSave: (file: File, meta: { title: string; category: string; day: string }) => Promise<void>;
}

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 브라우저가 낼 수 있는 형식 중 서버가 받는 것. 크롬·파이어폭스는 webm/opus, 사파리는 mp4. */
function pickMime(): { mime: string; ext: string } {
  const cands: [string, string][] = [
    ["audio/webm;codecs=opus", "webm"],
    ["audio/webm", "webm"],
    ["audio/mp4", "m4a"],
    ["audio/ogg;codecs=opus", "ogg"],
  ];
  for (const [mime, ext] of cands) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return { mime: "", ext: "webm" };
}

const fmt = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

type Phase = "idle" | "recording" | "done";

/**
 * 마이크를 못 잡은 이유를 사람 말로. 이유마다 할 일이 달라서 뭉뚱그리면 안 된다
 * — "권한을 확인하세요"만 띄우면 사실은 http 로 들어와서 팝업조차 안 뜬 경우에
 * 사용자가 설정만 뒤지게 된다.
 */
function micProblem(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "브라우저가 마이크를 막았습니다. 주소창 왼쪽의 자물쇠(또는 ⓘ) → 사이트 설정에서 "
      + "마이크를 '허용'으로 바꾼 뒤 다시 눌러 주세요.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "마이크를 찾지 못했습니다. 마이크가 연결돼 있는지 확인하세요.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "다른 프로그램이 마이크를 쓰고 있어 열지 못했습니다. 그 프로그램을 닫고 다시 시도하세요.";
  }
  return "마이크를 열지 못했습니다. 파일 올리기로 녹음본을 올릴 수 있습니다.";
}

/**
 * 마이크로 회의를 녹음해 올린다. 멈추면 들어 본 뒤 저장할 수 있고,
 * 저장하면 서버가 뒤에서 받아쓰기·요약을 만든다.
 */
export function Recorder({ open, onClose, categories, onSave }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [day, setDay] = useState(today);
  const [elapsed, setElapsed] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [saving, setSaving] = useState(false);
  // 마이크 문제는 토스트로 흘려보내지 않는다 — 창 안에 남아 있어야 고칠 수 있다
  const [problem, setProblem] = useState("");
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef(0);
  const extRef = useRef("webm");
  const previewUrl = useRef("");

  const stopStream = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  /** 녹음 중이거나 아직 안 올린 녹음이 있으면 되묻고 닫는다.
   *
   *  이 창은 Esc·바깥 클릭으로도 닫힌다. 40분짜리 회의를 녹음하는 중에 그렇게
   *  닫히면 소리는 브라우저 메모리에만 있었으므로 통째로 사라진다. */
  const guardedClose = () => {
    const risky = phase === "recording" || (phase === "done" && !!blob && !saving);
    if (risky && !confirm(
      phase === "recording"
        ? "녹음 중입니다. 닫으면 지금까지 녹음한 소리가 사라집니다. 닫을까요?"
        : "아직 올리지 않은 녹음이 있습니다. 닫으면 사라집니다. 닫을까요?",
    )) return;
    onClose();
  };

  // 탭을 닫으려 하면 브라우저가 되묻는다(창 안 확인만으로는 못 막는다).
  useEffect(() => {
    if (!open || (phase !== "recording" && !blob)) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [open, phase, blob]);

  // 닫히면 모두 되돌린다 — 마이크는 반드시 놓아야 한다(브라우저 탭에 빨간 점이 남는다)
  useEffect(() => {
    if (open) return;
    window.clearInterval(timer.current);
    if (rec.current && rec.current.state !== "inactive") rec.current.stop();
    rec.current = null;
    stopStream();
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = "";
    setPhase("idle");
    setBlob(null);
    setElapsed(0);
    setTitle("");
    setSaving(false);
    setProblem("");
  }, [open]);
  useEffect(() => () => { stopStream(); window.clearInterval(timer.current); }, []);

  const start = async () => {
    setProblem("");
    // 브라우저는 **보안 컨텍스트**(https 또는 localhost)에서만 마이크를 준다.
    // LAN 의 http 주소로 들어오면 navigator.mediaDevices 자체가 없어서, 권한
    // 팝업이 뜰 기회조차 없다 — 그 사실을 그대로 알려 준다.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setProblem(
        window.isSecureContext
          ? "이 브라우저는 녹음을 지원하지 않습니다. 파일 올리기를 쓰세요."
          : `녹음은 https 주소에서만 됩니다(지금은 ${window.location.protocol}//${window.location.host}). `
            + "도메인 주소로 접속하거나, 녹음 파일을 '올리기'로 올려 주세요.",
      );
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setProblem("이 브라우저는 녹음을 지원하지 않습니다. 파일 올리기를 쓰세요.");
      return;
    }
    try {
      // 여기서 브라우저 권한 팝업이 뜬다(처음 한 번). 거부됐거나 서버가
      // Permissions-Policy 로 막아 두면 팝업 없이 NotAllowedError 로 온다.
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setProblem(micProblem(e));
      return;
    }
    const { mime, ext } = pickMime();
    extRef.current = ext;
    const r = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
    r.onstop = () => {
      const b = new Blob(chunks.current, { type: r.mimeType || mime || "audio/webm" });
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = URL.createObjectURL(b);
      setBlob(b);
      setPhase("done");
      stopStream();
    };
    rec.current = r;
    r.start(1000); // 1초마다 조각을 받아 둔다 — 탭이 죽어도 그때까지는 남는다
    setElapsed(0);
    setPhase("recording");
    const t0 = Date.now();
    timer.current = window.setInterval(() => setElapsed((Date.now() - t0) / 1000), 500);
  };

  const stop = () => {
    window.clearInterval(timer.current);
    if (rec.current && rec.current.state !== "inactive") rec.current.stop();
  };

  const save = async () => {
    if (!blob) return;
    setSaving(true);
    try {
      const file = new File([blob], `recording.${extRef.current}`, { type: blob.type });
      await onSave(file, { title: title.trim(), category: category.trim(), day });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={guardedClose} title="회의 녹음" width="max-w-md">
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="label">제목</span>
            <input className="input mt-1" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder={`${day} 회의`} />
          </label>
          <label className="block">
            <span className="label">카테고리</span>
            <input className="input mt-1" value={category} onChange={(e) => setCategory(e.target.value)}
              placeholder="예: 팀 회의" list="meeting-categories" />
            <datalist id="meeting-categories">
              {categories.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
          <label className="block">
            <span className="label">날짜</span>
            <input type="date" className="input mt-1" value={day} onChange={(e) => setDay(e.target.value)} />
          </label>
        </div>

        <div className="flex flex-col items-center gap-3 rounded-lg border border-line bg-subtle p-4">
          <div className={`font-mono text-2xl tabular-nums ${phase === "recording" ? "text-danger" : "text-fg"}`}>
            {fmt(elapsed)}
          </div>
          {phase === "idle" && (
            <button type="button" onClick={start} className="btn btn-primary gap-2">
              <Mic size={16} /> {problem ? "다시 시도" : "녹음 시작"}
            </button>
          )}
          {problem && phase === "idle" && (
            <p className="flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-left text-[12px] text-warning">
              <AlertTriangle size={13} className="mt-[2px] shrink-0" /> <span>{problem}</span>
            </p>
          )}
          {phase === "recording" && (
            <button type="button" onClick={stop} className="btn btn-danger gap-2">
              <Square size={14} /> 멈추기
            </button>
          )}
          {phase === "done" && blob && (
            <>
              <audio controls src={previewUrl.current} className="w-full" />
              <div className="flex gap-2">
                <button type="button" onClick={() => { setBlob(null); setPhase("idle"); setElapsed(0); }}
                  className="btn btn-secondary" disabled={saving}>
                  다시 녹음
                </button>
                <button type="button" onClick={save} className="btn btn-primary gap-2" disabled={saving}>
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  {saving ? "올리는 중…" : "저장하고 받아쓰기"}
                </button>
              </div>
            </>
          )}
          <p className="text-center text-[11.5px] text-fg-subtle">
            {phase === "recording"
              ? "녹음 중입니다. 멈추면 들어 본 뒤 저장할 수 있습니다."
              : "저장하면 AI가 화자를 나눠 받아쓰고 요약합니다."}
          </p>
        </div>
      </div>
    </Modal>
  );
}
