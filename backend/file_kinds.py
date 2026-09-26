"""파일 종류 분류 — 프런트가 어떤 뷰어를 쓸지 정하는 기준.

노트 페이지가 문서 공간 전체를 다루므로, 마크다운뿐 아니라 이미지·PDF·미디어도
같은 트리에서 열린다. 분류를 백엔드가 내려주면 프런트가 확장자 목록을 따로
관리하지 않아도 된다(두 곳이 어긋나는 것을 막는다).
"""
from __future__ import annotations

import re
import unicodedata

MARKDOWN = {".md", ".markdown"}

# CodeMirror로 편집 가능한 평문. 확장자가 없으면 텍스트로 본다.
TEXT = {
    ".txt", ".text", ".log", ".csv", ".tsv",
    ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".env",
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".css", ".scss", ".html", ".htm", ".xml", ".svg",
    ".sh", ".bash", ".zsh", ".ps1", ".bat",
    ".sql", ".c", ".h", ".cpp", ".hpp", ".java", ".kt", ".go", ".rs", ".rb", ".php",
    ".gitignore", ".dockerignore",
}

IMAGE = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".ico", ".svg"}
PDF = {".pdf"}
VIDEO = {".mp4", ".webm", ".ogv", ".mov", ".m4v"}
AUDIO = {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"}

# 브라우저에 그대로 표시해도 되는 종류의 MIME (inline 응답용)
_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".avif": "image/avif", ".ico": "image/x-icon", ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".mp4": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg",
    ".mov": "video/quicktime", ".m4v": "video/x-m4v",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac",
    ".opus": "audio/opus",
}


#: 확장자로 볼 꼬리 — 글자가 하나는 있어야 한다.
#: `2026.08`·`v1.2` 는 확장자가 아니다(날짜·버전을 확장자로 보면 이름이 망가진다).
_EXT_RE = re.compile(r"\.(?=[A-Za-z0-9]{1,8}$)[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$")


def looks_like_extension(name: str) -> bool:
    """이름의 꼬리가 확장자인가.

    **이 판단은 여기 한 곳에만 둔다.** 예전에는 같은 정규식이 세 파일에 복사돼
    있었고, 네 번째 자리(휴지통 복원)가 Path.suffixes 라는 다른 규칙을 쓰는 바람에
    `2026.08 회고` 의 확장자를 `.08 회고` 로 보고 이름을 망가뜨렸다.
    """
    return bool(_EXT_RE.search(name.rsplit("/", 1)[-1]))


def split_ext(name: str) -> tuple[str, str]:
    """이름을 (몸통, 확장자)로 나눈다. 확장자로 볼 수 없으면 확장자는 빈 문자열."""
    tail = name.rsplit("/", 1)[-1]
    m = _EXT_RE.search(tail)
    return (name[: len(name) - len(tail) + m.start()], tail[m.start():]) if m else (name, "")


def doc_title(name: str) -> str:
    """문서 이름에서 확장자만 뗀 것 — 목록·트리·열기·검색이 보여 주고 `[[제목]]` 자동완성이
    넣는 제목이다.

    예전에는 "마지막 점 뒤를 뗀다"(`rsplit(".", 1)`, `Path.stem`)였다. 확장자 없이 만든
    `2026.08 회고` 가 **"2026"**, `v1.2 계획` 이 "v1" 이 되었고, `2026.09 회고` 도 "2026"
    이라 `[[2026]]` 이 어느 쪽을 여는지 알 수 없었다(새 노트는 적은 이름 그대로 만들어지므로
    날짜를 이름에 넣으면 바로 겪는다). 확장자 판단은 split_ext 한 곳의 규칙을 따른다.
    """
    return split_ext(name.rsplit("/", 1)[-1])[0]


def nfc(name: str) -> str:
    """이름을 NFC(한글 음절이 한 글자로 붙은 꼴)로 — **이름이 들어오는 곳**(올리기·이름 바꾸기·새 폴더)에서.

    맥에서 올린 파일 이름은 NFD(자모가 풀린 꼴)로 오기도 한다. 화면엔 똑같이 보여도 바이트가 달라,
    자판으로 친 이름(NFC)으로는 검색·링크·경로 열기가 못 찾았고(404), 같은 이름으로 새로 만들면 눈에
    똑같은 문서가 둘 생겼다(64차 실측). 저장소 전체가 NFC 하나로 적히게 들어올 때 바꾼다 — 비교하는
    곳마다(검색만 스무 곳) 맞추면 한 곳을 놓치는 순간 다시 샌다.
    """
    return unicodedata.normalize("NFC", name)


class BadName(ValueError):
    """사용자가 준 새 이름을 쓸 수 없다(빈 이름·경로 조각)."""


def renamed(old_name: str, new_name: str, *, folder: bool = False) -> str:
    """이름 바꾸기의 **결과 이름**. 문서 화면과 AI 스킬이 이것 하나를 쓴다.

    - 확장자를 적지 않았으면 **원래 확장자**를 붙인다(`사진.png` → `고양이` = `고양이.png`).
    - 확장자 판정은 split_ext 다. `Path.suffix` 를 쓰면 `v1.2 notes` 의 가짜 꼬리
      `.2 notes` 를 확장자로 보고 새 이름에 통째로 붙였다 — AI 스킬이 실제로 그렇게
      `요약.2 notes` 를 만들었다(문서 화면은 이미 고쳐져 있었는데 두 곳이 따로 놀았다).
    - 폴더를 넘나드는 이름(`/`·`\\`·`..`)은 받지 않는다 — 이름 바꾸기는 같은 폴더 안이다.
    - 몸통은 그대로 두고 **확장자만 지웠으면** 확장자를 떼 달라는 뜻이다(`메모.py` → `메모`).
      원래 확장자를 다시 붙이면 결과가 옛 이름 그대로라, 화면에는 "같은 이름의 문서가 이미
      있습니다"(409)라는 거짓 오류가 뜨고 확장자는 영영 뗄 수 없었다(21차 실측).
      다만 이미지·PDF·녹음처럼 글이 아닌 파일은 떼지 않는다 — 확장자가 없으면 글로 보고
      편집기로 열어, 한 글자만 쳐도 원본을 글로 덮어쓴다.
    """
    new = nfc((new_name or "").strip())  # 맥에서 복사해 붙인 이름도 자판으로 친 것과 같게(nfc)
    if not new or "/" in new or "\\" in new or ".." in new:
        raise BadName("잘못된 이름입니다.")
    # 폴더에는 확장자가 없다 — 적은 이름 그대로. 확장자 규칙을 걸던 때는 `project.v1` 폴더를
    # `proj` 로 바꾸면 `proj.v1` 이 됐다(36차, 폴더 이름 바꾸기를 화면에 붙이며 찾았다).
    if folder:
        return new
    if looks_like_extension(new):
        return new
    stem, ext = split_ext(old_name.rsplit("/", 1)[-1])
    if ext and new == stem:
        if not is_editable(old_name):
            raise BadName(f"확장자({ext})를 떼면 이 파일을 열 수 없게 됩니다.")
        return new
    return f"{new}{ext}"


def kind_of(name: str) -> str:
    """'md' | 'text' | 'image' | 'pdf' | 'video' | 'audio' | 'other'."""
    # Path.suffix 가 아니라 split_ext 를 쓴다. `2026.08 회고` 를 suffix 로 보면
    # `.08 회고` 가 확장자가 되어 'other'(=편집 불가)로 떨어졌다.
    ext = split_ext(name)[1].lower()
    if ext in MARKDOWN:
        return "md"
    # .svg는 이미지이면서 텍스트지만, 보는 쪽이 자연스러우므로 이미지로 둔다.
    if ext in IMAGE:
        return "image"
    if ext in PDF:
        return "pdf"
    if ext in VIDEO:
        return "video"
    if ext in AUDIO:
        return "audio"
    if ext in TEXT or ext == "":
        return "text"
    return "other"


def is_editable(name: str) -> bool:
    """텍스트 편집기로 열 수 있는가(자동저장 대상)."""
    return kind_of(name) in ("md", "text")


def inline_media_type(name: str) -> str | None:
    """브라우저에 인라인으로 보여줄 수 있으면 그 MIME, 아니면 None(다운로드)."""
    return _MIME.get(split_ext(name)[1].lower())
