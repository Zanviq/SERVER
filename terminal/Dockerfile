FROM python:3.11-slim

# nsenter(util-linux) + bash: 호스트 셸 진입에 필요
RUN apt-get update \
    && apt-get install -y --no-install-recommends util-linux bash \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "websockets==12.0" "itsdangerous>=2.1,<3"

WORKDIR /app
COPY server.py revoked.py .

EXPOSE 7681
CMD ["python", "server.py"]
