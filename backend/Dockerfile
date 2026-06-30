# ARM64 (라즈베리파이 5) 호환 슬림 이미지
FROM python:3.11-slim

WORKDIR /app

# 의존성 먼저 설치 (레이어 캐시 활용)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 앱 소스 복사 (backend 패키지로 마운트)
COPY . /app/backend

EXPOSE 8000

# backend.main:app 형태로 패키지 임포트 (상대 import 동작)
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
