import { ReactNode, useEffect, useState } from "react";
import { User, Bot, CalendarDays, NotebookPen, Palette, Info, Loader2, RefreshCw, FolderSync } from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { ThemeToggle } from "../components/layout/ThemeToggle";
import { useAuth } from "../store/auth";
import { useSettings } from "../store/settings";
import { toast } from "../store/toast";
import { GCAL_COLORS, GCAL_COLOR_NAMES } from "../components/calendar/EventDialog";

const TABS = [
  { id: "account", label: "계정", icon: User },
  { id: "ai", label: "AI", icon: Bot },
  { id: "calendar", label: "캘린더", icon: CalendarDays },
  { id: "notes", label: "노트", icon: NotebookPen },
  { id: "sync", label: "로컬 연동", icon: FolderSync },
  { id: "theme", label: "테마", icon: Palette },
  { id: "about", label: "정보", icon: Info },
];

function Row({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line py-3">
      <div className="min-w-0">
        <p className="text-[13.5px] font-medium">{label}</p>
        {desc && <p className="text-[12px] text-fg-muted">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Settings() {
  const { session, logout } = useAuth();
  const { settings: s, loaded, error, load, patch } = useSettings();
  const [tab, setTab] = useState("account");
  const [aiRules, setAiRules] = useState("");

  useEffect(() => {
    if (!s) load();
  }, [s, load]);

  // AI 규칙 텍스트는 로컬 상태로 두고 blur 때 저장(키 입력마다 저장 방지)
  useEffect(() => {
    if (s) setAiRules(s.calendar.ai_rules ?? "");
  }, [s?.calendar.ai_rules]);

  const update = async (changes: Record<string, unknown>) => {
    try {
      await patch(changes);
      toast.ok("설정 저장됨");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "저장 실패");
    }
  };

  if (!s) {
    return (
      <Shell title="설정">
        {loaded && error ? (
          <div className="flex h-40 flex-col items-center justify-center gap-3 text-fg-muted">
            <p className="text-[13px]">설정을 불러오지 못했습니다.</p>
            <button onClick={() => load()} className="btn btn-secondary">
              <RefreshCw size={14} /> 다시 시도
            </button>
          </div>
        ) : (
          <div className="flex h-40 items-center justify-center text-fg-muted">
            <Loader2 className="animate-spin" />
          </div>
        )}
      </Shell>
    );
  }

  return (
    <Shell title="설정">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[180px_1fr]">
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-left text-[13.5px] font-medium transition-colors ${
                tab === t.id ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:bg-hovered hover:text-fg"
              }`}
            >
              <t.icon size={15} /> {t.label}
            </button>
          ))}
        </nav>

        <div className="card p-5">
          {tab === "account" && (
            <div>
              <Row label="아이디">{session?.username}</Row>
              <Row label="표시 이름">{session?.display_name}</Row>
              <Row label="세션" desc="1시간 후 자동 로그아웃">
                <button onClick={logout} className="btn btn-danger">로그아웃</button>
              </Row>
            </div>
          )}

          {tab === "ai" && (
            <div>
              <Row label="응답 말투" desc="AI 비서의 어조">
                <select className="input w-40" value={s.ai.tone}
                  onChange={(e) => update({ ai: { tone: e.target.value } })}>
                  <option value="counselor">따뜻한 상담사</option>
                  <option value="assistant">담백한 비서</option>
                  <option value="friend">친근한 친구</option>
                </select>
              </Row>
              <Row label="최대 추론 단계" desc="ReAct 1턴당 스킬 실행 한도 (1~16)">
                <input type="number" min={1} max={16} className="input w-24" value={s.ai.max_steps}
                  onChange={(e) => update({ ai: { max_steps: Math.max(1, Math.min(16, +e.target.value)) } })} />
              </Row>
            </div>
          )}

          {tab === "calendar" && (
            <div>
              <Row label="기본 뷰">
                <select className="input w-32" value={s.calendar.default_view}
                  onChange={(e) => update({ calendar: { default_view: e.target.value } })}>
                  <option value="dayGridMonth">월</option>
                  <option value="timeGridWeek">주</option>
                  <option value="timeGridDay">일</option>
                </select>
              </Row>
              <Row label="기본 색상" desc="AI·수동 일정 기본 색">
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(GCAL_COLORS).map(([id, hex]) => (
                    <button key={id} onClick={() => update({ calendar: { default_color: id } })}
                      aria-label={GCAL_COLOR_NAMES[id]} title={GCAL_COLOR_NAMES[id]} aria-pressed={s.calendar.default_color === id}
                      className={`h-6 w-6 rounded-full border-2 ${s.calendar.default_color === id ? "border-fg" : "border-transparent"}`}
                      style={{ background: hex }} />
                  ))}
                </div>
              </Row>
              <Row label="주 시작 요일">
                <select className="input w-28" value={s.calendar.week_start}
                  onChange={(e) => update({ calendar: { week_start: +e.target.value } })}>
                  <option value={0}>일요일</option>
                  <option value={1}>월요일</option>
                </select>
              </Row>
              <Row label="AI 기본 알림" desc="AI가 만든 일정의 기본 알림(직접 요청 시 우선)">
                <select className="input w-28" value={s.calendar.default_remind}
                  onChange={(e) => update({ calendar: { default_remind: +e.target.value } })}>
                  <option value={0}>없음</option>
                  <option value={10}>10분 전</option>
                  <option value={30}>30분 전</option>
                  <option value={60}>1시간 전</option>
                  <option value={1440}>1일 전</option>
                </select>
              </Row>
              <div className="py-3">
                <p className="text-[13.5px] font-medium">AI 캘린더 규칙</p>
                <p className="mb-2 text-[12px] text-fg-muted">
                  AI가 일정을 만들 때 <b>항상</b> 지킬 규칙 (예: “동아리는 보라색으로, 운동은 초록색으로”)
                </p>
                <textarea
                  className="input h-auto w-full py-2 leading-relaxed"
                  rows={3}
                  value={aiRules}
                  placeholder="예) 동아리 일정은 보라색. 시험은 빨간색으로."
                  onChange={(e) => setAiRules(e.target.value)}
                  onBlur={() => {
                    if (aiRules !== (s.calendar.ai_rules ?? "")) update({ calendar: { ai_rules: aiRules } });
                  }}
                />
              </div>
            </div>
          )}

          {tab === "notes" && (
            <div>
              <Row label="기본 노트 공간">
                <select className="input w-32" value={s.notes.default_scope}
                  onChange={(e) => update({ notes: { default_scope: e.target.value } })}>
                  <option value="me">내 노트</option>
                  <option value="common">공통</option>
                </select>
              </Row>
              <Row label="자동 저장 지연" desc="입력 후 저장까지 (ms)">
                <input type="number" min={300} max={5000} step={100} className="input w-24" value={s.notes.autosave_ms}
                  onChange={(e) => update({ notes: { autosave_ms: Math.max(300, Math.min(5000, +e.target.value)) } })} />
              </Row>
            </div>
          )}

          {tab === "sync" && (
            <div>
              <Row label="텍스트 충돌 처리" desc="로컬·웹 둘 다 수정된 .md/.txt 등">
                <select className="input w-40" value={s.sync.text_conflict}
                  onChange={(e) => update({ sync: { text_conflict: e.target.value } })}>
                  <option value="ask">매번 물어보기</option>
                  <option value="local">로컬 우선</option>
                  <option value="web">웹 우선</option>
                  <option value="merge">자동 병합</option>
                </select>
              </Row>
              <Row label="바이너리 충돌 처리" desc=".pdf/.png 등 확인 불가 파일">
                <select className="input w-32" value={s.sync.binary_policy}
                  onChange={(e) => update({ sync: { binary_policy: e.target.value } })}>
                  <option value="local">로컬 우선</option>
                  <option value="web">웹 우선</option>
                </select>
              </Row>
              <p className="pt-3 text-[12px] text-fg-muted">
                연동은 <b>로컬 연동</b> 페이지에서 폴더를 선택해 시작합니다. PC 크롬/엣지 전용.
              </p>
            </div>
          )}

          {tab === "theme" && (
            <div>
              <Row label="테마 모드" desc="라이트 / 다크 / 시스템">
                <ThemeToggle />
              </Row>
              <Row label="타이머 초 표시" desc="세션 남은시간에 초 표시">
                <input type="checkbox" checked={s.display.show_seconds_in_timer}
                  onChange={(e) => update({ display: { show_seconds_in_timer: e.target.checked } })} />
              </Row>
            </div>
          )}

          {tab === "about" && (
            <div className="space-y-1 text-[13px] text-fg2">
              <Row label="버전">v0.2.0</Row>
              <Row label="인증">.env 계정 · 세션 1시간</Row>
              <Row label="AI">Google Gemini (ReAct)</Row>
              <Row label="저장">공통 + 개인 폴더 (HDD)</Row>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
