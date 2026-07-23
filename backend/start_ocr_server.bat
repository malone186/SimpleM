@echo off
rem OCR llama-server 기동 (Render의 OCR 요청이 Funnel :8443 -> 이 서버로 온다)
rem 시작프로그램 등록: Win+R -> shell:startup -> 이 파일의 바로가기 넣기
rem API 키는 .env의 LLAMACPP_API_KEY를 읽는다 (커밋 금지 값이라 여기 하드코딩하지 않음)
cd /d C:\Users\USER\Desktop\final\backend
for /f "tokens=1,* delims==" %%a in ('findstr /b "LLAMACPP_API_KEY=" .env') do set "OCR_KEY=%%b"
vlm_finetune\tools_bin\llama-server.exe -m vlm_finetune\output\qwen35-2b-ocr-q8.gguf --mmproj vlm_finetune\output\mmproj-qwen35-2b.gguf -ngl 99 --port 8089 --ctx-size 8192 --api-key %OCR_KEY%
