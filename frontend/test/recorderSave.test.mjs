/**
 * 녹음을 못 올렸으면 **창을 닫지 않는다.**
 *
 * 녹음은 브라우저 메모리에만 있다(파일 올리기와 다르다 — 그쪽은 원본이 디스크에
 * 남는다). 그래서 올리기가 실패했는데 창이 닫히면 한 시간짜리 회의가 통째로
 * 사라지고 되돌릴 방법이 없다.
 *
 * 실제로 그랬다: 부모의 upload() 가 오류를 토스트로만 삼키고 **늘 성공처럼**
 * 돌아왔고, save() 는 그 값을 보지 않고 onClose() 를 불렀다.
 *
 * Recorder.save 와 같은 규칙을 여기서 확인한다(그 파일은 React 라 노드에서
 * 그대로 못 부른다).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** Recorder.save 의 뼈대 */
function makeSave({ onSave, onClose, setProblem }) {
  return async () => {
    setProblem("");
    try {
      if (await onSave()) {
        onClose();
        return;
      }
      setProblem("올리지 못했습니다. 녹음은 그대로 있으니 다시 저장해 보세요.");
    } catch (e) {
      setProblem(`${e.message} — 녹음은 그대로 있습니다.`);
    }
  };
}

const spy = () => {
  const calls = [];
  const fn = (v) => calls.push(v);
  fn.calls = calls;
  return fn;
};

test("올렸으면 창을 닫는다", async () => {
  const onClose = spy(), setProblem = spy();
  await makeSave({ onSave: async () => true, onClose, setProblem })();
  assert.equal(onClose.calls.length, 1);
  assert.deepEqual(setProblem.calls, [""]);
});

test("실패를 false 로 알리면 창을 닫지 않는다", async () => {
  const onClose = spy(), setProblem = spy();
  await makeSave({ onSave: async () => false, onClose, setProblem })();
  assert.equal(onClose.calls.length, 0, "닫으면 녹음이 사라진다");
  assert.match(setProblem.calls.at(-1), /다시 저장/, "왜 안 됐는지·무엇을 할지 말해야 한다");
});

test("예외가 나도 창을 닫지 않는다", async () => {
  const onClose = spy(), setProblem = spy();
  await makeSave({
    onSave: async () => { throw new Error("Failed to fetch"); }, onClose, setProblem,
  })();
  assert.equal(onClose.calls.length, 0);
  assert.match(setProblem.calls.at(-1), /Failed to fetch/);
});

test("부모의 upload 는 실패를 삼키지 않고 돌려준다", () => {
  const src = readFileSync(new URL("../src/pages/Meetings.tsx", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("const upload = async"), src.indexOf("const update = async"));
  assert.match(fn, /allOk = false/, "catch 안에서 실패를 기록해야 한다");
  assert.match(fn, /return allOk/, "성공 여부를 돌려주지 않으면 녹음 창이 늘 닫힌다");
});

test("녹음을 파일로 내려받을 길이 있다", () => {
  const src = readFileSync(new URL("../src/components/meetings/Recorder.tsx", import.meta.url), "utf8");
  assert.match(src, /createObjectURL\(blob\)/, "서버가 아예 안 될 때 손에 남길 길이 하나는 있어야 한다");
  assert.match(src, /내려받기/);
});

test("올리기 실패 안내가 done 단계에서도 보인다", () => {
  const src = readFileSync(new URL("../src/components/meetings/Recorder.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\{problem && phase === "idle" &&/,
    'idle 일 때만 그리면 올리기 실패 이유가 어디에도 안 보인다');
});
