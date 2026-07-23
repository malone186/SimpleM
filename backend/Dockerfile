# SimpleM 백엔드 운영 이미지 (백엔드 B)
# OCR·챗봇·리포트가 모두 Gemini API 호출이라 torch/transformers 없이 가볍다.
# Cloud Run 배포 전제: PORT 환경변수로 리슨 포트를 받는다 (로컬 실행 시 8000).
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

# 법령/원두 RAG용 chroma_db(수 MB)는 이미지에 굽는다 — Cloud Run은 디스크가
# 휘발성이라 볼륨 마운트 대신 이미지 포함이 맞다. uploads(OCR 원본)는 휘발돼도
# 초안 자체는 DB(ocr_documents)에 있으므로 기능에 지장 없다.
COPY data ./data
RUN mkdir -p uploads

EXPOSE 8080

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
