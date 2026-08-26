"""선택적 Google Calendar 어댑터 (유저별).

각 유저의 `<username>_GOOGLE_*` 환경변수로 그 유저의 캘린더에 연결한다.
설정이 없거나 오류면 None → 내부 캘린더로 폴백. 유저별로 완전히 분리된다.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import date, timedelta

from .calendar_store import merge_event
from .config import Settings

logger = logging.getLogger("server.gcal")


def _shift_date(d: str, days: int) -> str:
    """'YYYY-MM-DD'에 일수를 더해 반환. 종일 일정 종료일 포함↔배타 변환용."""
    try:
        return (date.fromisoformat(d[:10]) + timedelta(days=days)).isoformat()
    except Exception:
        return d[:10]


def _read_maybe_file(value: str) -> str:
    if os.path.exists(value):
        with open(value, encoding="utf-8") as f:
            return f.read()
    return value


def _build_service(cfg: dict):
    """google-api-python-client 서비스 빌드. 실패 시 None."""
    try:
        from googleapiclient.discovery import build

        if cfg.get("service_account_json"):
            from google.oauth2 import service_account

            info = json.loads(_read_maybe_file(cfg["service_account_json"]))
            creds = service_account.Credentials.from_service_account_info(
                info, scopes=["https://www.googleapis.com/auth/calendar"]
            )
        elif cfg.get("client_id") and cfg.get("refresh_token"):
            from google.oauth2.credentials import Credentials

            creds = Credentials(
                token=None,
                refresh_token=cfg["refresh_token"],
                client_id=cfg["client_id"],
                client_secret=cfg.get("client_secret", ""),
                token_uri="https://oauth2.googleapis.com/token",
                scopes=["https://www.googleapis.com/auth/calendar"],
            )
        else:
            return None
        return build("calendar", "v3", credentials=creds, cache_discovery=False)
    except Exception as e:  # pragma: no cover - 외부 의존
        logger.warning("Google Calendar 초기화 실패, 내부 캘린더로 폴백: %s", e)
        return None


# 구글 캘린더 배치 권장 상한(한 요청에 50건)
_BATCH_SIZE = 50

_FREQ = {"daily": "DAILY", "weekly": "WEEKLY", "monthly": "MONTHLY", "yearly": "YEARLY"}
_FREQ_BACK = {v: k for k, v in _FREQ.items()}


def _rrule(p: dict) -> str | None:
    """내부 반복 모델 → Google RRULE. 반복 없으면 None."""
    freq = _FREQ.get(str(p.get("recurrence", "none")))
    if not freq:
        return None
    parts = [f"FREQ={freq}"]
    interval = int(p.get("interval", 1) or 1)
    if interval > 1:
        parts.append(f"INTERVAL={interval}")
    until = str(p.get("recur_until") or "")[:10]
    if until:
        try:
            d = date.fromisoformat(until)
        except ValueError:
            d = None
        if d:
            if p.get("allDay"):
                parts.append(f"UNTIL={d.strftime('%Y%m%d')}")
            else:
                # 내부 모델의 종료일은 KST 기준 '그날까지 포함'.
                # RRULE UNTIL은 UTC라 23:59:59+09:00 = 같은 날 14:59:59Z.
                parts.append(f"UNTIL={d.strftime('%Y%m%d')}T145959Z")
    return "RRULE:" + ";".join(parts)


def _from_rrule(rules) -> dict:
    """Google recurrence 배열 → 내부 반복 필드."""
    out = {"recurrence": "none", "interval": 1, "recur_until": ""}
    rule = next((r for r in (rules or []) if str(r).startswith("RRULE:")), "")
    if not rule:
        return out
    for token in rule[len("RRULE:"):].split(";"):
        key, _, val = token.partition("=")
        if key == "FREQ":
            out["recurrence"] = _FREQ_BACK.get(val, "none")
        elif key == "INTERVAL":
            out["interval"] = max(1, int(val)) if val.isdigit() else 1
        elif key == "UNTIL" and len(val) >= 8:
            out["recur_until"] = f"{val[0:4]}-{val[4:6]}-{val[6:8]}"
    return out


def _to_internal(g: dict) -> dict:
    start = g.get("start", {})
    end = g.get("end", {})
    all_day = "date" in start
    start_v = start.get("dateTime") or start.get("date") or ""
    end_v = end.get("dateTime") or end.get("date") or ""
    # 구글 종일 일정의 end.date는 '배타적'(마지막 날 +1) → 내부 모델은 '포함'으로 통일
    if all_day and end_v:
        end_v = _shift_date(end_v, -1)
    overrides = (g.get("reminders") or {}).get("overrides") or []
    return {
        "id": g.get("id", ""),
        "title": g.get("summary", ""),
        "description": g.get("description", ""),
        "start": start_v,
        "end": end_v,
        "allDay": all_day,
        "color": g.get("colorId", "2"),
        # 반복·알림도 되읽어야 부분 수정이 이 값들을 지우지 않는다.
        **_from_rrule(g.get("recurrence")),
        "remind_minutes": int(overrides[0].get("minutes", 0)) if overrides else 0,
    }


def _to_google(p: dict) -> dict:
    all_day = bool(p.get("allDay"))
    body: dict = {
        "summary": p.get("title", ""),
        "description": p.get("description", ""),
        "colorId": str(p.get("color", "2")),
    }
    if all_day:
        body["start"] = {"date": p["start"][:10]}
        # 내부 모델의 종료일은 '포함' → 구글엔 '배타적'(+1일)으로 보냄
        inc_end = (p.get("end") or p["start"])[:10]
        body["end"] = {"date": _shift_date(inc_end, 1)}
    else:
        body["start"] = {"dateTime": p["start"], "timeZone": "Asia/Seoul"}
        body["end"] = {"dateTime": p.get("end") or p["start"], "timeZone": "Asia/Seoul"}
    # 반복은 있을 때만 넣는다 — 반복 인스턴스를 patch할 때 recurrence 키가 있으면
    # Google이 거부하므로, 'none'이면 아예 건드리지 않는다.
    rule = _rrule(p)
    if rule:
        body["recurrence"] = [rule]
    # 알림도 설정됐을 때만 — 0을 보내면 캘린더 기본 알림까지 꺼버린다.
    remind = int(p.get("remind_minutes", 0) or 0)
    if remind > 0:
        body["reminders"] = {"useDefault": False, "overrides": [{"method": "popup", "minutes": remind}]}
    return body


class GoogleCalendar:
    def __init__(self, service, calendar_id: str):
        self._svc = service
        self._cid = calendar_id

    def list(self, frm: str | None, to: str | None) -> list[dict]:
        params = {
            "calendarId": self._cid,
            "singleEvents": True,
            "orderBy": "startTime",
            "maxResults": 500,
        }
        if frm:
            params["timeMin"] = _rfc3339(frm)
        if to:
            params["timeMax"] = _rfc3339(to, end=True)
        items = self._svc.events().list(**params).execute().get("items", [])
        return [_to_internal(g) for g in items]

    def create(self, payload: dict) -> dict:
        g = self._svc.events().insert(calendarId=self._cid, body=_to_google(payload)).execute()
        return _to_internal(g)

    def update(self, eid: str, payload: dict) -> dict:
        """부분 수정도 안전하게 — 기존 값을 읽어 병합한 뒤 전체 본문으로 보낸다.

        _to_google는 항상 전체 본문을 만들므로, 부분 payload를 그대로 넘기면
        제목·설명이 ''로 덮이고 색이 기본값으로 초기화되며 end가 start로 무너진다
        (제목만 주면 p["start"]에서 KeyError). 병합 규칙은 내부 저장소와 공유해
        두 백엔드가 같은 동작을 하게 한다.
        """
        from .calendar_store import merge_event

        current = _to_internal(self._svc.events().get(calendarId=self._cid, eventId=eid).execute())
        merged = merge_event(payload, current)
        g = self._svc.events().patch(calendarId=self._cid, eventId=eid, body=_to_google(merged)).execute()
        return _to_internal(g)

    def get(self, eid: str) -> dict:
        """일정 하나. 반복 인스턴스 id(`시리즈_20260305T100000Z`)도 그대로 받는다."""
        return _to_internal(
            self._svc.events().get(calendarId=self._cid, eventId=eid).execute()
        )

    def patch_many(self, items: list[tuple[str, dict, dict]]) -> tuple[list[str], list[tuple[str, str]]]:
        """여러 건을 한 번에 수정. items = [(eid, payload, current)].

        낱개 update()는 건마다 get + patch로 **왕복 2회**다. 78건이면 156회가 되어
        라즈베리파이에서 1분을 넘고, nginx가 응답을 끊는다(실제로 그렇게 실패했다).
        여기서는 (1) current를 이미 알고 있으므로 get을 생략하고,
        (2) 구글 배치 HTTP로 50건씩 묶어 요청 수를 왕복 2회 수준으로 줄인다.

        배치가 막히는 환경도 있으므로 실패하면 순차 patch로 자동 폴백한다.
        """
        ok: list[str] = []
        fail: list[tuple[str, str]] = []

        def _seq(chunk):
            for eid, payload, current in chunk:
                try:
                    body = _to_google(merge_event(payload, current))
                    self._svc.events().patch(calendarId=self._cid, eventId=eid, body=body).execute()
                    ok.append(eid)
                except Exception as e:  # noqa: BLE001
                    fail.append((eid, str(e)))

        for i in range(0, len(items), _BATCH_SIZE):
            chunk = items[i:i + _BATCH_SIZE]
            try:
                batch = self._svc.new_batch_http_request()
            except Exception:  # noqa: BLE001 - 배치 미지원
                _seq(chunk)
                continue

            def _cb(eid):  # 루프 변수를 그대로 닫으면 전부 마지막 id가 된다
                def done(_rid, _resp, err):
                    if err is None:
                        ok.append(eid)
                    else:
                        fail.append((eid, str(err)))
                return done

            try:
                for n, (eid, payload, current) in enumerate(chunk):
                    body = _to_google(merge_event(payload, current))
                    batch.add(
                        self._svc.events().patch(calendarId=self._cid, eventId=eid, body=body),
                        request_id=str(n),
                        callback=_cb(eid),
                    )
                batch.execute()
            except Exception as e:  # noqa: BLE001
                logger.warning("배치 수정 실패, 순차로 재시도: %s", e)
                done_ids = set(ok) | {f[0] for f in fail}
                _seq([c for c in chunk if c[0] not in done_ids])
        return ok, fail

    def delete_many(self, eids: list[str]) -> tuple[list[str], list[tuple[str, str]]]:
        """여러 건을 한 번에 삭제(배치, 실패 시 순차 폴백)."""
        ok: list[str] = []
        fail: list[tuple[str, str]] = []

        def _seq(chunk):
            for eid in chunk:
                try:
                    self._svc.events().delete(calendarId=self._cid, eventId=eid).execute()
                    ok.append(eid)
                except Exception as e:  # noqa: BLE001
                    fail.append((eid, str(e)))

        for i in range(0, len(eids), _BATCH_SIZE):
            chunk = eids[i:i + _BATCH_SIZE]
            try:
                batch = self._svc.new_batch_http_request()
            except Exception:  # noqa: BLE001
                _seq(chunk)
                continue

            def _cb(eid):
                def done(_rid, _resp, err):
                    if err is None:
                        ok.append(eid)
                    else:
                        fail.append((eid, str(err)))
                return done

            try:
                for n, eid in enumerate(chunk):
                    batch.add(
                        self._svc.events().delete(calendarId=self._cid, eventId=eid),
                        request_id=str(n),
                        callback=_cb(eid),
                    )
                batch.execute()
            except Exception as e:  # noqa: BLE001
                logger.warning("배치 삭제 실패, 순차로 재시도: %s", e)
                done_ids = set(ok) | {f[0] for f in fail}
                _seq([c for c in chunk if c not in done_ids])
        return ok, fail

    def delete(self, eid: str) -> None:
        self._svc.events().delete(calendarId=self._cid, eventId=eid).execute()


def _rfc3339(s: str, *, end: bool = False) -> str:
    """naive ISO를 timezone 포함 RFC3339로 (Google API용, KST 가정).

    end=True(조회 창의 종료 경계)이고 날짜만 주어지면 그날 23:59:59로 해석한다.
    자정으로 두면 timeMax=그날 00:00이 되어 당일 일정이 전부 빠진다.
    """
    s = s.strip()
    if s.endswith("Z") or "+" in s[10:]:
        return s
    if "T" not in s:
        s = f"{s}T23:59:59" if end else f"{s}T00:00:00"
    return s + "+09:00"


def get_google_calendar(settings: Settings, username: str) -> GoogleCalendar | None:
    """해당 유저의 Google Calendar. 미설정/오류면 None(내부 폴백)."""
    cfg = settings.google_config(username)
    if not cfg:
        return None
    svc = _build_service(cfg)
    if svc is None:
        return None
    return GoogleCalendar(svc, cfg.get("calendar_id", "primary"))
