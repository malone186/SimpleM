# 마스코트 모션 생성 프롬프트

`bake_mascot.py` 머리말이 가리키는 AI 생성 파이프라인의 **첫 단계(영상 생성)에 넣는 프롬프트**를 여기에 적어 둔다.

지금까지 wave·dance·bad 모션의 프롬프트는 Hailuo 웹 UI에 손으로 입력하고 저장소에는 남기지 않았다.
스크립트가 세션과 함께 날아갔던 것과 똑같은 공백이라, 같은 모션을 다시 뽑거나 조금 고쳐 뽑으려면
처음부터 다시 써야 한다. 새 모션을 만들 때는 여기에 프롬프트를 먼저 적고 생성한다.

---

## 파이프라인이 프롬프트에 거는 제약

프롬프트를 쓰기 전에 이 네 가지는 고정이다. 어기면 뒤 단계가 조용히 망가진다.

| 제약 | 왜 |
|---|---|
| **카메라 완전 고정** | `loop`의 크롭은 사이클 전체 알파의 합집합 bbox 하나를 쓴다. 카메라가 움직이면 캐릭터가 캔버스 안에서 흔들린다 |
| **순백 배경, 물체 없음** | `frames`의 rembg(`isnet-anime`)가 누끼를 딴다. 배경에 그림자·소품이 있으면 경계가 프레임마다 흔들려 재생 시 지글거린다 |
| **전신이 항상 화면 안** | 팔다리가 프레임 밖으로 나가면 그 프레임은 잘린 채로 굳는다. `pad --ratio 0.25`로 여백을 미리 주지만 동작이 그보다 크면 소용없다 |
| **시작 포즈 = 끝 포즈** | `loop`가 `seam / motion` 점수로 사이클을 찾는다. 처음과 끝이 같은 포즈여야 이음새 없는 20프레임이 나온다 |

**길이**: 재생은 20프레임 · 11fps = **약 1.8초 루프**다. 5초짜리 안무를 통째로 한 모션에 담을 수 없다.
동작 한 프레이즈(8박 한 소절)를 1.8초에 맞춰 만들고, 더 필요하면 모션을 나눠 여러 개 굽는다.

---

## 참고한 영상 — 김종국 '사랑스러워' 챌린지 (거울모드)

출처: <https://www.youtube.com/shorts/H45TQk7WZXA> (@fastdance.official)
분석 방법: 0.0~5.0초 구간을 0.2~0.4초 간격으로 정지 프레임 캡처해 포즈를 읽었다.
프레임 단위 추적이 아니라 샘플링이므로, 아래 타임코드는 ±0.2초 정도의 근사다.

### 동작 분해 (첫 5초)

| 시각 | 동작 |
|---|---|
| 0.0–1.0 | 인트로. 발은 어깨너비, 팔은 자연스럽게 내린 기본자세로 노래를 따라 부르며 가볍게 바운스 |
| ~1.2 | **준비 스윙** — 두 팔을 몸 옆으로 빠르게 벌리고 무릎을 굽혀 첫 바운스 |
| 1.4–1.7 | **A. 무릎 조이고 비틀기** — 한쪽 무릎을 안으로 접고 발끝을 세워 허리를 살짝 비튼다. 팔꿈치를 굽힌 두 팔을 한쪽으로 쓸어 넘김, 손목은 힘을 뺀 상태 |
| 1.9–2.1 | **B. 제자리 조깅** — 두 주먹을 가슴 앞에 가볍게 들고 한 다리를 뒤로 접어 찬다. 몸통은 세운 채 통통 튄다 |
| ~2.2 | 뒤로 찼던 다리를 옆으로 크게 스윙 (A→C 전환) |
| 2.3–2.5 | **C. 옆 런지 + 팔 뻗기** — 다리를 옆으로 크게 벌려 런지, 상체는 반대쪽으로 기울이고 두 팔을 나란히 한쪽으로 뻗는다 (손바닥 아래) |
| 2.7–2.9 | **A′. 발 모으고 무릎 조이기** — 두 발을 모아 무릎을 안쪽으로 붙인 자세. 한 팔은 옆으로 뻗고 다른 팔은 가슴 앞을 가로지른다 |
| 3.1–3.3 | **B 반복** |
| 3.5–3.7 | **C 반복** |
| 3.9–4.1 | **D. 얼굴 옆 손** — 발을 모으고 두 손을 얼굴 옆으로 올린다. 한 팔이 가슴 앞을 가로질러 손이 반대쪽 뺨 근처 |
| 4.3–4.5 | **E. 하트 준비** — 팔꿈치를 옆구리에 붙이고 가슴 앞에서 손가락을 모은다 |
| 4.7–5.0 | **F. 마무리** — 가슴 높이에서 양손 손가락 하트, 고개를 기울이고 한쪽 눈 윙크 |

구조는 `기본 → [A–B–C] × 2 → D → E → F`. 반복되는 **A–B–C(약 1.2초)가 루프 후보**고,
**D–E–F는 한 번만 나오는 마무리**라 별도 모션으로 굽는 게 맞다.

> 원곡·원본 영상을 그대로 복제하는 게 목적이 아니다. 챌린지 동작의 결을 브루에게 옮기는 것이므로,
> 프레임 단위로 베끼지 말고 캐릭터 비율에 맞게 각색한다. 음원은 쓰지 않는다.

---

## 프롬프트 1 — `dance_love` (반복 프레이즈 A–B–C, 루프용)

영어가 결과가 안정적이다. 한글 버전은 아래에 같이 둔다.

```text
The character from the reference image — keep its exact design, proportions and colors —
dances one cheerful K-pop challenge phrase in place.

Camera is locked off: no pan, no zoom, no tilt. Full body stays inside the frame at all times.
Pure white empty background, no props, no shadows on the wall, no text.
2D cartoon, flat cel shading, clean consistent line art, same style as the reference image.

Motion in order, about 1.8 seconds total:
1. From a relaxed standing pose, both arms swing outward to the sides as the knees dip once.
2. Knees pinch inward, one heel lifts onto the toe, hips twist slightly, and both bent arms
   sweep across to one side with loose relaxed hands.
3. A light bouncy jog in place: both hands in soft loose fists at chest height, one leg
   folding up behind.
4. That leg swings out wide and lands in a wide side lunge; the torso leans the opposite way
   while both arms stretch together toward one side at chest height, palms facing down.
5. The feet snap back together, knees pinched, returning to the exact starting pose.

Bouncy springy timing, the whole body bobs on every beat, bright happy expression.
The first and last frames are identical so the clip loops seamlessly.
```

한글 버전:

```text
레퍼런스 이미지의 캐릭터가 — 디자인·비율·색을 그대로 유지한 채 —
제자리에서 신나는 K-pop 챌린지 안무 한 소절을 춘다.

카메라는 완전히 고정한다: 팬·줌·틸트 없음. 전신이 항상 화면 안에 들어온다.
순백 배경, 소품 없음, 벽에 그림자 없음, 글자 없음.
2D 카툰, 플랫 셀 셰이딩, 레퍼런스와 같은 스타일의 깔끔하고 일관된 선.

동작 순서, 총 1.8초:
1. 편하게 선 자세에서 두 팔을 옆으로 벌려 스윙하며 무릎을 한 번 굽힌다.
2. 무릎을 안쪽으로 모으고 한쪽 발뒤꿈치를 들어 발끝으로 서서 허리를 살짝 비틀며,
   팔꿈치를 굽힌 두 팔을 한쪽으로 쓸어 넘긴다. 손목은 힘을 뺀다.
3. 가볍게 제자리 조깅: 두 손을 가슴 높이에서 느슨한 주먹으로 쥐고 한 다리를 뒤로 접어 찬다.
4. 그 다리를 옆으로 크게 뻗어 넓은 옆 런지로 착지한다. 상체는 반대쪽으로 기울이고
   두 팔은 가슴 높이에서 한쪽으로 나란히 뻗는다. 손바닥은 아래를 향한다.
5. 두 발을 모으고 무릎을 붙이며 처음과 똑같은 자세로 돌아온다.

통통 튀는 타이밍, 박자마다 온몸이 들썩인다. 밝고 즐거운 표정.
첫 프레임과 마지막 프레임이 같아 이음새 없이 반복된다.
```

## 프롬프트 2 — `dance_heart` (마무리 D–E–F, 단발 모션)

```text
The character from the reference image — keep its exact design, proportions and colors —
performs a short cute finishing pose.

Camera is locked off: no pan, no zoom, no tilt. Full body stays inside the frame at all times.
Pure white empty background, no props, no shadows on the wall, no text.
2D cartoon, flat cel shading, clean consistent line art, same style as the reference image.

Motion in order, about 1.8 seconds total:
1. From a relaxed standing pose, both feet step together and both hands rise beside one cheek,
   one arm crossing in front of the chest, head tilting toward the raised hands.
2. The elbows tuck in at the sides and both hands come to the chest, fingers pinching.
3. Both hands make small finger hearts at chest height, the head tilts the other way,
   one eye winks, and the body bounces once on the beat.
4. The hands drop back down and the body returns to the exact starting pose.

Bouncy springy timing, bright happy expression.
The first and last frames are identical so the clip loops seamlessly.
```

---

## 굽는 절차

```bash
python scripts/bake_mascot.py pad <기준원화.png> --ratio 0.25 --bg '#ffffff'
# → *_pad.png 를 Hailuo(image-to-video)에 넣고 위 프롬프트로 생성, mp4 저장
python scripts/bake_mascot.py frames <생성.mp4> <작업폴더> --fps 12
python scripts/bake_mascot.py loop <작업폴더>/cutout dance_love --size 360
python scripts/bake_mascot.py recolor <anim폴더>/dance_love
python scripts/bake_mascot.py pack dance_love && python scripts/bake_mascot.py index
```

생성 결과가 마음에 안 들 때 프롬프트를 고치는 순서:

1. **동작이 잘린다** → `pad --ratio`를 0.35까지 올린다. 프롬프트를 고칠 문제가 아니다.
2. **끝이 멈춘 채 끝난다** → 흔한 실패다. `loop`의 움직임 정규화 채점이 정지 구간을 걸러 주지만,
   정지가 길면 쓸 구간 자체가 짧아진다. "첫 프레임과 마지막 프레임이 같다"를 프롬프트에 다시 강조한다.
3. **카메라가 움직인다** → "locked off camera"를 문단 맨 앞으로 올린다. 뒤에 두면 잘 안 먹는다.
4. **캐릭터 인상이 바뀐다** → 동작 묘사를 줄이고 "keep its exact design" 쪽 문장을 늘린다.
   동작을 자세히 쓸수록 모델이 캐릭터를 다시 그리려는 경향이 있다.
