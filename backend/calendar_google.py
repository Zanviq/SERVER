"""선택적 Google Calendar 어댑터 (유저별).

각 유저의 `<username>_GOOGLE_*` 환경변수로 그 유저의 캘린더에 연결한다.
설정이 없거나 오류면 None → 내부 캘린더로 폴백. 유저별로 완전히 분리된다.
"""
from __future__ import annotations

import json
import logging
import os

from .config import Settings

logger = logging.getLogger("twoems.gcal")


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


def _to_internal(g: dict) -> dict:
    start = g.get("start", {})
    end = g.get("end", {})
    all_day = "date" in start
    return {
        "id": g.get("id", ""),
        "title": g.get("summary", ""),
        "description": g.get("description", ""),
        "start": start.get("dateTime") or start.get("date") or "",
        "end": end.get("dateTime") or end.get("date") or "",
        "allDay": all_day,
        "color": g.get("colorId", "2"),
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
        body["end"] = {"date": (p.get("end") or p["start"])[:10]}
    else:
        body["start"] = {"dateTime": p["start"], "timeZone": "Asia/Seoul"}
        body["end"] = {"dateTime": p.get("end") or p["start"], "timeZone": "Asia/Seoul"}
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
            params["timeMax"] = _rfc3339(to)
        items = self._svc.events().list(**params).execute().get("items", [])
        return [_to_internal(g) for g in items]

    def create(self, payload: dict) -> dict:
        g = self._svc.events().insert(calendarId=self._cid, body=_to_google(payload)).execute()
        return _to_internal(g)

    def update(self, eid: str, payload: dict) -> dict:
        g = self._svc.events().patch(calendarId=self._cid, eventId=eid, body=_to_google(payload)).execute()
        return _to_internal(g)

    def delete(self, eid: str) -> None:
        self._svc.events().delete(calendarId=self._cid, eventId=eid).execute()


def _rfc3339(s: str) -> str:
    """naive ISO를 timezone 포함 RFC3339로 (Google API용, KST 가정)."""
    s = s.strip()
    if s.endswith("Z") or "+" in s[10:]:
        return s
    if "T" not in s:
        s = f"{s}T00:00:00"
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
