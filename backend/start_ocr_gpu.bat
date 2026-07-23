@echo off
REM SimpleM 하이브리드 OCR — PC GPU llama-server 기동 (장당 ~3초)
REM 백엔드가 HF Spaces에 있어도, 이 서버가 켜져 있으면 OCR 요청이 이쪽(GPU)으로 온다.
REM .env의 LLAMACPP_MODEL_GGUF / LLAMACPP_MMPROJ_GGUF / LLAMACPP_API_KEY 값을 그대로 사용.
cd /d %~dp0

for /f "tokens=1,* delims==" %%a in ('findstr /b "LLAMACPP_MODEL_GGUF=" .env') do set MODEL=%%b
for /f "tokens=1,* delims==" %%a in ('findstr /b "LLAMACPP_MMPROJ_GGUF=" .env') do set MMPROJ=%%b
for /f "tokens=1,* delims==" %%a in ('findstr /b "LLAMACPP_API_KEY=" .env') do set APIKEY=%%b

if "%MODEL%"=="" echo [오류] .env에 LLAMACPP_MODEL_GGUF가 없습니다 && pause && exit /b 1
if "%APIKEY%"=="" echo [오류] .env에 LLAMACPP_API_KEY가 없습니다 (외부 노출 보호용 필수) && pause && exit /b 1

echo GPU OCR 서버 시작 — 포트 8089 (모델: %MODEL%)
vlm_finetune\tools_bin\llama-server.exe -m "%MODEL%" --mmproj "%MMPROJ%" -ngl 99 --port 8089 --ctx-size 8192 --api-key %APIKEY%
pause
