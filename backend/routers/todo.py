"""Todo API — 개인 스코프 전용(구글 동기화 없음).

캘린더 라우터와 같은 규칙으로 시각을 검증한다(../datetimes). 여기만 느슨하면
"todo는 저장됐는데 캘린더에 안 보인다"가 된다.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, field_validator

from .. import todo_store
from ..auth import SessionUser, require_session
from ..config import Settings, get_settings
from ..datetimes import BadDateTime
from ..datetimes import has_time as dt_has_time
from ..datetimes import to_iso as dt_to_iso

router = APIRouter(prefix="/api/todo", tags=["todo"])


def _check_due(v):
    if v in (None, ""):
        return v
    try:
        return dt_to_iso(v, field="마감", date_only=not dt_has_time(v))
    except BadDateTime as e:
        raise ValueError(str(e)) from e


class CategoryInput(BaseModel):
    name: str
    color: str | None = None
    parent_id: str | None = None
    order: int | None = None


class CategoryPatch(BaseModel):
    name: str | None = None
    color: str | None = None
    parent_id: str | None = None
    order: int | None = None


class TodoInput(BaseModel):
    title: str
    description: str = ""
    category_id: str = ""
    due: str = ""
    # **기본값을 False 로 두면 안 된다.** 그러면 payload 에 always all_day 가 실려서
    # 저장소가 마감 표기로 종일 여부를 판단하는 길이 막힌다 — `2026-09-05` 처럼
    # 날짜만 준 마감이 종일이 아닌 것으로 저장돼 캘린더에 0시 일정으로 뜬다.
    # 수정(TodoUpdate)은 이미 None 이 기본이다. 생성도 같게 맞춘다.
    all_day: bool | None = None
    color: str = ""
    done: bool = False
    order: int | None = None

    @field_validator("due")
    @classmethod
    def _due(cls, v):
        return _check_due(v)


class TodoPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    category_id: str | None = None
    due: str | None = None
    all_day: bool | None = None
    color: str | None = None
    done: bool | None = None
    order: int | None = None

    @field_validator("due")
    @classmethod
    def _due(cls, v):
        return _check_due(v)


# ── 카테고리 ─────────────────────────────────────────────────────────

@router.get("/categories")
def categories(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return todo_store.list_categories(user, settings)


@router.post("/categories")
def category_create(
    req: CategoryInput,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return todo_store.create_category(user, settings, req.model_dump(exclude_none=True))


@router.put("/categories/{cid}")
def category_update(
    cid: str,
    req: CategoryPatch,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    # parent_id 는 ""(최상위로 올리기)도 뜻이 있으므로 exclude_none 만 쓴다
    return todo_store.update_category(user, settings, cid, req.model_dump(exclude_none=True))


@router.delete("/categories/{cid}")
def category_delete(
    cid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return todo_store.delete_category(user, settings, cid)


# ── 할 일 ────────────────────────────────────────────────────────────

@router.get("/list")
def todos(
    category_id: str | None = Query(None, description="생략하면 전체"),
    include_done: bool = Query(True),
    frm: str = Query("", alias="from"),
    to: str = Query(""),
    include_undated: bool = Query(True),
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return todo_store.list_todos(
        user, settings,
        category_id=category_id,
        include_done=include_done,
        frm=frm, to=to,
        include_undated=include_undated,
    )


@router.get("/board")
def board(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    """할 일 화면이 처음에 필요한 전부(카테고리+할 일+개수)를 한 번에.

    셋을 따로 부르면 같은 파일을 세 번 읽는다.
    """
    return todo_store.board(user, settings)


@router.get("/counts")
def todo_counts(
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return todo_store.counts(user, settings)


@router.post("/create")
def todo_create(
    req: TodoInput,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return todo_store.create_todo(user, settings, req.model_dump())


@router.put("/{tid}")
def todo_update(
    tid: str,
    req: TodoPatch,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return todo_store.update_todo(user, settings, tid, req.model_dump(exclude_none=True))


@router.delete("/{tid}")
def todo_delete(
    tid: str,
    user: SessionUser = Depends(require_session),
    settings: Settings = Depends(get_settings),
):
    return todo_store.delete_todo(user, settings, tid)
