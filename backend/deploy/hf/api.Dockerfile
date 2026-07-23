# SimpleM API — Hugging Face Space(Docker)용 이미지
# 기존 backend/Dockerfile과 동일 구성에서 포트만 7860(HF 기본)으로 바꾸고,
# 법령 RAG 인덱스(data/chroma_db, 704KB)를 이미지에 포함한다.
# HF Space는 비루트(uid 1000)로 실행되므로 쓰기 디렉토리 권한을 열어둔다.
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
COPY data ./data

# uploads(OCR 원본)는 HF 무료 티어에선 휘발성 — 재시작 시 사라진다 (문서 데이터 자체는 Neon DB에 있음)
RUN mkdir -p uploads && chmod -R 777 uploads data

EXPOSE 7860

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860"]
