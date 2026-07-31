# Git 훅 (팀 공용)

main 빌드가 깨진 채 올라가는 사고를 막기 위한 훅입니다.

- **pre-commit** — 병합 충돌 마커(`<<<<<<<` / `=======` / `>>>>>>>`)가 남은 채 커밋되는 것을 차단 (빠름)
- **pre-push** — push 전에 프론트 타입체크(`tsc --noEmit`)를 돌려 빌드가 깨진 코드가 main에 올라가는 것을 차단

## 활성화 (각자 한 번만)

클론한 저장소에서 아래 한 줄을 실행하세요:

```sh
git config core.hooksPath .githooks
```

이후로는 커밋·푸시할 때 자동으로 검사가 돕니다. (훅은 저장소에 커밋돼 있어 별도 설치가 필요 없습니다.)

## 우회 (긴급 시에만)

```sh
git commit --no-verify   # pre-commit 건너뛰기
git push   --no-verify   # pre-push 건너뛰기
```

## 참고

- pre-push의 타입체크는 `frontend/node_modules`가 있어야 돕니다. 없으면 경고만 내고 통과하니 `npm install`을 먼저 해두세요.
- 더 강한 팀 차원 방어가 필요하면 GitHub Actions(push 시 tsc/컴파일 검사) 도입을 권장합니다.
