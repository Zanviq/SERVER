/**
 * 마이크 권한을 기다리다 답이 없을 때 — **멈춰 있으면 안 된다.**
 *
 * 실측: 어떤 브라우저에서 `getUserMedia` 의 약속이 해결도 거부도 되지 않았다.
 * 그러면 `await` 가 그대로 멈춰서, 화면에는 "녹음 시작" 단추만 남고 눌러도
 * 아무 일이 일어나지 않는다 — 사용자는 단추가 고장 난 줄 안다. 실제로도
 * 사용자가 권한 팝업을 고르지 않고 놔두면 같은 상태가 된다.
 *
 * Recorder.tsx 의 withTimeout 과 같은 규칙을 여기서 확인한다(그 파일은 React·
 * 브라우저 API 를 써서 노드에서 그대로 못 부른다).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

class MicTimeout extends Error {}

function withTimeout(p, ms) {
  let settled = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new MicTimeout());
    }, ms);
    p.then(
      (s) => {
        clearTimeout(timer);
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

const fakeStream = () => {
  const stopped = [];
  return { stopped, getTracks: () => [{ stop: () => stopped.push(1) }] };
};

test("제때 오면 그대로 준다", async () => {
  const s = fakeStream();
  const got = await withTimeout(Promise.resolve(s), 50);
  assert.equal(got, s);
  assert.equal(s.stopped.length, 0, "정상 경로에서 트랙을 끄면 안 된다");
});

test("거부는 그대로 올라간다(권한 거부와 시간초과는 할 일이 다르다)", async () => {
  const err = new Error("NotAllowedError");
  await assert.rejects(() => withTimeout(Promise.reject(err), 50), (e) => {
    assert.equal(e, err);
    assert.ok(!(e instanceof MicTimeout));
    return true;
  });
});

test("영영 답이 없으면 시간초과로 끝난다 — 멈춰 있지 않는다", async () => {
  const never = new Promise(() => {});
  await assert.rejects(() => withTimeout(never, 30), MicTimeout);
});

test("포기한 뒤에 늦게 오면 마이크를 놓아 준다", async () => {
  const s = fakeStream();
  let release;
  const late = new Promise((res) => { release = () => res(s); });
  await assert.rejects(() => withTimeout(late, 20), MicTimeout);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.stopped.length, 1, "쓰지도 않을 스트림이 열린 채 남으면 안 된다");
});

test("시간초과 뒤 늦게 거부돼도 두 번 끝나지 않는다", async () => {
  let fail;
  const late = new Promise((_, rej) => { fail = () => rej(new Error("늦은 거부")); });
  await assert.rejects(() => withTimeout(late, 20), MicTimeout);
  fail();
  await new Promise((r) => setTimeout(r, 10));   // 처리 안 된 거부로 죽지 않아야 한다
});
