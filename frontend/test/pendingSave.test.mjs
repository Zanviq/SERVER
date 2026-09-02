/**
 * 자동저장 타이머·열기 순번 규칙 검사.
 *
 * 여기가 틀리면 사용자의 글이 사라지거나 지운 문서가 되살아난다. 화면 코드에
 * 묻어 있을 때는 한 줄도 실행되지 않았다(프런트 테스트가 순수 lib 만 돌았다).
 */
import { bundle } from "./bundle.mjs";

const { PendingSave, LatestWins } = await bundle("src/lib/pendingSave.ts");

let failed = 0;
function check(label, ok, extra = "") {
  console.log(`  ${ok ? "OK  " : "!!  "} ${label}${ok ? "" : ` — ${extra}`}`);
  if (!ok) failed++;
}

/** 손으로 돌리는 시계 — 진짜 시간을 기다리지 않는다. */
function fakeTimers() {
  const jobs = new Map();
  let next = 1;
  return {
    timers: {
      set: (fn) => { jobs.set(next, fn); return next++; },
      clear: (id) => { jobs.delete(id); },
    },
    /** 예약된 것을 모두 실행한다(시간이 흐른 셈).
     *  저장은 비동기라, 실행만 시키고 끝나기를 기다려 준다. */
    async tick() {
      const all = [...jobs.values()];
      jobs.clear();
      for (const f of all) f();
      await new Promise((r) => setImmediate(r));
    },
    get pending() { return jobs.size; },
  };
}

console.log("대기 중인 자동저장");

{
  const clock = fakeTimers();
  const p = new PendingSave(clock.timers);
  const saved = [];
  p.schedule(900, () => saved.push("첫"));
  check("예약하면 대기 중이다", p.scheduled);
  await clock.tick();
  check("시간이 지나면 저장한다", saved.join() === "첫", saved.join());
  check("저장한 뒤에는 대기가 없다", !p.scheduled);
}

{
  const clock = fakeTimers();
  const p = new PendingSave(clock.timers);
  const saved = [];
  p.schedule(900, () => saved.push("옛본문"));
  p.schedule(900, () => saved.push("새본문"));
  // **tick 전에** 센다. tick 은 실행 전에 jobs 를 비우므로, 그 뒤에 세면
  // 옛 타이머를 안 지워도 언제나 0 이라 아무것도 검사하지 못한다.
  check("옛 타이머는 지운다", clock.pending === 1, String(clock.pending));
  await clock.tick();
  check("예약을 덮어쓰면 마지막 것만 저장한다", saved.join() === "새본문", saved.join());
}

{
  // 문서를 옮기기 전: 흘려보내야 마지막 입력이 살아남는다
  const clock = fakeTimers();
  const p = new PendingSave(clock.timers);
  const saved = [];
  p.schedule(900, () => saved.push("마지막입력"));
  const ran = await p.flush();
  check("흘려보내면 곧바로 저장한다", ran && saved.join() === "마지막입력", saved.join());
  await clock.tick();
  check("흘려보낸 뒤 타이머가 또 저장하지 않는다", saved.length === 1, String(saved.length));
  check("남은 게 없으면 flush 는 true(=다 저장됨)", (await p.flush()) === true);
}

{
  // 문서를 지운 뒤: 버려야 유령 문서가 안 생긴다
  const clock = fakeTimers();
  const p = new PendingSave(clock.timers);
  const saved = [];
  p.schedule(900, () => saved.push("지운문서"));
  check("버리면 true", p.cancel() === true);
  await clock.tick();
  check("버린 저장은 시간이 지나도 실행되지 않는다", saved.length === 0, saved.join());
  check("버릴 게 없으면 false", p.cancel() === false);
  check("버린 뒤 흘려보내면 true(=남은 게 없다)", (await p.flush()) === true);
}

{
  // 저장이 실패하면 **버리지 않는다** — 버리면 그 글이 어디에도 안 남는다
  const clock = fakeTimers();
  const p = new PendingSave(clock.timers);
  let attempts = 0;
  p.schedule(900, () => { attempts++; return false; });  // 서버가 거절했다
  await clock.tick();
  check("실패해도 아직 남아 있다", p.scheduled, "버려졌다");
  check("한 번 시도했다", attempts === 1, String(attempts));

  const ok1 = await p.flush();
  check("다시 시도한다", attempts === 2, String(attempts));
  check("또 실패하면 flush 가 false", ok1 === false);
  check("그래도 남아 있다", p.scheduled);
}

{
  // 던지는 저장도 실패로 본다
  const clock = fakeTimers();
  const p = new PendingSave(clock.timers);
  let tries = 0;
  p.schedule(900, () => { tries++; if (tries === 1) throw new Error("끊김"); return true; });
  await clock.tick();
  check("던지면 실패로 보고 남긴다", p.scheduled);
  const ok = await p.flush();
  check("다음 시도가 성공하면 지운다", ok === true && !p.scheduled, `ok=${ok}`);
}

{
  // 실패한 뒤 새 입력이 오면 **새 내용이 이긴다**(옛 예약을 덮어쓴다)
  const clock = fakeTimers();
  const p = new PendingSave(clock.timers);
  const saved = [];
  p.schedule(900, () => { saved.push("옛것"); return false; });
  await clock.tick();
  p.schedule(900, () => { saved.push("새것"); return true; });
  await p.flush();
  check("실패한 옛 예약을 새 입력이 대신한다", saved.join(">") === "옛것>새것", saved.join(">"));
  check("성공했으니 비어 있다", !p.scheduled);
}

{
  // 비동기 저장이 끝날 때까지 기다린다(안 기다리면 이름 변경이 먼저 나간다)
  const clock = fakeTimers();
  const p = new PendingSave(clock.timers);
  const order = [];
  p.schedule(900, async () => {
    await new Promise((r) => setTimeout(r, 5));
    order.push("저장끝");
  });
  await p.flush();
  order.push("이름변경");
  check("저장이 끝난 뒤에 다음 동작이 온다", order.join(">") === "저장끝>이름변경", order.join(">"));
}

console.log("\n열기 순번 — 마지막에 누른 것만 이긴다");

{
  const seq = new LatestWins();
  const a = seq.begin();
  const b = seq.begin();
  check("나중 표가 최신이다", seq.isCurrent(b));
  check("먼저 시작한 응답은 버린다", !seq.isCurrent(a));
}

{
  // 표를 **시작할 때** 받아야 한다. 기다린 뒤에 받으면 순서가 뒤집힌다.
  const seq = new LatestWins();
  const first = seq.begin();   // 느린 문서를 먼저 눌렀다
  const second = seq.begin();  // 곧바로 다른 문서를 눌렀다
  check("먼저 누른 쪽이 늦게 도착해도 지지 않는다", !seq.isCurrent(first) && seq.isCurrent(second));
}

{
  const seq = new LatestWins();
  const t = seq.begin();
  seq.abandonAll();
  check("문서를 닫으면 진행 중이던 열기가 무효가 된다", !seq.isCurrent(t));
}

console.log(failed ? `\n실패 ${failed}건` : "\n모두 통과");
process.exit(failed ? 1 : 0);
