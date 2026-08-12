# 파인튜닝 Qwen VLM OCR — 평가 지표 아카이브

2026-07 OCR 백엔드를 Gemini API로 전환하면서, 파인튜닝했던 Qwen 0.8B/2B의
평가 결과를 여기에 보존한다 (원본은 gitignore된 `output/`에 있었음).
GGUF·병합 체크포인트·llama.cpp 도구는 삭제했고, **LoRA 어댑터**(`output/adapter35*`,
`output/adapter2b`)와 학습 스크립트는 남겨 두어 필요하면 재수출할 수 있다.

## 최종 비교 (실영수증 130장, RTX 5060)

아래 수치는 전부 각 JSON의 `summary` 블록을 그대로 옮긴 것이다 (2026-08-12 재검증).

| 모델 | 실행 방식 | 파일 | parsed | 품목수 | name F1 | full recall | 속도/장 |
|---|---|---|---|---|---|---|---|
| **Qwen3-VL-2B Q4 @1024** | llama.cpp | `eval_2b_q4_1024.json` | 0.969 | 0.869 | **0.666** | 0.634 | 4.62s |
| Qwen3-VL-2B Q8 | llama.cpp | `eval_2b_gguf.json` | 0.962 | 0.854 | 0.648 | 0.627 | 4.97s |
| Qwen3.5-0.8B v2 | llama.cpp Q8 | `eval35_llamacpp.json` | 0.931 | 0.831 | 0.500 | 0.493 | **3.80s** |
| Qwen3.5-0.8B v2 | transformers bf16 | `eval35_ft_v2.json` | 0.931 | 0.854 | 0.508 | 0.494 | 10.55s |
| Qwen3.5-0.8B v1 | transformers bf16 | `eval35_ft.json` | 0.885 | 0.823 | 0.295 | 0.284 | 13.07s |
| Qwen3.5-0.8B v1 | llama.cpp Q8 | (로그만) | 0.831 | 0.731 | 0.256 | 0.246 | 3.89s |
| Qwen3.5-0.8B base (파인튜닝 전) | transformers bf16 | `eval35_base.json` | 0.354 | 0.154 | 0.028 | 0.000 | 29.01s |

> ⚠️ **v1 llama.cpp 결과 파일은 없다.** `eval_llamacpp.py`가 실행마다 같은 경로
> (`eval35_llamacpp.json`)에 덮어써서, v1 수치는 `eval_llamacpp_log.txt`에만 남아 있다.
> 위 표의 v1 llama.cpp 행은 그 로그에서 옮긴 값이다.
> (2026-08-12 이전 판 이 표는 v2 llama.cpp 수치를 `eval35_ft_v2.json` 행에 적고
>  그 파일을 v1로 표기해, 파일과 숫자가 서로 어긋나 있었다.)

- 지표 정의: parsed=JSON 파싱 성공률, 품목수=item_count_acc(품목 개수 완전 일치),
  name F1=품목명 정밀도/재현율 조화평균, full recall=품목명+수량+금액이 모두 맞은 재현율.
  품목명 판정은 공백 제거·소문자화 후 **완전 일치**다 (편집거리/CER은 계산하지 않는다).
- 속도 벤치: `bench_llamacpp_clean.json` (0.8B Q8 1024px: 콜드 4.63s, 웜 평균 3.35s, 43.3 tok/s).
  같은 모델의 평가 속도(3.80s)와 다른 이유는 평가가 콜드 로드를 포함하기 때문.
- 합성데이터 초기 평가는 `eval_report*.json` (필드 정확도: 총액 1.000 / 발행일 1.000 /
  부가세 0.933 / 문서종류 0.900, n=60). 합성 데이터는 실영수증보다 훨씬 쉬워서
  품목 재현율이 0.94 대 0.66으로 벌어진다 — 두 수치를 섞어 인용하지 말 것.
- 하드케이스 정성 테스트는 `hard_test_results.txt` (점수 없음, 원본 JSON 덤프만).

## 왜 0.8B에서 2B로 갔나

가장 가벼운 것부터 시작하는 게 로컬 서빙 전제에 맞았다. Qwen3.5-0.8B는 파인튜닝으로
name F1 0.03 → 0.50까지 올라 **학습 자체는 확실히 먹혔지만**, 원가 장부에 들어갈
숫자로 쓰기엔 0.50이 부족했다. 그래서 모델을 키워 Qwen3-VL-2B를 다시 학습해
**0.67**까지 끌어올렸다 (속도는 3.8s → 4.6s로 소폭 손해).

## 결론

- 2B가 정확도에서 확실히 우세(name F1 0.67 vs 0.50), 0.8B는 속도 우위(3.8s).
- 그러나 **둘 다 로컬 GPU 서빙이 전제**라 Cloud Run 이전이 불가능했고,
  정확도도 Gemini API가 상회했다 → **Gemini API로 전환** (운영 현재 상태).
- 재현·재계산: `eval35_*.json`은 `detail`에 이미지별 `pred`/`gt`를 그대로 갖고 있어
  CER·영수증 단위 정확도 같은 새 지표를 **모델 재실행 없이** 계산할 수 있다.
  단 `eval_2b_*.json`은 점수만 있고 pred/gt가 없어 2B 재채점은 GPU 재실행이 필요하다.
