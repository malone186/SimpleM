"""챗봇 답변 품질 평가 (백엔드 B)

pytest가 아니다. 여기 있는 러너는 실제 Gemini를 호출해 대화 한 턴을 통째로 돌린다 —
느리고 무료 한도를 쓰므로 CI가 아니라 배포 전에 손으로 돌린다.

    python -m evals.run_golden

자세한 사용법은 evals/README.md.
"""
