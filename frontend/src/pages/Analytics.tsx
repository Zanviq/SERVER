import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, ChevronLeft, Loader2 } from "lucide-react";
import { Shell } from "../components/layout/Shell";
import { api, UsageSummary } from "../lib/api";
import { ListState } from "../components/ui/ListState";
import { toast } from "../store/toast";

/** 화면 이름 → 사람이 읽는 이름. 서버가 접어서 준 라우트만 온다. */
const LABEL: Record<string, string> = {
  "/": "대시보드",
  "/notes": "문서",
  "/graph": "그래프",
  "/calendar": "캘린더",
  "/todo": "할 일",
  "/assistant": "AI 비서",
  "/english": "영어 학습",
  "/papers": "논문",
  "/meetings": "회의",
  "/context": "컨텍스트",
  "/trash": "휴지통",
  "/settings": "설정",
  "/profile": "프로필",
  "/terminal": "터미널",
  "/analytics": "사용량",
  기타: "기타",
};
const label = (r: string) => LABEL[r] ?? r;

/** AI 화면 이름 → 사람이 읽는 이름. 서버가 접어서 준 값만 온다. */
const MODE_LABEL: Record<string, string> = {
  assistant: "AI 비서",
  calendar: "캘린더",
  english: "영어 학습",
  paper: "논문",
  meeting: "회의",
  기타: "기타",
};

const COUNT_LABEL: Record<string, string> = {
  documents: "문서",
  papers: "논문",
  meetings: "회의 녹음",
  // 구글에 연결한 사용자는 일정이 구글에 있어 이 값이 0 이다. 세러 구글까지
  // 다녀오면 사용자 수만큼 API 를 부르게 되므로, 무엇을 센 값인지 이름으로 밝힌다.
  events: "일정(내부 저장)",
  todos: "할 일",
  todo_categories: "할 일 카테고리",
  vocab: "단어",
  diary_days: "기록한 날",
  trash: "휴지통 항목",
};

function hhmm(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}시간 ${m}분`;
  if (m) return `${m}분`;
  return `${s}초`;
}

const num = (n: number) => n.toLocaleString();

/** 글자 수. 1000자가 안 되면 그대로 보여 준다 — 반올림해서 "0K자"가 되면
 *  대화가 12턴 있는데도 아무것도 없는 것처럼 보인다. */
const chars = (n: number) => (n < 1000 ? `${num(n)}자` : `${num(Math.round(n / 1000))}K자`);

function Stat({ label: k, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-3">
      <p className="text-[11.5px] text-fg-muted">{k}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-fg-subtle">{sub}</p>}
    </div>
  );
}

/** 가로 막대 하나. 값은 전부 수치라 폭으로 견주면 바로 읽힌다. */
function Bar({ name, value, max, right }: { name: string; value: number; max: number; right: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="w-20 shrink-0 truncate text-[12px] text-fg2">{name}</span>
      <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-20 shrink-0 text-right text-[11.5px] tabular-nums text-fg-muted">{right}</span>
    </div>
  );
}

/**
 * 사용량 화면 — **수치만** 보여 준다.
 *
 * 다른 사용자를 볼 때도 그 사람이 무엇을 썼는지는 한 글자도 나오지 않는다.
 * 서버가 애초에 내용을 모으지 않고(backend/usage.py), 이 화면은 서버가 준
 * 숫자를 그리기만 한다. 화면 이름조차 앱의 라우트 목록으로 접힌 값이다.
 */
export function Analytics() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const who = params.get("u") ?? "";
  const month = params.get("m") ?? "";

  const [data, setData] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setData(who ? await api.usageUser(who, month) : await api.usageMine(month));
    } catch (e) {
      setFailed(true);
      toast.error(e instanceof Error ? e.message : "사용량을 불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, [who, month]);

  useEffect(() => { void load(); }, [load]);

  const pages = useMemo(
    () => Object.entries(data?.pages ?? {})
      .map(([r, v]) => ({ route: r, ...v }))
      .sort((a, b) => b.seconds - a.seconds),
    [data],
  );
  const maxSecs = pages[0]?.seconds ?? 0;
  const maxMove = data?.moves[0]?.count ?? 0;
  const days = useMemo(() => Object.entries(data?.days ?? {}), [data]);
  const maxDay = days.reduce((m, [, v]) => Math.max(m, v.seconds), 0);
  const modes = useMemo(
    () => Object.entries(data?.tokens.by_mode ?? {}).sort((a, b) => b[1].total - a[1].total),
    [data],
  );
  const maxMode = modes[0]?.[1].total ?? 0;
  const unknownMode = Math.max(
    0, (data?.tokens.total ?? 0) - modes.reduce((sum, [, v]) => sum + v.total, 0));

  return (
    <Shell
      title={who ? `사용량 · ${who}` : "내 사용량"}
      actions={
        <>
          {who && (
            <button onClick={() => navigate("/settings?tab=members")}
              className="btn btn-ghost h-8 gap-1 px-2 text-[12px]">
              <ChevronLeft size={14} /> 계정 관리
            </button>
          )}
          <select
            className="input h-8 w-32 text-[12px]"
            value={data?.month ?? ""}
            onChange={(e) => setParams((p) => {
              const n = new URLSearchParams(p);
              n.set("m", e.target.value);
              return n;
            }, { replace: true })}
          >
            {(data?.months.length ? data.months : [data?.month ?? ""]).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </>
      }
    >
      {loading && !data ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-fg-muted" /></div>
      ) : !data ? (
        <ListState failed={failed} onRetry={() => void load()}>사용량이 없습니다.</ListState>
      ) : (
        <div className="space-y-4">
          {/* 수치라 개인 자료가 아니라는 것을 화면에서도 분명히 해 둔다 */}
          <p className="text-[12px] text-fg-muted">
            {who ? `${who} 님의 ` : ""}수치만 보여 줍니다 · {data.month} 기준 ·
            문서·일정·대화의 <b>내용은 이 화면에 오지 않습니다</b>
          </p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="사용 시간" value={hhmm(data.total_seconds)} sub={`화면 이동 ${num(data.total_views)}회`} />
            <Stat label="AI 토큰" value={num(data.tokens.total)} sub={`호출 ${num(data.tokens.calls)}회`} />
            <Stat label="보낸 토큰" value={num(data.tokens.prompt)} />
            <Stat label="받은 토큰" value={num(data.tokens.output)} />
            <Stat label="대화 공간" value={num(data.context.spaces)} sub={`${num(data.context.turns)}턴`} />
            <Stat label="컨텍스트 양" value={chars(data.context.chars)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card p-4">
              <h2 className="mb-2 text-[13px] font-semibold">화면별 체류 시간</h2>
              {pages.length === 0 ? (
                <p className="py-6 text-center text-[12.5px] text-fg-muted">아직 기록이 없습니다.</p>
              ) : (
                pages.map((p) => (
                  <Bar key={p.route} name={label(p.route)} value={p.seconds} max={maxSecs}
                    right={`${hhmm(p.seconds)} · ${num(p.views)}회`} />
                ))
              )}
            </section>

            <section className="card p-4">
              <h2 className="mb-2 text-[13px] font-semibold">많이 다닌 길</h2>
              <p className="mb-1 text-[11.5px] text-fg-subtle">어느 화면에서 어느 화면으로 옮겼는가</p>
              {data.moves.length === 0 ? (
                <p className="py-6 text-center text-[12.5px] text-fg-muted">아직 기록이 없습니다.</p>
              ) : (
                data.moves.map((m) => (
                  <div key={`${m.from}>${m.to}`} className="flex items-center gap-2 py-1 text-[12px]">
                    <span className="w-20 shrink-0 truncate text-right text-fg2">{label(m.from)}</span>
                    <ArrowRight size={12} className="shrink-0 text-fg-subtle" />
                    <span className="w-20 shrink-0 truncate text-fg2">{label(m.to)}</span>
                    <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-accent"
                        style={{ width: `${maxMove ? Math.max(2, Math.round((m.count / maxMove) * 100)) : 0}%` }} />
                    </span>
                    <span className="w-10 shrink-0 text-right tabular-nums text-fg-muted">{num(m.count)}</span>
                  </div>
                ))
              )}
            </section>

            <section className="card p-4">
              <h2 className="mb-2 text-[13px] font-semibold">가지고 있는 것</h2>
              <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
                {Object.entries(data.counts).map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between border-b border-line/60 py-1.5">
                    <span className="text-[12px] text-fg-muted">{COUNT_LABEL[k] ?? k}</span>
                    <span className="text-[13px] font-medium tabular-nums">{num(v)}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="card p-4">
              <h2 className="mb-2 text-[13px] font-semibold">화면별 AI 토큰</h2>
              <p className="mb-1 text-[11.5px] text-fg-subtle">
                어느 화면이 요금을 쓰는가 · 논문 화면은 PDF 를 함께 실어 같은 질문도 비싸다
              </p>
              {modes.length === 0 ? (
                <p className="py-6 text-center text-[12.5px] text-fg-muted">아직 AI 를 쓰지 않았습니다.</p>
              ) : (
                <>
                  {modes.map(([m, v]) => (
                    <Bar key={m} name={MODE_LABEL[m] ?? m} value={v.total} max={maxMode}
                      right={`${num(v.total)} · ${num(v.calls)}회`} />
                  ))}
                  {/* 화면을 세기 전에 쓴 것은 어느 화면인지 알 수 없다. 막대 합이
                      위의 총합과 안 맞는 것을 그냥 두면 어느 쪽이 틀렸는지 모른다. */}
                  {unknownMode > 0 && (
                    <p className="mt-2 text-[11.5px] text-fg-subtle">
                      화면을 세기 전에 쓴 {num(unknownMode)} 토큰은 어느 화면인지 알 수 없어
                      막대에 없습니다(위 총합에는 들어 있습니다).
                    </p>
                  )}
                </>
              )}
            </section>

            <section className="card p-4">
              <h2 className="mb-2 text-[13px] font-semibold">모델별 토큰</h2>
              {Object.keys(data.tokens.by_model).length === 0 ? (
                <p className="py-6 text-center text-[12.5px] text-fg-muted">아직 AI 를 쓰지 않았습니다.</p>
              ) : (
                Object.entries(data.tokens.by_model)
                  .sort((a, b) => b[1].total - a[1].total)
                  .map(([m, v]) => (
                    <div key={m} className="flex items-baseline justify-between border-b border-line/60 py-1.5">
                      <span className="truncate text-[12px] text-fg2">{m}</span>
                      <span className="shrink-0 text-[12px] tabular-nums text-fg-muted">
                        {num(v.total)} · {num(v.calls)}회
                      </span>
                    </div>
                  ))
              )}
            </section>
          </div>

          <section className="card p-4">
            <h2 className="mb-2 text-[13px] font-semibold">날짜별</h2>
            {days.length === 0 ? (
              <p className="py-6 text-center text-[12.5px] text-fg-muted">아직 기록이 없습니다.</p>
            ) : (
              <div className="flex items-end gap-1 overflow-x-auto pb-1">
                {days.map(([d, v]) => (
                  <div key={d} className="flex w-8 shrink-0 flex-col items-center gap-1"
                    title={`${d} · ${hhmm(v.seconds)} · 토큰 ${num(v.tokens)}`}>
                    <span className="flex h-24 w-full items-end">
                      <span className="w-full rounded-t bg-accent"
                        style={{ height: `${maxDay ? Math.max(3, Math.round((v.seconds / maxDay) * 96)) : 3}px` }} />
                    </span>
                    <span className="text-[10px] tabular-nums text-fg-subtle">{d.slice(8)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </Shell>
  );
}
