#!/usr/bin/env python3
"""브루 마스코트 에셋 베이크 도구.

원래 이 작업은 세션 스크래치패드의 일회용 스크립트로 돌렸는데, 세션이 날아가면서
스크립트가 사라졌다(flipbookFrames.ts 머리말이 가리키던 그 스크립트다). 같은 일이
또 나지 않도록 저장소 안으로 옮기고, 색 램프 같은 '측정으로만 알 수 있는 값'은
기존 결과물에서 다시 학습해 JSON으로 굳혀 둔다.

  learn    기존 (원본, 색변형) 쌍에서 앞치마 색 램프를 학습 → apron_ramps.json
  recolor  원본 갈색 그림 → 앞치마 6색 변형 (learn 결과를 적용)
  pack     프레임 20장 → 스프라이트 시트 1장 (재생기가 Image 1개만 마운트하게)
  index    assets/mascot/anim을 훑어 flipbookFrames.ts를 다시 생성
  pad      생성 이미지에 배경색 패딩 — 영상 생성 시 큰 동작이 잘리지 않게
  frames   영상 → 프레임 추출(ffmpeg) → 배경 제거(rembg isnet-anime)
  loop     누끼 프레임에서 루프 구간 탐지 → 크롭·리사이즈 → f00.webp… 규격 저장

전신 모션 프레임을 굽는 원래 단계(AnimatedDrawings 리깅+BVH)는 유실됐고 되살릴
수 없다. 대신 지금은 AI 생성 파이프라인으로 새 모션을 만든다:
  기준 원화(krea) → pad → 영상 생성(minimax, 카메라 고정·흰 배경) → frames → loop
  → (recolor) → index.  loop까지 끝나면 기존 pack/index/재생기에 그대로 합류한다.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ANIM = ROOT / "frontend" / "assets" / "mascot" / "anim"
RAMPS = Path(__file__).resolve().parent / "apron_ramps.json"

APRON_COLORS = ["navy", "forest", "mustard", "terracotta", "wine", "charcoal"]

# 앞치마와 털을 가르는 기준. 브루는 갈색 개에 갈색 앞치마라 색상(H)만으로는 못 가른다 —
# 실측하면 앞치마는 진하고 짙은 쪽(S 중앙값 0.72 / V 0.35), 털은 옅은 크림(S 0.25 / V 0.98)
# 으로 갈려서 채도·명도로 자른다. 경계 픽셀은 부드럽게 섞어 계단이 안 생기게 한다.
SAT_MIN, VAL_MAX = 0.45, 0.62
FEATHER = 0.12


def _lum(rgb: np.ndarray) -> np.ndarray:
    return 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]


def _load(path: Path) -> np.ndarray:
    return np.array(Image.open(path).convert("RGBA")).astype(float)


def apron_mask(rgba: np.ndarray) -> np.ndarray:
    """앞치마일 확률(0~1). 경계에서 급격히 끊기지 않도록 페더링한다."""
    rgb = rgba[..., :3] / 255.0
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    val = mx
    # 두 조건 모두 만족할수록 1에 가깝게 (곱집합)
    s_ok = np.clip((sat - SAT_MIN) / FEATHER, 0, 1)
    v_ok = np.clip((VAL_MAX - val) / FEATHER, 0, 1)
    return s_ok * v_ok * np.clip(rgba[..., 3] / 255.0, 0, 1)


# ── learn ────────────────────────────────────────────────────────────────────
def learn(args) -> int:
    """기존 결과물에서 '밝기 → 앞치마 색' 대응표를 되찾는다.

    선형 근사로도 대충 맞지만(채널당 평균오차 3~15) 겨자·테라코타처럼 밝은 쪽에서
    꺾이는 색이 눈에 띄게 어긋난다. 밝기 256단계별 중앙값 LUT로 뜨면 그 왜곡이 없다.
    """
    pairs: dict[str, list[tuple[np.ndarray, np.ndarray]]] = {c: [] for c in APRON_COLORS}
    for motion_dir in sorted(ANIM.iterdir()):
        if not motion_dir.is_dir() or "__" in motion_dir.name:
            continue
        for frame in sorted(motion_dir.glob("f*.webp")):
            base = _load(frame)
            for color in APRON_COLORS:
                variant = ANIM / f"{motion_dir.name}__{color}" / frame.name
                if not variant.exists():
                    continue
                var = _load(variant)
                # 실제로 색이 바뀐 픽셀만 학습에 쓴다 — 마스크 추정에 기대지 않는다
                delta = np.abs(var[..., :3] - base[..., :3]).sum(-1)
                sel = (base[..., 3] > 250) & (delta > 40)
                if sel.sum():
                    pairs[color].append((_lum(base)[sel], var[..., :3][sel]))

    ramps: dict[str, list[list[int]]] = {}
    for color in APRON_COLORS:
        if not pairs[color]:
            print(f"  {color}: 학습할 쌍이 없음 — 건너뜀", file=sys.stderr)
            continue
        lums = np.concatenate([p[0] for p in pairs[color]])
        targets = np.concatenate([p[1] for p in pairs[color]])
        bins = np.clip(np.round(lums).astype(int), 0, 255)
        lut = np.zeros((256, 3))
        seen = np.zeros(256, dtype=bool)
        for level in range(256):
            hit = bins == level
            if hit.sum() >= 8:
                lut[level] = np.median(targets[hit], axis=0)
                seen[level] = True
        # 표본이 없는 밝기 구간은 양옆에서 이어 붙인다 (LUT에 구멍이 남지 않게)
        idx = np.arange(256)
        for ch in range(3):
            lut[:, ch] = np.interp(idx, idx[seen], lut[seen, ch])
        ramps[color] = np.clip(np.round(lut), 0, 255).astype(int).tolist()
        err = np.abs(lut[bins] - targets).mean()
        print(f"  {color:11s} 표본 {len(lums):>7,d}  평균오차 {err:.2f}/255")

    RAMPS.write_text(json.dumps(ramps, separators=(",", ":")), encoding="utf-8")
    print(f"→ {RAMPS.relative_to(ROOT)} ({RAMPS.stat().st_size // 1024}KB)")
    return 0


def _ramps() -> dict[str, np.ndarray]:
    if not RAMPS.exists():
        sys.exit(f"색 램프가 없다. 먼저 `python {Path(__file__).name} learn` 실행.")
    raw = json.loads(RAMPS.read_text(encoding="utf-8"))
    return {k: np.array(v, dtype=float) for k, v in raw.items()}


# ── recolor ──────────────────────────────────────────────────────────────────
def recolor_image(rgba: np.ndarray, ramp: np.ndarray) -> Image.Image:
    mask = apron_mask(rgba)[..., None]
    levels = np.clip(np.round(_lum(rgba)).astype(int), 0, 255)
    tinted = ramp[levels]
    out = rgba.copy()
    out[..., :3] = rgba[..., :3] * (1 - mask) + tinted * mask
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def recolor(args) -> int:
    ramps = _ramps()
    src = Path(args.src).resolve()  # 상대경로 입력 시 relative_to(ROOT)가 죽지 않게
    targets = [src] if src.is_file() else sorted(src.glob("*.webp")) + sorted(src.glob("*.png"))
    if not targets:
        sys.exit(f"입력이 없다: {src}")
    colors = args.colors or APRON_COLORS
    for color in colors:
        if color not in ramps:
            print(f"  {color}: 램프 없음 — 건너뜀", file=sys.stderr)
            continue
        out_dir = Path(args.out) / color if args.out else src.parent / f"{src.name}__{color}"
        out_dir.mkdir(parents=True, exist_ok=True)
        for stale in out_dir.glob("f*.webp"):  # 원본 프레임 수가 바뀌어도 꼬리가 남지 않게
            stale.unlink()
        for path in targets:
            img = recolor_image(_load(path), ramps[color])
            dst = out_dir / f"{path.stem}.webp"
            img.save(dst, "WEBP", quality=92, method=6)
        print(f"  {color:11s} → {out_dir.relative_to(ROOT)} ({len(targets)}장)")
    return 0


# ── pack ─────────────────────────────────────────────────────────────────────
def pack(args) -> int:
    """프레임 20장을 격자 스프라이트 시트 한 장으로 합친다.

    재생기가 Image를 프레임 수만큼 마운트하지 않아도 되고(지금은 20개를 겹쳐 두고
    opacity만 토글한다), 웹에서 첫 사이클에 프레임이 하나씩 늦게 뜨는 깜빡임도 사라진다.

    가로 한 줄로 잇지 않는 이유: 360px 20장이면 7200px가 되는데 기기 상당수가 최대
    텍스처 4096px이라 네이티브에서 잘리거나 아예 못 올린다. 4096을 넘지 않는 가장
    가로로 긴 격자를 고른다(360x360 20장이면 5열 4행 = 1800x1440).

    용량 이득은 없다(오히려 5~10% 커진다 — 장당 최적화가 사라져서). 얻는 건 마운트
    개수와 요청 수, 그리고 크로스페이드용 두 번째 인스턴스가 같은 텍스처를 재사용한다는 점.
    """
    src = Path(args.src)
    frames = sorted(src.glob("f*.webp"))
    if not frames:
        sys.exit(f"프레임이 없다: {src}")
    imgs = [Image.open(f).convert("RGBA") for f in frames]
    w, h = imgs[0].size
    if any(im.size != (w, h) for im in imgs):
        sys.exit("프레임 크기가 제각각이다 — 시트로 못 합친다")

    n = len(imgs)
    limit = args.max_dim
    cols = min(n, max(1, limit // w))
    rows = (n + cols - 1) // cols
    if rows * h > limit:
        sys.exit(f"{n}장을 {limit}px 안에 못 담는다 (프레임 {w}x{h})")

    sheet = Image.new("RGBA", (cols * w, rows * h), (0, 0, 0, 0))
    for i, im in enumerate(imgs):
        sheet.paste(im, (w * (i % cols), h * (i // cols)))
    dst = Path(args.out) if args.out else src.parent.parent / "sheets" / f"{src.name}.webp"
    dst.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(dst, "WEBP", quality=92, method=6)

    meta = {"frame": [w, h], "cols": cols, "rows": rows, "count": n}
    dst.with_suffix(".json").write_text(json.dumps(meta), encoding="utf-8")
    before = sum(f.stat().st_size for f in frames)
    after = dst.stat().st_size
    print(f"  {src.name}: {n}장 {w}x{h} -> {cols}x{rows} 격자 {sheet.width}x{sheet.height} "
          f"({before // 1024}KB -> {after // 1024}KB, {100 * after // max(before, 1)}%)")
    return 0


# ── pad / frames / loop — AI 생성 파이프라인 ─────────────────────────────────
def _tool(name: str) -> str:
    """rembg는 이 스크립트를 돌린 파이썬의 venv에 같이 깔려 있을 확률이 높다 — 거기부터 찾는다."""
    cand = Path(sys.executable).parent / name
    if cand.exists():
        return str(cand)
    found = shutil.which(name)
    if not found:
        sys.exit(f"{name} 실행 파일을 못 찾았다. (마스코트 venv: ~/.venvs/mascot)")
    return found


def _hex_rgb(s: str) -> tuple[int, int, int]:
    s = s.lstrip("#")
    return tuple(int(s[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def pad(args) -> int:
    """영상 생성 입력용 패딩. 큰 동작은 팔다리가 프레임 밖으로 나가며 잘리는데,
    배경과 같은 색으로 여백을 미리 줘야 영상 모델이 그 공간을 동작에 쓸 수 있다."""
    src = Path(args.src)
    targets = [src] if src.is_file() else sorted(src.glob("*.png")) + sorted(src.glob("*.webp"))
    if not targets:
        sys.exit(f"입력이 없다: {src}")
    bg = _hex_rgb(args.bg)
    for path in targets:
        img = Image.open(path).convert("RGBA")
        w, h = img.size
        pw, ph = int(w * args.ratio), int(h * args.ratio)
        canvas = Image.new("RGBA", (w + 2 * pw, h + 2 * ph), bg + (255,))
        canvas.alpha_composite(img, (pw, ph))
        dst = Path(args.out) if args.out and src.is_file() else path.with_name(f"{path.stem}_pad.png")
        canvas.convert("RGB").save(dst)  # 영상 모델 입력은 알파가 없어야 한다
        print(f"  {path.name}: {w}x{h} → {canvas.width}x{canvas.height} → {dst.name}")
    return 0


def frames(args) -> int:
    """영상 → 프레임 PNG(raw/) → 배경 제거 PNG(cutout/). 기하 변형은 하지 않는다 — loop 몫."""
    video = Path(args.src)
    if not video.is_file():
        sys.exit(f"영상이 없다: {video}")
    out = Path(args.out) if args.out else video.with_suffix("")
    raw, cut = out / "raw", out / "cutout"
    raw.mkdir(parents=True, exist_ok=True)
    cut.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        [_tool("ffmpeg"), "-y", "-loglevel", "error", "-i", str(video),
         "-vf", f"fps={args.fps}", str(raw / "f%03d.png")],
        check=True,
    )
    n_raw = len(list(raw.glob("f*.png")))
    if not n_raw:
        sys.exit("추출된 프레임이 없다")
    print(f"  프레임 추출: {n_raw}장 ({args.fps}fps) → {raw}")

    # 전 프레임을 같은 모델·같은 설정으로 한 번에 — 프레임마다 경계가 흔들리면 재생 시 지글거린다
    subprocess.run([_tool("rembg"), "p", "-m", args.model, str(raw), str(cut)], check=True)
    n_cut = len(list(cut.glob("f*.png")))
    print(f"  배경 제거({args.model}): {n_cut}장 → {cut}")
    return 0


def _thumb(path: Path, side: int = 64) -> np.ndarray:
    """비교용 축소본 — 알파를 곱한 RGB라서 배경 잔재 없이 실루엣+색을 함께 본다."""
    im = Image.open(path).convert("RGBA").resize((side, side), Image.BILINEAR)
    arr = np.asarray(im).astype(float) / 255.0
    return np.concatenate([arr[..., :3] * arr[..., 3:4], arr[..., 3:4]], axis=-1)


def loop(args) -> int:
    """루프 구간을 찾아 잘라내고, 공통 크롭·리사이즈해서 f00.webp… 규격으로 저장한다.

    영상 생성 결과는 도입부가 어정쩡하고 끝은 정지 상태로 끝나는 일이 많다. 정지 구간은
    아무 데서 잘라도 이음새가 붙기 때문에 '이음새 오차 최소'만 보면 반드시 거기에 속는다 —
    그래서 이음새 오차를 사이클 내부 움직임량으로 나눈 비율로 채점한다: 많이 움직였는데도
    처음과 끝이 닮은 구간이 진짜 루프다. 길이 벌점은 기본 주기(1사이클)를 고르게 한다."""
    src = Path(args.src)
    paths = sorted(src.glob("f*.png")) or sorted(src.glob("*.png"))
    if len(paths) < args.min_len + 1:
        sys.exit(f"프레임이 부족하다: {len(paths)}장 (최소 {args.min_len + 1})")
    thumbs = np.stack([_thumb(p) for p in paths])
    cons = np.abs(thumbs[1:] - thumbs[:-1]).mean(axis=(1, 2, 3))  # 인접 프레임 간 움직임

    if args.full:
        # 루프를 찾지 않고 영상 전체를 쓴다 — 안무가 한 번 쭉 흐르는 영상에서 루프 탐지는
        # 잘 붙는 '한 구절'만 남기고 나머지 안무를 날려 버린다 (redred에서 실제로 그랬다).
        # 생성 영상은 앞뒤가 몇 프레임 정지 상태라 그 부분만 잘라낸다.
        MOVING = 0.002
        idx = np.where(cons > MOVING)[0]
        if len(idx) == 0:
            sys.exit("움직임이 감지되지 않는다 — cutout 폴더가 맞는지 확인")
        i, j = int(idx[0]), int(idx[-1]) + 2  # cons[k]는 k→k+1 변화라 끝 프레임 +1
        cycle = paths[i:j]
        print(f"  전체 사용: f{i:03d} ~ f{j - 1:03d} ({len(cycle)}장 — 정지 머리·꼬리만 제거)")
    else:
        best, best_score = None, float("inf")
        for i in range(len(paths) - args.min_len):
            for j in range(i + args.min_len, len(paths)):
                seam = float(np.abs(thumbs[j] - thumbs[i]).mean())
                motion = float(cons[i:j].mean())
                score = seam / (motion + 1e-4) + 0.002 * (j - i)
                if score < best_score:
                    best, best_score = (i, j), score
        i, j = best  # type: ignore[misc]
        cycle = paths[i:j]
        seam = float(np.abs(thumbs[j] - thumbs[i]).mean())
        motion = float(cons[i:j].mean())
        print(f"  루프 탐지: f{i:03d} ~ f{j - 1:03d} ({len(cycle)}장, "
              f"이음새 {seam:.4f} / 움직임 {motion:.4f} = {seam / (motion + 1e-4):.2f})")

    # 프레임 수를 억지로 맞추지 않는다 — 복제(같은 그림 2틱)와 불균일 간격(2·3장 섞임)이
    # 재생 시 '뚝뚝 끊김'으로 바로 보인다. --count는 균일 간격 솎아내기 상한일 뿐이다.
    stride = 1
    if args.count and args.count < len(cycle):
        stride = -(-len(cycle) // args.count)  # ceil — 정수 간격만 허용
        cycle = cycle[::stride]
        print(f"  솎아내기: {stride}장 간격 → {len(cycle)}장")
    eff_fps = args.fps / stride

    # 시트 한 장(최대 4096px)에 들어가야 한다. 프레임을 솎아 fps를 잃는 대신 변을 줄여
    # 장수를 지킨다 — 표시 크기(84~240px)보다 훨씬 크므로 288px도 화질 손해가 없고,
    # 부드러움(프레임 수)은 눈에 바로 보인다. 그래도 안 들어가면 그때만 솎는다.
    size = args.size
    for cand in (args.size, 320, 288):
        if (4096 // cand) ** 2 >= len(cycle):
            size = cand
            break
    else:
        size = 288
        cap = (4096 // size) ** 2
        stride2 = -(-len(cycle) // cap)
        cycle = cycle[::stride2]
        eff_fps /= stride2
        print(f"  시트 상한 초과 — {stride2}장 간격 솎아내기 → {len(cycle)}장")
    if size != args.size:
        print(f"  프레임 {size}px (시트 4096px 안에 {len(cycle)}장을 담기 위해 축소)")

    # 사이클 전체의 알파 합집합 bbox로 크롭 — 프레임마다 따로 자르면 캐릭터가 덜컹거린다
    imgs = [np.array(Image.open(p).convert("RGBA")) for p in cycle]
    union = np.zeros(imgs[0].shape[:2], dtype=bool)
    for im in imgs:
        union |= im[..., 3] > 16
    if not union.any():
        sys.exit("알파가 전부 비어 있다 — cutout 폴더가 맞는지 확인")
    ys, xs = np.where(union)
    m = int(max(union.shape) * 0.04)
    y0, y1 = max(0, ys.min() - m), min(union.shape[0], ys.max() + 1 + m)
    x0, x1 = max(0, xs.min() - m), min(union.shape[1], xs.max() + 1 + m)

    side = max(y1 - y0, x1 - x0)
    out = Path(args.out) if args.out else ANIM / src.parent.name
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("f*.webp"):  # 프레임 수가 줄었을 때 옛 꼬리가 남지 않게
        stale.unlink()
    for k, im in enumerate(imgs):
        crop = Image.fromarray(im[y0:y1, x0:x1])
        square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        square.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
        square.resize((size, size), Image.LANCZOS).save(
            out / f"f{k:02d}.webp", "WEBP", quality=92, method=6
        )
    # 원본 속도 메타 — index가 flipbookFrames.ts에 실어 재생기가 실제 속도로 돌린다
    (out / "meta.json").write_text(json.dumps({"fps": round(eff_fps, 2)}), encoding="utf-8")
    print(f"  → {out} ({len(imgs)}장, {size}x{size}, 재생 {eff_fps:.1f}fps)")
    return 0


# ── index ────────────────────────────────────────────────────────────────────
def index(args) -> int:
    """assets/mascot/anim 실제 내용대로 flipbookFrames.ts를 다시 쓴다."""
    sets: dict[str, list[str]] = {}
    for d in sorted(ANIM.iterdir()):
        if not d.is_dir():
            continue
        frames = sorted(f.name for f in d.glob("f*.webp"))
        if frames:
            sets[d.name] = frames
    # 영상 파이프라인 세트는 원본 속도 메타(loop가 남긴 meta.json)를 함께 싣는다 —
    # 색 변형은 기본 세트의 메타를 따른다 (recolor는 프레임만 굽는다).
    fps_map: dict[str, float] = {}
    for key in sets:
        meta = ANIM / key.split("__")[0] / "meta.json"
        if meta.exists():
            fps_map[key] = json.loads(meta.read_text(encoding="utf-8"))["fps"]

    # 개별 프레임 require는 더 이상 내보내지 않는다 — (모션×색)당 시트 1장만 번들에 실린다.
    # 프레임을 낱장으로 실으면 에셋이 수천 개가 되어 OTA(EAS Update)의 업데이트당 1000개
    # 제한에 걸린다. 시트가 없는 세트는 여기서 바로 실패시킨다 (조용히 빠지면 앱에서
    # 모션이 사라진 걸 뒤늦게 발견하게 된다): python bake_mascot.py pack <폴더> 먼저.
    sheets_dir = ANIM.parent / "sheets"
    sheet_meta: dict[str, dict] = {}
    for key in sets:
        meta_path = sheets_dir / f"{key}.json"
        if not meta_path.exists():
            sys.exit(f"시트가 없다: {key} — 먼저 `pack {ANIM / key}` 실행")
        sheet_meta[key] = json.loads(meta_path.read_text(encoding="utf-8"))

    lines = [
        "// [자동 생성] 전신 플립북 — (모션, 앞치마 색)별 스프라이트 시트 1장 + 격자 메타",
        "// 키: 'wave' | 'wave__navy' | ... 기본(갈색)은 색 접미사 없음.",
        "// 재생성: python scripts/bake_mascot.py pack <프레임폴더> → index",
        "",
        "import type { FlipSheet } from './Flipbook';",
        "",
        "export const FLIP_SHEETS: Record<string, FlipSheet> = {",
    ]
    for key, m in sheet_meta.items():
        lines.append(
            f"  '{key}': {{ src: require('../../../assets/mascot/sheets/{key}.webp'), "
            f"frame: [{m['frame'][0]}, {m['frame'][1]}], cols: {m['cols']}, rows: {m['rows']}, count: {m['count']} }},"
        )
    lines += ["};", ""]
    lines += [
        "// 영상 파이프라인 세트의 원본 재생 속도(fps). 여기 없는 키는 재생기 기본값을 쓴다.",
        "export const FLIP_FPS: Record<string, number> = {",
    ]
    for key, fps in fps_map.items():
        lines.append(f"  '{key}': {fps},")
    lines += ["};", ""]
    dst = ROOT / "frontend" / "src" / "components" / "brew" / "flipbookFrames.ts"
    dst.write_text("\n".join(lines), encoding="utf-8")
    print(f"→ {dst.relative_to(ROOT)} ({len(sets)}세트 / {sum(len(v) for v in sets.values())}프레임)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("learn", help="기존 결과물에서 앞치마 색 램프 학습").set_defaults(fn=learn)

    p = sub.add_parser("recolor", help="원본 갈색 그림 → 앞치마 6색 변형")
    p.add_argument("src", help="이미지 파일 또는 프레임 폴더")
    p.add_argument("--out", help="출력 루트 (기본: 원본 옆에 <이름>__<색>/)")
    p.add_argument("--colors", nargs="*", choices=APRON_COLORS)
    p.set_defaults(fn=recolor)

    p = sub.add_parser("pack", help="프레임 폴더 → 스프라이트 시트 1장")
    p.add_argument("src", help="f00.webp… 가 들어 있는 폴더")
    p.add_argument("--out")
    p.add_argument("--max-dim", type=int, default=4096, dest="max_dim",
                   help="시트 한 변의 상한 (기본 4096 — 구형 기기 최대 텍스처)")
    p.set_defaults(fn=pack)

    p = sub.add_parser("pad", help="영상 생성 입력용 배경색 패딩")
    p.add_argument("src", help="이미지 파일 또는 폴더")
    p.add_argument("--ratio", type=float, default=0.25, help="한 변당 패딩 비율 (기본 0.25)")
    p.add_argument("--bg", default="#ffffff", help="패딩 색 (기본 흰색)")
    p.add_argument("--out", help="출력 파일 (단일 입력일 때만)")
    p.set_defaults(fn=pad)

    p = sub.add_parser("frames", help="영상 → 프레임 추출 + 배경 제거")
    p.add_argument("src", help="mp4 등 영상 파일")
    p.add_argument("--fps", type=int, default=24, help="추출 fps (기본 24 — 생성 영상 원본 그대로)")
    p.add_argument("--model", default="isnet-anime", help="rembg 모델 (기본 isnet-anime)")
    p.add_argument("--out", help="출력 루트 (기본: 영상 이름 폴더 — raw/, cutout/ 생성)")
    p.set_defaults(fn=frames)

    p = sub.add_parser("loop", help="누끼 프레임 → 루프 절단 + f00.webp… 규격 저장")
    p.add_argument("src", help="cutout PNG 폴더")
    p.add_argument("--full", action="store_true",
                   help="루프 탐지 없이 영상 전체 사용 (정지 머리·꼬리만 제거) — 안무가 한 번 쭉 흐르는 영상용")
    p.add_argument("--out", help="출력 폴더 (기본: assets/mascot/anim/<모션이름>)")
    p.add_argument("--size", type=int, default=360, help="한 변 픽셀 상한 (장수가 많으면 자동 축소)")
    p.add_argument("--count", type=int, help="프레임 수 상한 — 균일 간격 솎아내기만, 복제 없음 (기본: 사이클 전체)")
    p.add_argument("--fps", type=int, default=24, help="입력 프레임의 원래 초당 장수 (meta.json으로 저장)")
    p.add_argument("--min-len", type=int, default=8, dest="min_len", help="최소 사이클 길이 (기본 8)")
    p.set_defaults(fn=loop)

    sub.add_parser("index", help="flipbookFrames.ts 재생성").set_defaults(fn=index)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
