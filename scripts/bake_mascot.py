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

복원할 수 없는 단계 — 전신 모션 프레임 자체(20장)는 AnimatedDrawings로 원화를
리깅해 모션캡처를 입혀 구운 것이다. 리깅 설정과 BVH가 남아 있지 않고 로컬에
AnimatedDrawings도 없어서, '새 모션을 굽는' 단계는 이 스크립트로 되살릴 수 없다.
새 동작이 필요하면 런타임 절차적 동작(brewMotions.ts) 쪽으로 가는 게 맞다.
"""

from __future__ import annotations

import argparse
import json
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
    src = Path(args.src)
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
    lines = [
        "// [자동 생성] 전신 플립북 프레임 — (모션, 앞치마 색)별 WebP 스프라이트 세트",
        "// 키: 'wave' | 'wave__navy' | ... 기본(갈색)은 색 접미사 없음.",
        "// 재생성: python scripts/bake_mascot.py index",
        "",
        "export const FLIP_FRAMES: Record<string, any[]> = {",
    ]
    for key, frames in sets.items():
        lines.append(f"  '{key}': [")
        for fr in frames:
            lines.append(f"    require('../../../assets/mascot/anim/{key}/{fr}'),")
        lines.append("  ],")
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

    sub.add_parser("index", help="flipbookFrames.ts 재생성").set_defaults(fn=index)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
