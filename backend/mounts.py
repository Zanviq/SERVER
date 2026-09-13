"""논문·회의 저장소를 문서 트리 **안에 붙여 보여 준다**(마운트).

문서 화면에서 `논문/…`·`회의/…` 폴더를 열면 실제 원본 파일이 나온다 — 논문 PDF,
회의 녹음, 회의록. 거기서 보고 고치고 지우면 논문·회의 화면에도 그대로 반영된다.
같은 파일을 가리키기 때문이다.

**왜 파일을 옮기지 않고 붙였는가.**

논문 한 편은 폴더 하나(`papers/<id>/`)이고, 그 목록의 정본은 `papers/index.json`
이다. 이 폴더들을 문서 저장소(`data/`) 안으로 **그냥 옮기면** 그 순간 전부
'평범한 문서'가 된다. 그러면:

  - index.json 이 문서로 보여서 지울 수 있다. 지우면 논문 목록이 통째로 사라지고,
    남은 폴더는 실물(paper.pdf)이 있어 미아 청소기도 치우지 않는다 —
    목록에도 휴지통에도 없고 지울 수도 없는 폴더가 된다.
  - 항목 폴더 이름은 32자리 16진수여야 하는데(경로 함수가 강제한다), 문서 화면에서
    이름을 바꾸면 그 논문은 영영 안 열린다.
  - 문서로 지우면 휴지통에 '문서'로 들어가고, 복원은 폴더만 되돌린다 — 색인에는
    안 돌아와서 "복원했는데 목록에 없다"가 된다.
  - 회의록(docs/*.md)이 위키 그래프·백링크·노트 검색에 섞여 같은 회의가 두 갈래로
    중복 검색된다. 논문 본문(text.txt, 최대 40만 자)과 받아쓰기(transcript.json)는
    문서 본문 캐시를 통째로 밀어낸다.
  - 문서 폴더 통째 내려받기가 녹음·PDF 까지 담아 수백 MB 가 된다.

마운트는 사용자가 원한 것(한곳에서 다 보고 고치고 지운다)을 그대로 주면서 위
문제를 하나도 만들지 않는다. 보이는 것은 **원본과 회의록뿐**이고, 색인·대화·
추출물 같은 내부 파일은 트리에 올리지 않는다.

규칙:
  - 마운트 폴더의 이름은 사용자가 바꾸거나 옮기거나 지울 수 없다(항목의 정체가
    색인에 있으므로). 안에 든 것은 자유롭게 다룬다.
  - 같은 이름의 진짜 폴더가 이미 있으면 마운트하지 않는다 — 사용자의 문서를
    가리는 것이 더 나쁘다.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException

from . import meeting_store, paper_store
from .auth import SessionUser
from .config import Settings

#: 트리에 보일 이름. 사용자가 만든 폴더와 겹치면 마운트를 접는다(아래 참조).
PAPERS_DIR = "논문"
MEETINGS_DIR = "회의"

MOUNT_DIRS = (PAPERS_DIR, MEETINGS_DIR)

_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def _folder_name(title: str, fallback: str) -> str:
    """항목 하나를 담을 폴더 이름. 제목을 쓰되 경로에 못 쓰는 글자는 바꾼다."""
    name = _ILLEGAL.sub("_", str(title or "").strip()).strip(". ")
    return (name or fallback)[:120]


@dataclass(frozen=True)
class MountedFile:
    """마운트된 파일 하나."""

    rel: str            # 문서 트리 기준 경로(`논문/제목/원본.pdf`)
    real: Path          # 실제 파일
    editable: bool      # 문서 화면에서 고칠 수 있는가(회의록만)
    kind: str           # 항목 갈래("paper" | "meeting")
    item_id: str        # 그 항목의 id
    role: str           # 항목 안에서의 역할("source" | "doc")


@dataclass(frozen=True)
class Mount:
    """마운트된 항목 하나(논문 한 편 / 회의 하나)."""

    kind: str
    item_id: str
    folder: str         # `논문/제목`
    files: list[MountedFile]


def _unique(name: str, taken: set[str]) -> str:
    """제목이 같은 항목이 둘이면 뒤엣것에 번호를 붙인다."""
    if name not in taken:
        taken.add(name)
        return name
    for n in range(2, 1000):
        cand = f"{name} ({n})"
        if cand not in taken:
            taken.add(cand)
            return cand
    taken.add(name)
    return name


def _paper_mounts(user: SessionUser, settings: Settings) -> list[Mount]:
    try:
        papers = paper_store.list_papers(user, settings)
    except Exception:  # noqa: BLE001 — 목록을 못 읽어도 문서 트리는 떠야 한다
        return []
    out: list[Mount] = []
    taken: set[str] = set()
    for p in papers:
        pid = str(p.get("id") or "")
        if not pid:
            continue
        folder = _unique(_folder_name(p.get("title") or "", p.get("filename") or pid), taken)
        rel_dir = f"{PAPERS_DIR}/{folder}"
        files: list[MountedFile] = []
        pdf = paper_store.paper_dir(user, settings, pid) / paper_store.PDF_NAME
        if pdf.exists():
            # 올릴 때의 이름을 그대로 보여 준다(디스크에는 언제나 paper.pdf 다)
            shown = paper_store.sanitize_filename(p.get("filename") or "paper.pdf")
            files.append(MountedFile(f"{rel_dir}/{shown}", pdf, False, "paper", pid, "source"))
        out.append(Mount("paper", pid, rel_dir, files))
    return out


def _meeting_mounts(user: SessionUser, settings: Settings) -> list[Mount]:
    try:
        meetings = meeting_store.list_meetings(user, settings)
    except Exception:  # noqa: BLE001
        return []
    out: list[Mount] = []
    taken: set[str] = set()
    for m in meetings:
        mid = str(m.get("id") or "")
        if not mid:
            continue
        folder = _unique(_folder_name(m.get("title") or "", m.get("date") or mid), taken)
        rel_dir = f"{MEETINGS_DIR}/{folder}"
        files: list[MountedFile] = []
        ext = str(m.get("ext") or "")
        if ext:
            audio = meeting_store.audio_path(user, settings, mid, ext)
            if audio.exists():
                shown = meeting_store.sanitize_filename(m.get("filename") or f"녹음.{ext}")
                if not shown.lower().endswith(f".{ext}"):
                    shown = f"{shown}.{ext}"
                files.append(MountedFile(f"{rel_dir}/{shown}", audio, False, "meeting", mid, "source"))
        try:
            docs = meeting_store.list_docs(user, settings, mid)
        except Exception:  # noqa: BLE001
            docs = []
        for d in docs:
            name = str(d.get("name") or "")
            if not name:
                continue
            real = meeting_store.docs_dir(user, settings, mid) / f"{meeting_store.doc_name(name)}.md"
            files.append(MountedFile(f"{rel_dir}/{name}.md", real, True, "meeting", mid, "doc"))
        out.append(Mount("meeting", mid, rel_dir, files))
    return out


def mounts(user: SessionUser, settings: Settings) -> list[Mount]:
    """지금 붙어 있는 항목 전부. 같은 이름의 진짜 폴더가 있으면 그 갈래는 접는다."""
    from .storage import user_data_root

    root = user_data_root(user, settings)
    out: list[Mount] = []
    if not (root / PAPERS_DIR).exists():
        out += _paper_mounts(user, settings)
    if not (root / MEETINGS_DIR).exists():
        out += _meeting_mounts(user, settings)
    return out


def folders(ms: list[Mount]) -> list[str]:
    """트리에 넣을 폴더 경로들(마운트 뿌리 + 항목 폴더)."""
    out: list[str] = []
    for name in MOUNT_DIRS:
        if any(m.folder.startswith(f"{name}/") for m in ms):
            out.append(name)
    out += [m.folder for m in ms]
    return out


def files(ms: list[Mount]) -> list[MountedFile]:
    return [f for m in ms for f in m.files]


def active_roots(user: SessionUser, settings: Settings) -> set[str]:
    """지금 **실제로 붙어 있는** 뿌리 폴더 이름.

    같은 이름의 진짜 폴더가 있으면 그 갈래는 접히므로, 그때 `논문/…` 은 평범한
    문서 경로다. 접힌 갈래까지 마운트로 취급하면 사용자의 진짜 문서를 못 읽는다.
    """
    from .storage import user_data_root

    root = user_data_root(user, settings)
    out: set[str] = set()
    if not (root / PAPERS_DIR).exists() and _paper_mounts(user, settings):
        out.add(PAPERS_DIR)
    if not (root / MEETINGS_DIR).exists() and _meeting_mounts(user, settings):
        out.add(MEETINGS_DIR)
    return out


def head_of(rel: str) -> str:
    return (rel or "").strip("/").split("/", 1)[0]


def is_mount_path(rel: str) -> bool:
    """이 경로가 마운트 **이름**으로 시작하는가(붙어 있든 아니든)."""
    return head_of(rel) in MOUNT_DIRS


def find(user: SessionUser, settings: Settings, rel: str) -> MountedFile | None:
    """문서 경로 → 마운트된 실제 파일. 마운트가 아니면 None."""
    clean = (rel or "").strip("/")
    if not is_mount_path(clean):
        return None
    for f in files(mounts(user, settings)):
        if f.rel == clean:
            return f
    return None


def find_folder(user: SessionUser, settings: Settings, rel: str) -> Mount | None:
    """문서 경로 → 그 항목(폴더). 항목 폴더가 아니면 None."""
    clean = (rel or "").strip("/")
    for m in mounts(user, settings):
        if m.folder == clean:
            return m
    return None


def reject_write(user: SessionUser, settings: Settings, rel: str) -> None:
    """붙어 있는 마운트 이름공간에 새 파일·폴더를 만들지 못하게 막는다.

    여기에 진짜 폴더가 생기면 이름이 겹쳐 마운트가 접히고, 논문·회의가 문서
    화면에서 통째로 사라진다. 있는 파일을 고치는 것은 막지 않는다(find 로 잡힌다).

    **접혀 있는 이름은 막지 않는다** — 그때 `논문/` 은 사용자의 진짜 폴더다.
    """
    head = head_of(rel)
    if head in active_roots(user, settings):
        raise HTTPException(
            status_code=400,
            detail=f"'{head}' 은 논문·회의 화면이 관리하는 폴더입니다. "
                   "여기에는 새로 만들 수 없습니다.")
