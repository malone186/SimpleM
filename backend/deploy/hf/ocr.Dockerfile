# SimpleM OCR — Hugging Face Space(Docker)용 llama.cpp 서버
# 파인튜닝 Qwen3.5-2B GGUF를 HF 모델 저장소에서 빌드 시 내려받아 CPU 서빙한다.
# Q4_K_M: 2 vCPU에서 Q8 대비 ~1.6배 빠르고 정확도 동일 (eval_2b_q4_1024.json: F1 0.666 ≥ Q8 0.648).
# <HF아이디>를 본인 Hugging Face 아이디로 바꿀 것 (모델 repo: simplem-ocr-gguf, public).
FROM ghcr.io/ggml-org/llama.cpp:server

ADD --chmod=444 https://huggingface.co/<HF아이디>/simplem-ocr-gguf/resolve/main/qwen35-2b-ocr-q4km.gguf /models/model.gguf
ADD --chmod=444 https://huggingface.co/<HF아이디>/simplem-ocr-gguf/resolve/main/mmproj-qwen35-2b.gguf /models/mmproj.gguf

EXPOSE 7860

# LLAMA_API_KEY는 Space Settings > Secrets에 넣으면 무단 사용이 차단된다 (api Space의 LLAMACPP_API_KEY와 같은 값).
# 비워두면 인증 없이 동작한다.
ENTRYPOINT []
CMD ["/bin/sh", "-c", "/app/llama-server -m /models/model.gguf --mmproj /models/mmproj.gguf --host 0.0.0.0 --port 7860 -c 8192 ${LLAMA_API_KEY:+--api-key $LLAMA_API_KEY}"]
