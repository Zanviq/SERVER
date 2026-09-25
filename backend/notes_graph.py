"""노트 링크 파싱 + 그래프 빌드 (옵시디언식).

노트는 .md 파일. 다른 노트를 가리키는 길은 둘이다:
- `[[제목]]`·`[[제목|별칭]]` — 파일명(확장자 제외, stem)으로 매칭한다.
- `[note/경로]` — 이 앱의 링크(입력칸에서 `[` 를 치면 넣어 주는 것). 문서 루트 기준 경로로 매칭한다.
  예전엔 위키링크만 세어, 앱이 넣어 준 링크로 이은 문서는 역링크에도 지도에도 나오지 않았다(46차).
"""
from __future__ import annotations

import hashlib
import logging
import re
import threading
from collections import OrderedDict
from pathlib import Path
from typing import NamedTuple

from . import doc_cache, moved
from .storage import WalkedFile, walk_all, walk_files

logger = logging.getLogger("server.graph")

#: `[[제목]]` 링크. `![[사진.png]]` 은 **링크가 아니라 임베드**다 — 화면은 그것을
#: 그림으로 그리지 눌러서 갈 수 있는 링크로 만들지 않는다. 여기서 세면 그래프와
#: 백링크에만 있는 유령 링크가 생긴다.
_WIKILINK = re.compile(r"(?<!!)\[\[([^\[\]]+?)\]\]")

# (resolved_base, mode) -> (fingerprint, result). 파일시스템 지문으로 자가 무효화.
#
# 열쇠에 요청이 준 folder 문자열을 그대로 쓰면 안 된다. 없는 폴더는 루트로
# 떨어지므로 `?folder=아무거나` 를 바꿔 가며 부르는 것만으로 벌트 전체 그래프
# 사본이 무한히 쌓인다. 해석한 경로로만 잡고, 개수도 묶어 둔다.
_CACHE: dict[tuple, tuple] = {}
_CACHE_MAX = 32


#: 노트 하나의 위키링크 — 열쇠(경로) -> (mtime_ns, size, 링크들).
#:
#: 그래프 캐시(_CACHE)는 **벌트 전체**가 한 단위라, 노트 하나만 저장해도 통째로
#: 무효가 된다. 그러면 다음 열기의 백링크가 바뀌지 않은 노트까지 전부 다시 읽고
#: 파싱했다 — 노트 2천 개에서 "저장 뒤 첫 열기" 1.6초(그다음 열기는 0.19초).
#: 자동저장이 돌 때마다 그 1.6초를 문서를 옮길 때 치렀다. 노트마다 링크를 담아
#: 두면 바뀐 노트만 다시 읽는다.
#:
#: 무효화는 doc_cache 와 같다 — mtime·크기가 그대로면 같은 내용으로 본다(저장은
#: os.replace 로 갈아 끼우므로 내용이 바뀌면 mtime 이 반드시 바뀐다).
class NoteLinks(NamedTuple):
    """노트 하나가 가리키는 것 — 위키링크 제목과 `[note/…]` 경로(문서 루트 기준, 되돌린 이름)."""
    titles: tuple[str, ...] = ()
    paths: tuple[str, ...] = ()


_LINKS: "OrderedDict[str, tuple[int, int, NoteLinks]]" = OrderedDict()
#: 담아 둘 노트 수. 넘으면 오래 안 쓴 것부터 버린다(지운 노트가 남아도 여기서 멈춘다).
_LINKS_MAX = 50_000
_links_lock = threading.Lock()


def clear_cache() -> None:
    _CACHE.clear()
    with _links_lock:
        _LINKS.clear()


def parse_note_links(text: str) -> list[str]:
    """본문의 `[note/경로]` 링크 경로들(나온 순서, 중복 없이). 코드 안의 것은 뺀다(links.find_refs)."""
    # 링크가 없는 글은 코드 가리기·정규식을 돌리지 않는다(문서 링크의 갈래는 note·notes 뿐이다)
    if "[note" not in text:
        return []
    # links 는 여러 저장소를 불러온다 — 그래프만 쓰는 쪽까지 끌고 오지 않게 부를 때 불러온다
    from .links import find_refs, split

    out: list[str] = []
    for ref in find_refs(text):
        kind, rest = split(ref)
        if kind == "note" and rest and rest not in out:
            out.append(rest)
    return out


def _links_of(f: WalkedFile) -> NoteLinks:
    """이 노트의 링크. 지난번과 mtime·크기가 같으면 읽지도 파싱하지도 않는다."""
    key = f.abspath
    fp = (f.stat.st_mtime_ns, f.stat.st_size)
    with _links_lock:
        hit = _LINKS.get(key)
        if hit is not None and (hit[0], hit[1]) == fp:
            _LINKS.move_to_end(key)
            return hit[2]
    # 본문은 검색과 같은 캐시로 읽는다(같은 파일을 두 번 읽지 않게).
    text = doc_cache.text_of(f.path, f.stat)
    if text is None:
        return NoteLinks()
    # 전에는 read_text 로 읽었다 — 줄바꿈을 모두 \n 으로 바꿔 준다. 코드 구간 판정
    # (빈 줄은 못 넘는다)이 \n 만 보므로, CRLF 문서에서 결과가 달라지지 않게 맞춘다.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    found = NoteLinks(tuple(parse_wikilinks(text)), tuple(parse_note_links(text)))
    with _links_lock:
        _LINKS.pop(key, None)
        _LINKS[key] = (fp[0], fp[1], found)
        while len(_LINKS) > _LINKS_MAX:
            _LINKS.popitem(last=False)
    return found


class _Lookup:
    """링크로 노트를 찾는 표 — 위키링크는 제목(stem)으로, `[note/경로]` 는 문서 루트 기준 경로로.

    링크 그래프와 폴더 지도가 같은 표를 쓴다(두 벌로 만들면 한쪽만 규칙이 바뀐다). 값은 부르는
    쪽이 정한다(그래프는 stem, 폴더 지도는 Path). 같은 열쇠는 먼저 넣은 것이 이긴다.
    """

    def __init__(self, notes_dir: Path) -> None:
        self.by_title: dict = {}
        self.by_rel: dict = {}
        self._notes_dir = notes_dir
        self._moved: list[dict] | None = None  # 옮김 기록 — 못 찾은 경로 링크가 있을 때만 읽는다

    def add(self, path: Path, notes_dir: Path, value) -> None:
        self.by_title.setdefault(path.stem.lower(), value)
        # 경로는 확장자를 붙여도 떼어도 같은 문서다(링크 열기와 같은 규칙)
        key = path.relative_to(notes_dir).as_posix().lower()
        self.by_rel.setdefault(key, value)
        if key.endswith(".md"):
            self.by_rel.setdefault(key[:-3], value)

    def targets(self, ln: NoteLinks) -> list:
        """노트 하나의 링크가 닿는 것들(못 찾은 것은 None)."""
        out = [self.by_title.get(t.lower()) for t in ln.titles]
        for p in ln.paths:
            rel = p.strip("/")
            hit = self.by_rel.get(rel.lower())
            out.append(hit if hit is not None else self._follow(rel))
        return out

    def _follow(self, rel: str):
        """이름을 바꾸거나 옮긴 문서를 옛 경로로 가리키는 링크 — 누르면 옮김 기록을 따라 열리므로(links.resolve)
        역링크·지도도 같은 기록을 따라가 센다(48차). 예전엔 누르면 열리는데 역링크에는 없었다.
        남의 문서의 링크를 고쳐 쓰지 않는다는 규칙(moved.py)은 그대로다."""
        if self._moved is None:
            self._moved = moved.rows_beside(self._notes_dir)
        if not self._moved:
            return None
        exists = lambda r: r.lower() in self.by_rel  # noqa: E731
        for cand in (rel, f"{rel}.md"):  # 확장자 없이 적은 옛 링크도(링크 열기와 같은 규칙)
            now = moved.follow_rows(self._moved, cand, exists)
            if now is not None:
                return self.by_rel.get(now.lower())
        return None


def _fingerprint(files: list[WalkedFile], dirs: list[str]) -> tuple:
    """순회 결과의 값싼 지문(.md수·디렉터리수·최대mtime·총크기·이름들).

    본문을 읽지 않으므로 read_text 그래프 빌드보다 훨씬 싸다. 저장 시 mtime이
    바뀌므로 지문이 바뀌어 캐시가 자연히 무효화된다.

    **이름 목록의 해시도 넣는다.** 이름 변경·이동은 개수·크기·mtime 을 하나도
    바꾸지 않아서(옮겨진 파일의 mtime 은 그대로다), 그것만으로는 지문이 같아
    그래프와 백링크가 다음 저장이 있을 때까지 낡은 채로 남았다.

    캐시가 맞아떨어져도 이 지문은 매번 계산하므로, 순회는 **한 번만** 한다 —
    build_graph 는 지문을 낸 그 순회 결과로 그래프까지 만든다.
    """
    md = 0
    mx = total = 0
    h = hashlib.blake2b(digest_size=16)
    for f in files:
        if f.rel.endswith(".md"):
            md += 1
            total += f.stat.st_size
            h.update(f.rel.encode("utf-8", "surrogatepass"))
            h.update(b"\0")
        if f.stat.st_mtime_ns > mx:
            mx = f.stat.st_mtime_ns
    for d in dirs:
        h.update(d.encode("utf-8", "surrogatepass"))
        h.update(b"\1")
    return (md, len(dirs), mx, total, h.hexdigest())


#: 인용 기호·목록 앞머리. 그 안에도 코드블록이 있다(`> ```` `, `- ```` `).
_LEAD = re.compile(r"^[\s>]*(?:[-*+]\s+|\d+[.)]\s+)?")
#: 코드 울타리(``` 또는 ~~~). 앞머리를 떼고 본다.
_FENCE = re.compile(r"^(`{3,}|~{3,})")
#: 목록 항목의 시작(들여쓴 하위 항목도 포함)
_LIST_ITEM = re.compile(r"^\s*(?:[-*+]\s|\d+[.)]\s)")
#: 울타리 없는 옛 표기의 코드블록(4칸 이상 들여쓰기 또는 탭)
_INDENTED_CODE = re.compile(r"^(?: {4}|\t)")
#: 인라인 코드 — 백틱 개수가 맞는 구간.
#: 줄바꿈은 넘되 **빈 줄은 넘지 못한다**(마크다운의 코드 구간은 한 문단 안이다).
#: 빈 줄까지 넘게 두면, 문서 앞뒤에 흩어진 백틱 두 개가 그 사이 전부를 코드로
#: 만들어 멀쩡한 [[링크]]가 그래프에서 통째로 사라진다.
_INLINE_CODE = re.compile(r"(`+)(?:[^\n]|\n(?![ \t]*\n))*?\1")


def _without_code(text: str) -> str:
    """코드 울타리·인라인 코드를 지운다(길이는 유지하지 않아도 된다).

    편집기·읽기 뷰(wikiTransform)는 코드 안의 `[[제목]]` 을 링크로 보지 않는다.
    여기만 세면 그래프·백링크가 화면과 어긋난다.
    """
    out: list[str] = []
    fence: str | None = None
    prev_blank = True   # 들여쓴 코드블록은 문단을 끊고 들어올 수 없다
    in_code = False     # 들여쓴 코드블록이 이어지는 중인가
    in_list = False     # 목록 안인가(그 안의 들여쓰기는 코드가 아니라 하위 항목)
    for line in text.split("\n"):
        body = _LEAD.sub("", line, count=1)
        m = _FENCE.match(body)
        if fence is None and m:
            fence = m.group(1)
            out.append("")  # 빈 줄로 남긴다 — 아래 인라인 코드가 여기를 넘지 않게
            prev_blank, in_code = False, False
            continue
        if fence is not None:
            # 길이를 3으로 뭉개면 안 된다. ````` 로 연 울타리 안의 ``` 줄이
            # 울타리를 닫아 버려서, 코드 예시 속 [[링크]]가 진짜 간선이 된다.
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence):
                fence = None
            out.append("")
            continue
        if not line.strip():
            out.append(line)
            prev_blank, in_code = True, False
            continue
        if _LIST_ITEM.match(line):
            in_list = True
        elif not line[:1].isspace():
            in_list = False  # 들여쓰기 없는 보통 줄이 나오면 목록이 끝난다
        # 4칸 이상 들여쓴 줄도 코드블록이다(울타리 없는 옛 표기). 단,
        #  - 문단 도중에는 코드가 될 수 없고(빈 줄 뒤에서만 시작한다),
        #  - **목록 안에서는 하위 항목**이다. 이걸 안 보면 `- 상위 / 4칸 - 하위`
        #    같은 흔한 중첩 목록의 [[링크]]가 통째로 사라진다.
        if _INDENTED_CODE.match(line) and not in_list and (prev_blank or in_code):
            out.append("")
            in_code = True
            continue
        out.append(line)
        prev_blank, in_code = False, False
    return _INLINE_CODE.sub(" ", "\n".join(out))


def parse_wikilinks(text: str) -> list[str]:
    """본문에서 위키링크 대상(제목)들을 추출. 별칭/헤더앵커는 제거."""
    out: list[str] = []
    for raw in _WIKILINK.findall(_without_code(text)):
        target = raw.split("|", 1)[0]  # [[제목|별칭]] → 제목
        target = target.split("#", 1)[0]  # [[제목#섹션]] → 제목
        target = target.strip()
        if target and target not in out:
            out.append(target)
    return out


def _resolve_base(notes_dir: Path, folder: str | None) -> Path:
    """folder(상대경로)로 하위 트리 루트 결정. 벗어나거나 없으면 notes_dir."""
    if not folder:
        return notes_dir
    base = (notes_dir / folder).resolve()
    if base.is_dir() and (base == notes_dir or notes_dir in base.parents):
        return base
    return notes_dir


def build_graph(
    notes_dir: Path, folder: str | None = None, mode: str = "links"
) -> dict:
    """노트 그래프 {nodes, links} 생성.

    - mode="links": folder 하위 노트들의 위키링크 그래프.
        nodes: [{id: stem, title, path, type:"note"}]
    - mode="folders": folder의 직속 하위 폴더를 노드로 (드릴다운).
        nodes: 폴더 [{id: rel, title, path, type:"folder", count}]
             + folder 직속 노트 [{id: stem, ..., type:"note"}]
        links: 그룹(폴더/노트) 간 위키링크 집계.
    """
    base = _resolve_base(notes_dir, folder)
    # 열쇠는 **해석한 경로**로. 요청이 준 folder 문자열을 쓰면 없는 폴더 이름을
    # 바꿔 가며 부르는 것만으로 같은 그래프 사본이 무한히 쌓인다.
    cache_key = (str(notes_dir), str(base), mode)
    files, dirs = walk_all(base) if base.exists() else ([], [])
    fp = _fingerprint(files, dirs)
    cached = _CACHE.get(cache_key)
    if cached and cached[0] == fp:
        return cached[1]  # 변경 없음 → 캐시 반환(전체 파일 읽기·파싱 스킵)

    result = _folder_graph(notes_dir, base) if mode == "folders" else _link_graph(notes_dir, files)
    _remember(cache_key, fp, result)
    return result


def _link_graph(notes_dir: Path, files: list[WalkedFile]) -> dict:
    """노트 사이의 링크 그래프(위키링크·경로 링크). 폴더 지도(_folder_graph)와 짝이다."""
    notes = [f for f in files if f.rel.endswith(".md")]
    find = _Lookup(notes_dir)
    nodes = []
    for f in notes:
        p = f.path
        stem = p.stem
        find.add(p, notes_dir, stem)
        nodes.append(
            {
                "id": stem,
                "title": stem,
                "path": p.relative_to(notes_dir).as_posix(),
                "type": "note",
            }
        )

    links = []
    seen = set()
    for f in notes:
        src = f.path.stem
        for tgt in find.targets(_links_of(f)):
            if tgt and tgt != src:
                key = (src, tgt)
                if key not in seen:
                    seen.add(key)
                    links.append({"source": src, "target": tgt})
    return {"nodes": nodes, "links": links}


def _remember(key: tuple, fp: tuple, result: dict) -> None:
    """캐시에 담되 개수를 묶어 둔다(가장 오래된 것부터 버린다)."""
    _CACHE.pop(key, None)
    _CACHE[key] = (fp, result)
    while len(_CACHE) > _CACHE_MAX:
        _CACHE.pop(next(iter(_CACHE)))


def _usable_name(p: Path) -> bool:
    """이름을 UTF-8 로 실어 보낼 수 있는가.

    storage._walk 은 이런 이름을 건너뛰지만 iterdir 은 그대로 준다. 하나만
    있어도 응답을 만들 때 터져서 폴더 모드 그래프가 통째로 500 이 됐다.
    """
    try:
        p.name.encode("utf-8")
        return True
    except UnicodeEncodeError:
        logger.warning("이름을 다룰 수 없어 건너뜀: %r", p)
        return False


def _folder_graph(notes_dir: Path, base: Path) -> dict:
    """base의 직속 하위 폴더(+직속 노트)를 노드로 하는 그래프."""
    try:
        entries = sorted(p for p in base.iterdir() if _usable_name(p))
    except OSError:
        entries = []
    subdirs = [d for d in entries if d.is_dir()]
    loose_notes = [p for p in entries if p.is_file() and p.suffix == ".md"]

    nodes: list[dict] = []
    for d in subdirs:
        rel = d.relative_to(notes_dir).as_posix()
        count = sum(1 for f in walk_files(d, sort=False) if f.rel.endswith(".md"))
        nodes.append(
            {"id": f"f:{rel}", "title": d.name, "path": rel,
             "type": "folder", "count": count}
        )
    for p in loose_notes:
        nodes.append(
            {
                # 폴더 id 와 이름공간을 나눈다. 루트에 `X` 폴더와 `X.md` 가 함께
                # 있으면 id 가 겹쳐 간선이 엉뚱한 데 붙거나 사라졌다.
                "id": f"n:{p.stem}",
                "title": p.stem,
                "path": p.relative_to(notes_dir).as_posix(),
                "type": "note",
            }
        )

    # 노트 → 소속 그룹(직속 하위폴더 rel 또는 직속 노트 stem) 매핑
    def group_of(note: Path) -> str | None:
        try:
            rel_parts = note.relative_to(base).parts
        except ValueError:
            return None
        if len(rel_parts) == 1:  # base 직속 노트
            return f"n:{note.stem}"
        return "f:" + (base / rel_parts[0]).relative_to(notes_dir).as_posix()

    # 전체 스템 → 경로 (base 하위만) 로 위키링크 대상 해석
    all_notes = [f for f in walk_files(base, sort=False) if f.rel.endswith(".md")]
    find = _Lookup(notes_dir)
    for f in all_notes:
        find.add(f.path, notes_dir, f.path)

    valid_ids = {n["id"] for n in nodes}
    links = []
    seen = set()
    for f in all_notes:
        g_src = group_of(f.path)
        if g_src not in valid_ids:
            continue
        for tp in find.targets(_links_of(f)):
            if not tp:
                continue
            g_tgt = group_of(tp)
            if g_tgt in valid_ids and g_tgt != g_src:
                key = (g_src, g_tgt)
                if key not in seen:
                    seen.add(key)
                    links.append({"source": g_src, "target": g_tgt})
    return {"nodes": nodes, "links": links}


def warm_up(roots: list[Path]) -> None:
    """서버를 띄운 뒤 사용자마다 문서 그래프를 미리 만들어 둔다(뒤에서, 한 사람씩).

    문서 열기(/api/notes/get)는 역링크를 위해 그래프를 쓰는데, 식은 캐시에서는 모든 노트를 읽고
    파싱한다. 47차 실측(노트 2045개): 서버를 띄운 뒤 첫 문서 열기 2.2초, 둘째부터 0.13초. 배포마다
    서버가 다시 뜨므로 그때마다 첫 문서가 그만큼(파이에서는 몇 배) 늦었다. 여기서 먼저 만들어 두면
    첫 열기도 캐시를 쓴다. 실패는 기록만 한다 — 미리 못 만들었을 뿐 열 때 만들면 된다.
    """
    for root in roots:
        try:
            build_graph(root)
        except Exception:  # noqa: BLE001
            logger.exception("문서 그래프를 미리 만들지 못했습니다: %s", root)


def backlinks_for(notes_dir: Path, stem: str) -> list[str]:
    """주어진 노트(stem)를 가리키는 다른 노트들의 stem 목록."""
    graph = build_graph(notes_dir)
    return [
        link["source"]
        for link in graph["links"]
        if link["target"].lower() == stem.lower()
    ]
