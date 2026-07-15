#!/usr/bin/env bash
# 홈서버 배포 스크립트 — 최신 main으로 맞추고 컨테이너를 재빌드한다.
#
# 수동 실행:   bash scripts/deploy.sh
# 다른 경로:   DEPLOY_DIR=/home/pi/twoems-server bash scripts/deploy.sh
# 프로파일:    COMPOSE_PROFILES=tunnel,terminal bash scripts/deploy.sh
#
# GitHub Actions 워크플로(.github/workflows/deploy.yml)와 동일한 동작을 하므로
# cron 폴링 방식으로 쓰거나(예: */2 * * * * DEPLOY_DIR=... bash .../deploy.sh),
# 러너 없이 수동 배포용으로도 쓸 수 있다.
set -euo pipefail

DIR="${DEPLOY_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
PROFILE="${COMPOSE_PROFILES:-tunnel}"
cd "$DIR"

echo "▶ 최신 main으로 맞추기: $DIR (.env는 gitignore라 보존됨)"
git fetch --prune origin
git reset --hard origin/main

echo "▶ 컨테이너 재빌드 (profile: $PROFILE)"
docker compose --profile "$PROFILE" up -d --build

echo "▶ 미사용(dangling) 이미지 정리"
docker image prune -f
echo "✅ 배포 완료: $(git rev-parse --short HEAD)"
