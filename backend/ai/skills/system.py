"""시스템 상태 스킬."""
from __future__ import annotations

import time

import psutil

from ..skill_base import SkillBase, SkillResult


class GetSystemStatus(SkillBase):
    name = "get_system_status"
    description = "서버의 CPU·메모리·디스크·가동시간 상태를 조회한다."
    parameters = {"type": "object", "properties": {}}

    def run(self, args, ctx):
        # /api/system은 주인 전용인데 이 스킬로 같은 값이 새어나가면 의미가 없다.
        if not ctx.user.is_owner:
            return SkillResult(
                ok=False,
                message="서버 상태는 관리자만 조회할 수 있습니다.",
                error_code="forbidden",
            )
        vm = psutil.virtual_memory()
        root = ctx.settings.storage_root
        du = psutil.disk_usage(str(root if root.exists() else "/"))
        gib = 1024 ** 3
        data = {
            "cpu_percent": psutil.cpu_percent(interval=0.1),
            "cpu_count": psutil.cpu_count(logical=True),
            "mem_percent": vm.percent,
            "mem_used_gb": round(vm.used / gib, 1),
            "mem_total_gb": round(vm.total / gib, 1),
            "disk_percent": du.percent,
            "disk_used_gb": round(du.used / gib, 1),
            "disk_total_gb": round(du.total / gib, 1),
            "uptime_hours": round((time.time() - psutil.boot_time()) / 3600, 1),
        }
        return SkillResult(ok=True, message="시스템 상태", data=data)
