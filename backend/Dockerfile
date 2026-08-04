# SimpleM 백엔드 운영 이미지 (백엔드 B)
# OCR·챗봇·리포트가 모두 Gemini API 호출이라 torch/transformers 없이 가볍다.
# Cloud Run 배포 전제: PORT 환경변수로 리슨 포트를 받는다 (로컬 실행 시 8000).
FROM python:3.12-slim

# TZ: 컨테이너 기본값은 UTC라, date.today()/datetime.now()가 한국 날짜보다 9시간
# 뒤처진다 — 자정~오전 9시(KST) 사이에는 '오늘'이 어제로 계산된다. 아침 브리핑·
# 리포트·정산 입금일·예측이 전부 이 시간대에 돌아가므로 실제로 하루가 밀린다.
# 코드는 로컬 시간대 = KST를 전제로 쓰여 있고(insight_service._now,
# _aware의 "naive는 현지 시간대로 간주"), 팀원 PC와 테스트는 KST라 여기서만 어긋났다.
# 명시적으로 UTC를 쓰는 곳(datetime_kst.utc_now, func.now())은 이 값에 영향받지 않는다.
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUTF8=1 \
    TZ=Asia/Seoul

WORKDIR /srv/backend

# 홍보 이미지에 한글 슬로건을 합성할 때 쓰는 폰트 (Pillow는 폰트 파일이 있어야 한글을 그린다).
# 없으면 슬로건 없는 이미지만 나가므로 배포 이미지에는 반드시 포함한다 (~5MB).
# tzdata: slim 이미지엔 zoneinfo가 없을 수 있고, 그러면 위 TZ=Asia/Seoul이 조용히
# 무시돼 UTC로 남는다 — 고쳤다고 믿는 채로 그대로인 게 제일 위험해서 명시 설치한다.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-nanum tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

# 실물 사진 누끼(rembg) 모델을 이미지에 미리 굽는다 — 요청 시점 다운로드(콜드 스타트
# 수십 초)를 없앤다. u2netp는 ~5MB라 이미지 크기 부담이 없다.
RUN python -c "from rembg import new_session; new_session('u2netp')" 

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
