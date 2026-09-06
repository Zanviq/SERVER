import { useCallback, useEffect, useRef, useState } from "react";
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
 * "소리가 안 들어왔다"고 볼 최대 진폭(0~1).
 *
 * 실제로 문제가 된 녹음은 **정확히 0** 이었다 — 30초짜리 파일을 ffmpeg 로 재어
 * 보니 max_volume 이 −91.0 dB(=전 구간 0)였고, 모델도 "the audio is silent" 이라
 * 답했다. 조용한 방의 잡음도 이 값보다는 훨씬 크므로, 여기 걸리는 것은 사실상
 * 마이크가 막혀 있는 경우뿐이다. 그래도 **막지는 않는다**(경고만).
 */
const SILENT_PEAK = 0.002;

/** 마이크 권한 응답을 이만큼 기다린다. 넘으면 무엇을 볼지 알려 준다. */
const MIC_WAIT_MS = 12000;

/** getUserMedia 가 끝내 답하지 않았다는 표시(거부와는 할 일이 다르다). */
class MicTimeout extends Error {}

/** 약속이 제때 끝나지 않으면 던진다.
 *
 *  브라우저가 권한 팝업의 답을 영영 주지 않는 경우가 있다(사용자가 고르지 않고
 *  놔두거나, 웹뷰가 해결도 거부도 하지 않는다). 그때 `await` 는 그대로 멈춰
 *  있어서 화면에는 **아무 일도 일어나지 않는다** — 단추가 고장 난 것처럼 보인다. */
function withTimeout(p: Promise<MediaStream>, ms: number): Promise<MediaStream> {
  let settled = false;
  return new Promise<MediaStream>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new MicTimeout());
    }, ms);
    p.then(
      (s) => {
        clearTimeout(timer);
        // 포기한 뒤에 늦게 도착하면 **마이크를 놓아 준다.** 그러지 않으면 쓰지도
        // 않는 스트림이 열린 채 남아 탭의 빨간 점이 계속 켜져 있다.
        if (settled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        settled = true;
        resolve(s);
      },
      (e) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(e);
      },
    );
  });
}

/** 소리가 안 들어올 때 실제로 확인해야 하는 것들. 브라우저 설정만 가리키면
 *  안 된다 — 권한은 이미 났는데 OS 쪽에서 막혀 무음이 녹음된 것이기 때문이다. */
const SILENT_HELP = [
  "Windows: 설정 → 개인 정보 및 보안 → 마이크에서 '데스크톱 앱이 마이크에 액세스하도록 허용'이 켜져 있는지",
  "소리 설정 → 입력에서 쓰려는 마이크가 음소거(또는 볼륨 0)가 아닌지",
  "아래 목록에서 다른 마이크를 고른 뒤 다시 녹음해 보세요",
];

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
 *
 * 녹음 중에는 **들어오는 소리의 세기를 막대로 보여 준다.** 예전에는 시간만
 * 흘렀기 때문에, 마이크가 막혀 무음이 들어오는 중이어도 40분을 다 녹음한 뒤
 * 받아쓰기가 실패하고 나서야 알 수 있었다(실측: 30초 전 구간이 정확히 0).
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
  //: 권한 팝업의 답을 기다리는 중. 누른 순간 화면이 반응해야 한다 — 이게 없으면
  //: 팝업이 뜨는 몇 초 동안 단추를 눌러도 아무 일이 없는 것처럼 보인다.
  const [asking, setAsking] = useState(false);
  //: 지금 들어오는 소리의 세기(0~1). 막대 하나로 보여 준다.
  const [level, setLevel] = useState(0);
  //: 녹음이 끝난 뒤 "한 번도 소리가 안 들어왔다"가 확정됐는가
  const [silent, setSilent] = useState(false);
  //: 고를 수 있는 마이크. 이름은 권한이 난 뒤에만 채워진다(브라우저 규칙).
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  //: 실제로 잡힌 마이크 이름 — 엉뚱한 장치가 기본값인 경우가 잦다
  const [micLabel, setMicLabel] = useState("");

  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef(0);
  const extRef = useRef("webm");
  const previewUrl = useRef("");
  //: 녹음 전체에서 가장 컸던 진폭. 무음 판정의 근거다.
  const peak = useRef(0);
  const audioCtx = useRef<AudioContext | null>(null);
  const meterTimer = useRef(0);
  const audioEl = useRef<HTMLAudioElement>(null);

  /** 이름이 붙은 마이크 목록. 권한이 없으면 이름이 빈 문자열로 와서 고를 수 없다. */
  const loadDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "audioinput" && d.label));
    } catch {
      /* 목록을 못 받아도 녹음 자체는 된다 */
    }
  }, []);

  const stopMeter = () => {
    window.clearInterval(meterTimer.current);
    meterTimer.current = 0;
    audioCtx.current?.close().catch(() => {});
    audioCtx.current = null;
    setLevel(0);
  };

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

  // 열리면 고를 수 있는 마이크를 미리 훑는다(전에 권한을 준 적이 있으면 이름이 온다).
  useEffect(() => {
    if (open) void loadDevices();
  }, [open, loadDevices]);

  // 닫히면 모두 되돌린다 — 마이크는 반드시 놓아야 한다(브라우저 탭에 빨간 점이 남는다)
  useEffect(() => {
    if (open) return;
    window.clearInterval(timer.current);
    if (rec.current && rec.current.state !== "inactive") rec.current.stop();
    rec.current = null;
    stopMeter();
    stopStream();
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = "";
    setPhase("idle");
    setBlob(null);
    setElapsed(0);
    setTitle("");
    setSaving(false);
    setProblem("");
    setAsking(false);
    setSilent(false);
    setMicLabel("");
    peak.current = 0;
  }, [open]);
  useEffect(() => () => { stopMeter(); stopStream(); window.clearInterval(timer.current); }, []);

  /** 들어오는 소리를 재는 눈금. 녹음 자체와는 따로 도는 길이다(스피커로 내보내지
   *  않으므로 되울림은 없다). */
  const startMeter = (src: MediaStream) => {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // 눈금이 없어도 녹음은 되게 둔다
    try {
      const ctx = new Ctor();
      void ctx.resume();
      const node = ctx.createMediaStreamSource(src);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      node.connect(analyser);
      audioCtx.current = ctx;
      const buf = new Float32Array(analyser.fftSize);
      // requestAnimationFrame 이 아니라 setInterval 이다 — rAF 는 다른 탭을 보고
      // 있으면 아예 멈춘다. 그러면 "소리가 안 들어왔다"가 거짓으로 뜬다.
      meterTimer.current = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let m = 0;
        for (let i = 0; i < buf.length; i++) {
          const a = Math.abs(buf[i]);
          if (a > m) m = a;
        }
        if (m > peak.current) peak.current = m;
        setLevel(m);
      }, 100);
    } catch {
      /* 눈금을 못 만들어도 녹음은 계속한다 */
    }
  };

  const start = async () => {
    setProblem("");
    setSilent(false);
    peak.current = 0;
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
    setAsking(true);
    try {
      // 여기서 브라우저 권한 팝업이 뜬다(처음 한 번). 거부됐거나 서버가
      // Permissions-Policy 로 막아 두면 팝업 없이 NotAllowedError 로 온다.
      //
      // **답이 영영 안 오는 경우가 있다.** 사용자가 팝업을 고르지 않고 놔두거나,
      // 어떤 브라우저·웹뷰에서는 약속이 해결도 거부도 되지 않는다(실측: 이 코드가
      // 그대로 멈춰 있었다). 그러면 화면은 "녹음 시작"인 채 아무 일도 안 일어나고,
      // 사용자는 단추가 고장 난 줄 안다. 기다리다 지치면 무엇을 볼지 알려 준다.
      stream.current = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        }),
        MIC_WAIT_MS,
      );
    } catch (e) {
      setProblem(e instanceof MicTimeout
        ? "마이크 권한 응답을 기다리다 멈췄습니다. 주소창에 권한을 묻는 팝업이 떠 "
          + "있는지 확인하고 '허용'을 눌러 주세요. 팝업이 없으면 자물쇠(또는 ⓘ) → "
          + "사이트 설정에서 마이크를 '허용'으로 바꾼 뒤 다시 눌러 주세요."
        : micProblem(e));
      return;
    } finally {
      setAsking(false);
    }
    // 어느 장치가 실제로 잡혔는지 보여 준다. 권한이 난 뒤라야 이름이 온다.
    setMicLabel(stream.current.getAudioTracks()[0]?.label ?? "");
    void loadDevices();
    const { mime, ext } = pickMime();
    extRef.current = ext;
    const r = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
    r.onstop = () => {
      const b = new Blob(chunks.current, { type: r.mimeType || mime || "audio/webm" });
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = URL.createObjectURL(b);
      // 눈금을 먼저 멈춰야 마지막 값이 확정된다
      stopMeter();
      setSilent(peak.current < SILENT_PEAK);
      setBlob(b);
      setPhase("done");
      stopStream();
    };
    rec.current = r;
    startMeter(stream.current);
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

  const retake = () => {
    setBlob(null);
    setPhase("idle");
    setElapsed(0);
    setSilent(false);
    peak.current = 0;
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

  /** MediaRecorder 가 만든 webm 에는 길이가 안 적혀 있어 duration 이 Infinity 로
   *  온다 — 눈금이 0:00 에 붙어 있어 "아무것도 안 녹음됐다"로 보인다. 끝으로 한 번
   *  보냈다 돌아오면 브라우저가 길이를 알아낸다(회의 상세 화면과 같은 처리). */
  const onPreviewMeta = () => {
    const a = audioEl.current;
    if (!a || a.duration !== Infinity) return;
    const back = () => { a.currentTime = 0; a.removeEventListener("timeupdate", back); };
    a.addEventListener("timeupdate", back);
    a.currentTime = 1e101;
  };

  // 녹음 중인데 몇 초가 지나도록 한 번도 소리가 안 들어왔으면 그 자리에서 알린다.
  // 끝나고 알려 주면 이미 회의가 끝난 뒤다.
  const quietSoFar = phase === "recording" && elapsed > 3 && peak.current < SILENT_PEAK;

  const meter = (
    <div className="w-full">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div
          className={`h-full rounded-full transition-[width] duration-100 ${
            quietSoFar ? "bg-warning" : "bg-accent"
          }`}
          // 진폭을 그대로 쓰면 말소리에서도 막대가 거의 안 움직인다(대부분 0.1 아래).
          // 제곱근으로 펴서 눈에 보이게 한다.
          style={{ width: `${Math.min(100, Math.sqrt(level) * 140)}%` }}
        />
      </div>
      <p className="mt-1 text-center text-[11px] text-fg-subtle">
        {micLabel ? `입력: ${micLabel}` : "입력 세기"}
      </p>
    </div>
  );

  const devicePicker = devices.length > 1 && phase !== "recording" && (
    <label className="block w-full">
      <span className="label">마이크</span>
      <select
        className="input mt-1"
        value={deviceId}
        onChange={(e) => setDeviceId(e.target.value)}
        disabled={saving}
      >
        <option value="">기본 마이크</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
        ))}
      </select>
    </label>
  );

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
          {phase === "recording" && meter}
          {phase === "idle" && (
            <>
              {devicePicker}
              {/* 누른 순간 화면이 반응해야 한다. 권한 팝업이 뜨는 몇 초 동안
                  단추가 그대로면 사용자는 눌리지 않은 줄 알고 또 누른다. */}
              <button type="button" onClick={start} disabled={asking}
                className="btn btn-primary gap-2">
                {asking
                  ? <><Loader2 size={16} className="animate-spin" /> 마이크 권한을 기다리는 중…</>
                  : <><Mic size={16} /> {problem || silent ? "다시 시도" : "녹음 시작"}</>}
              </button>
              {asking && (
                <p className="text-[11.5px] text-fg-muted">
                  주소창에 권한을 묻는 팝업이 떴다면 ‘허용’을 눌러 주세요.
                </p>
              )}
            </>
          )}
          {problem && phase === "idle" && (
            <p className="flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-left text-[12px] text-warning">
              <AlertTriangle size={13} className="mt-[2px] shrink-0" /> <span>{problem}</span>
            </p>
          )}
          {quietSoFar && (
            <p className="flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-left text-[12px] text-warning">
              <AlertTriangle size={13} className="mt-[2px] shrink-0" />
              <span>마이크에서 소리가 들어오지 않고 있습니다. 지금 멈추고 마이크를 확인하세요.</span>
            </p>
          )}
          {phase === "recording" && (
            <button type="button" onClick={stop} className="btn btn-danger gap-2">
              <Square size={14} /> 멈추기
            </button>
          )}
          {phase === "done" && blob && (
            <>
              {silent && (
                <div className="w-full rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-left text-[12px] text-warning">
                  <p className="flex items-start gap-1.5 font-medium">
                    <AlertTriangle size={13} className="mt-[2px] shrink-0" />
                    <span>마이크에서 소리가 전혀 들어오지 않았습니다 — 이대로 저장하면 무음만 올라갑니다.</span>
                  </p>
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                    {SILENT_HELP.map((h) => <li key={h}>{h}</li>)}
                  </ul>
                </div>
              )}
              {devicePicker}
              <audio ref={audioEl} controls src={previewUrl.current}
                onLoadedMetadata={onPreviewMeta} className="w-full" />
              <div className="flex gap-2">
                <button type="button" onClick={retake} className="btn btn-secondary" disabled={saving}>
                  다시 녹음
                </button>
                <button type="button" onClick={save}
                  className={`btn gap-2 ${silent ? "btn-secondary" : "btn-primary"}`} disabled={saving}>
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  {saving ? "올리는 중…" : silent ? "그래도 저장" : "저장하고 받아쓰기"}
                </button>
              </div>
            </>
          )}
          <p className="text-center text-[11.5px] text-fg-subtle">
            {phase === "recording"
              ? "녹음 중입니다. 막대가 움직여야 소리가 들어오는 중입니다."
              : "저장하면 AI가 화자를 나눠 받아쓰고 요약합니다."}
          </p>
        </div>
      </div>
    </Modal>
  );
}
