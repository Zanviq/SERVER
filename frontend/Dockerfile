# --- 빌드 단계 ---
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci || npm install
COPY . .
RUN npm run build

# --- 서빙 단계 (nginx, ARM64 호환) ---
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
# 설정이 틀렸으면 여기서 빌드를 세운다. 이게 없으면 잘못된 설정이 그대로
# 배포되어 컨테이너가 재시작만 반복하고 사이트가 내려간다 — 빌드에서 막으면
# 돌던 컨테이너가 그대로 살아 있다.
RUN nginx -t
EXPOSE 80
