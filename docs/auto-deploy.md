# 자동 배포 (push → Pi에서 재빌드)

`main`에 push하면 라즈베리파이에서 자동으로 최신 코드를 받아 컨테이너를 재빌드한다.
방식: **GitHub Actions 셀프호스티드 러너**. 러너가 Pi에서 GitHub로 아웃바운드 연결하므로
열린 포트나 웹훅이 필요 없다(Cloudflare Tunnel 뒤에서 동작).

동작 파일:
- `.github/workflows/deploy.yml` — push 시 실행되는 워크플로
- `scripts/deploy.sh` — 실제 배포 로직(수동/cron으로도 사용 가능)

---

## 1회 설정 (Pi에서)

### A. 셀프호스티드 러너 등록
GitHub 리포 → **Settings → Actions → Runners → New self-hosted runner** →
OS: **Linux**, Architecture: **ARM64** 선택. 표시되는 명령을 Pi에서 실행:

```bash
# 예시(실제 토큰/URL은 GitHub 페이지에서 복사)
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -o actions-runner.tar.gz -L https://github.com/actions/runner/releases/download/vX.Y.Z/actions-runner-linux-arm64-X.Y.Z.tar.gz
tar xzf actions-runner.tar.gz
./config.sh --url https://github.com/<owner>/<repo> --token <RUNNER_TOKEN>
```

`config.sh`가 물어보면 기본값(Enter)으로 진행해도 된다.

### B. 러너를 서비스로 등록(부팅 시 자동 실행)
```bash
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status   # 실행 확인
```

### C. 러너 사용자에 docker 권한 부여
러너가 `docker compose`를 쓸 수 있어야 한다(러너를 실행하는 사용자를 docker 그룹에):
```bash
sudo usermod -aG docker "$USER"
# 그룹 반영을 위해 러너 서비스 재시작
cd ~/actions-runner && sudo ./svc.sh stop && sudo ./svc.sh start
```

### D. 리포지토리 변수 DEPLOY_DIR 설정
GitHub 리포 → **Settings → Secrets and variables → Actions → Variables → New repository variable**:
- Name: `DEPLOY_DIR`
- Value: Pi에서 이 리포가 clone된 실제 경로(= `.env`와 `docker-compose.yml`이 있는 곳). 예: `/home/pi/twoems-server`

> 이 경로의 체크아웃이 **배포 대상**이다. 워크플로가 `git reset --hard origin/main`으로
> 원격과 강제 동기화하므로, 이 디렉터리는 배포 전용으로 두고 Pi에서 직접 커밋하지 말 것.
> `.env`는 gitignore라 reset의 영향을 받지 않는다.

---

## 사용

- `main`에 push → **Actions** 탭에 "Deploy to home server" 실행이 뜨고 Pi에서 재빌드된다.
- 수동 실행: Actions 탭 → 워크플로 → **Run workflow**.
- 프론트엔드는 이미지 빌드 단계에서 `npm run build`를 하므로 `dist`를 커밋할 필요 없다.

### 러너 없이 쓰는 경우(대안)
러너 대신 cron 폴링으로도 가능하다(GitHub 설정 불필요, 최대 폴링 주기만큼 지연):
```bash
# crontab -e
*/2 * * * * DEPLOY_DIR=/home/pi/twoems-server bash /home/pi/twoems-server/scripts/deploy.sh >> /home/pi/deploy.log 2>&1
```
단, cron은 커밋이 있을 때마다 매번 rebuild하므로, 변경 없을 때 스킵하려면 `git fetch` 후
`HEAD`와 `origin/main` 비교로 가드하는 로직을 추가하면 된다.

---

## 문제 해결
- 워크플로가 **queued**로 멈춤 → 러너가 온라인이 아님(`svc.sh status` 확인).
- `permission denied ... docker.sock` → 러너 사용자 docker 그룹 미반영(위 C 단계 재실행).
- `DEPLOY_DIR가 설정되지 않았습니다` → 리포지토리 변수 `DEPLOY_DIR` 누락(위 D 단계).
- 빌드는 됐는데 웹 반영 안 됨 → 브라우저 하드 리프레시(Ctrl+Shift+R).
