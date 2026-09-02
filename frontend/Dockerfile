# --- 빌드 단계 ---
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci || npm install
COPY . .
RUN npm run build

# --- 설정 문법 검사 단계 ---
# 잘못된 nginx 설정이 배포되면 컨테이너가 재시작만 반복하고 사이트가 내려간다.
# 그래서 빌드에서 막는다. 다만 `nginx -t`를 그대로 돌리면 **항상 실패한다** —
# proxy_pass 의 호스트명(backend·terminal)은 설정을 읽는 시점에 해석되는데 빌드
# 네트워크에는 compose 서비스명을 풀어 줄 도커 내부 DNS가 없기 때문이다
# ("host not found in upstream"). 상류만 숫자 주소로 바꿔 검사한다 — 보려는 것은
# 문법이지 연결이 아니다.
#
# 실제로 배포되는 이미지는 아래 서빙 단계이고 이 단계의 수정본은 버려진다.
FROM nginx:1.27-alpine AS confcheck
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
RUN sed -i -e 's|http://backend:8000|http://127.0.0.1:8000|' \
           -e 's|http://terminal:7681|http://127.0.0.1:7681|' \
        /etc/nginx/conf.d/default.conf \
 && nginx -t \
 && touch /conf-ok

# --- 서빙 단계 (nginx, ARM64 호환) ---
FROM nginx:1.27-alpine
# 검사 단계 산출물을 가져와 의존을 만든다. 이 줄이 없으면 BuildKit 이 위 단계를
# "아무도 안 쓴다"고 보고 통째로 건너뛰어 검사가 돌지 않는다.
COPY --from=confcheck /conf-ok /conf-ok
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
