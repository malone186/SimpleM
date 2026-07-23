# 파인튜닝 Qwen VLM OCR — 평가 지표 아카이브

2026-07 OCR 백엔드를 Gemini API로 전환하면서, 파인튜닝했던 Qwen 0.8B/2B의
평가 결과를 여기에 보존한다 (원본은 gitignore된 `output/`에 있었음).
GGUF·병합 체크포인트·llama.cpp 도구는 삭제했고, **LoRA 어댑터**(`output/adapter35*`,
`output/adapter2b`)와 학습 스크립트는 남겨 두어 필요하면 재수출할 수 있다.

## 최종 비교 (실영수증 평가셋, RTX 5060)

| 모델 | 파일 | parsed | 품목수 | name F1 | full recall | 속도/장 |
|---|---|---|---|---|---|---|
| **Qwen3-VL-2B Q4 @1024** | `eval_2b_q4_1024.json` | 0.969 | 0.869 | **0.666** | 0.634 | 4.6s |
| Qwen3-VL-2B Q8 | `eval_2b_gguf.json` | 0.962 | 0.854 | 0.648 | 0.627 | 5.0s |
| Qwen3.5-0.8B v2 Q8 | `eval35_ft_v2.json` | 0.931 | 0.831 | 0.500 | 0.493 | 3.8s |
| Qwen3.5-0.8B v1 Q8 | `eval35_llamacpp.json` | 0.831 | 0.731 | 0.256 | — | 3.4s |
| Qwen3.5-0.8B base (파인튜닝 전) | `eval35_base.json` | 베이스라인 | | | | |

- 지표 정의: parsed=JSON 파싱 성공률, 품목수=item_count_acc, name F1=품목명 정밀도/재현율 조화평균,
  full recall=모든 필드(수량·단가·금액 포함) 일치 재현율.
- 속도 벤치: `bench_llamacpp_clean.json` (0.8B Q8: 1024px 웜 3.35s/장, 43 tok/s).
- 합성데이터 초기 평가(`eval_report*.json`)와 하드케이스 정성 테스트(`hard_test_results.txt`) 포함.

## 결론

- 2B가 정확도에서 확실히 우세(name F1 0.67 vs 0.50), 0.8B는 속도 우위(3.4~3.8s).
- 둘 다 로컬 GPU 서빙이 전제라 클라우드(Cloud Run) 이전이 불가능해
  **Gemini API로 전환** — 서빙 인프라 없이 정확도도 상회.
