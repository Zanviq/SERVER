/**
 * 밑글(저장되지 못한 편집) 회귀 테스트.  실행: npm test  (frontend 폴더에서)
 *
 * 규칙은 하나다 — **저장에 성공하면 지운다.** 그래서 "밑글이 남아 있다"는
 * "서버에 닿지 못한 편집이 있다"와 같은 뜻이고, 화면은 그때만 되살리기를 묻는다.
 * 이 대응이 깨지면 멀쩡히 저장된 문서에도 띠가 뜨거나(성가시다), 잃어버린 글에
 * 띠가 안 뜬다(그게 더 나쁘다).
 */
import { bundle } from "./bundle.mjs";

// localStorage 가 없는 node 에서 돌린다 — 모듈이 쓰는 최소한만 흉내 낸다.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { keepDraft, dropDraft, readDraft, moveDraft, draftAgeText } =
  await bundle("src/lib/draftBackup.ts");

let fails = 0;
function check(label, cond, extra = "") {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    fails++;
    console.log(`  FAIL ${label}${extra ? `\n       ${extra}` : ""}`);
  }
}

console.log("\n밑글 — 저장에 성공하면 지운다");
keepDraft("메모.md", "쓰던 글");
check("남긴 뒤에는 되살릴 것이 있다", readDraft("메모.md", "서버 내용")?.text === "쓰던 글");
check("서버 내용과 같으면 되살릴 것이 없다", readDraft("메모.md", "쓰던 글") === null);
check("같으면 그 자리에서 지운다", store.size === 0, `남은 키 ${[...store.keys()]}`);

keepDraft("메모.md", "다시 쓰던 글");
dropDraft("메모.md");
check("저장에 성공하면 사라진다", readDraft("메모.md", "서버 내용") === null);

console.log("\n경로가 바뀌면 따라간다");
keepDraft("옛이름.md", "따라올 글");
moveDraft("옛이름.md", "새이름.md");
check("새 경로에서 찾을 수 있다", readDraft("새이름.md", "")?.text === "따라올 글");
check("옛 경로에는 남지 않는다", readDraft("옛이름.md", "") === null);
dropDraft("새이름.md");

console.log("\n망가진 값·오래된 값은 스스로 지운다");
store.set("note-draft:깨진.md", "{이건 JSON 이 아니다");
check("깨진 값은 null 이다", readDraft("깨진.md", "") === null);
check("깨진 값은 지워진다", !store.has("note-draft:깨진.md"));

const old = Date.now() - 8 * 24 * 3600 * 1000;
store.set("note-draft:오래.md", JSON.stringify({ text: "옛날 글", at: old }));
check("7일이 지나면 되살리지 않는다", readDraft("오래.md", "") === null);
check("오래된 값도 지워진다", !store.has("note-draft:오래.md"));

console.log("\n너무 큰 글은 담지 않는다(저장소를 한 문서가 다 먹지 않게)");
keepDraft("큰글.md", "가".repeat(200001));
check("상한을 넘으면 담지 않는다", readDraft("큰글.md", "") === null);
keepDraft("큰글.md", "가".repeat(199999));
check("상한 안이면 담는다", readDraft("큰글.md", "")?.text.length === 199999);
dropDraft("큰글.md");

console.log("\n저장소가 막혀 있어도 편집을 멈추지 않는다");
const real = globalThis.localStorage.setItem;
globalThis.localStorage.setItem = () => { throw new Error("QuotaExceeded"); };
let threw = false;
try { keepDraft("사파리.md", "가득 찼을 때"); } catch { threw = true; }
globalThis.localStorage.setItem = real;
check("quota 오류를 밖으로 던지지 않는다", !threw);

console.log("\n지난 시간 표기");
check("방금", draftAgeText(Date.now()) === "방금");
check("분", draftAgeText(Date.now() - 5 * 60000) === "5분 전");
check("시간", draftAgeText(Date.now() - 3 * 3600000) === "3시간 전");
check("일", draftAgeText(Date.now() - 50 * 3600000) === "2일 전");

console.log(fails ? `\n${fails}개 실패` : "\n모두 통과");
process.exit(fails ? 1 : 0);
