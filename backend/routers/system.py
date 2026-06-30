"""시스템 모니터링 API: CPU·RAM·온도·디스크."""
from __future__ import annotations

import os
import time

import psutil

from fastapi import APIRouter

from ..config import get_settings
from ..schemas import SystemStats

router = APIRouter(prefix="/api/system", tags=["system"])


def _cpu_temperature() -> float | None:
    """CPU 온도(℃). 라즈베리파이/리눅스에서만 동작, 없으면 None."""
    if not hasattr(psutil, "sensors_temperatures"):
        return None
    try:
        temps = psutil.sensors_temperatures()
    except Exception:
        return None

    # 라즈베리파이는 'cpu_thermal', 일반 x86은 'coretemp' 등.
    for key in ("cpu_thermal", "coretemp", "k10temp", "acpitz"):
        if key in temps and temps[key]:
            return float(temps[key][0].current)

    # 키 모르면 첫 센서 사용.
    for readings in temps.values():
        if readings:
            return float(readings[0].current)
    return None


@router.get("", response_model=SystemStats)
@router.get("/", response_model=SystemStats)
def system_stats():
    """현재 시스템 상태 스냅샷."""
    settings = get_settings()

    vm = psutil.virtual_memory()
    # 디스크 사용량은 사용자 파일 저장소(HDD) 기준.
    disk_path = settings.storage_root if settings.storage_root.exists() else "/"
    du = psutil.disk_usage(str(disk_path))

    try:
        load_avg = list(os.getloadavg())
    except (OSError, AttributeError):
        load_avg = None  # Windows 미지원

    return SystemStats(
        cpu_percent=psutil.cpu_percent(interval=0.1),
        cpu_count=psutil.cpu_count(logical=True) or 0,
        mem_total=vm.total,
        mem_used=vm.used,
        mem_percent=vm.percent,
        disk_total=du.total,
        disk_used=du.used,
        disk_percent=du.percent,
        temperature_c=_cpu_temperature(),
        uptime_seconds=time.time() - psutil.boot_time(),
        load_avg=load_avg,
    )
