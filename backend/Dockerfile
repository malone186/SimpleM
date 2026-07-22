# SimpleM 백엔드 운영 이미지 (백엔드 B)
# OCR은 별도 llama.cpp 컨테이너(docker-compose.prod.yml의 ocr 서비스)가 담당하므로
# torch/transformers 없이 가볍게 유지한다 — OCR_BACKEND=llamacpp_vlm 전제.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUTF8=1

WORKDIR /srv/backend

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app
COPY alembic ./alembic
COPY alembic.ini .

# uploads(OCR 원본 저장)·data(chroma_db 등)는 컨테이너 재시작에도 남아야 하므로
# 런타임에는 compose가 호스트 볼륨으로 덮어 마운트한다.
RUN mkdir -p uploads data

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import httpx; httpx.get('http://localhost:8000/health', timeout=4).raise_for_status()"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
