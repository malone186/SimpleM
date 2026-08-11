// iOS 리퀴드 글라스 느낌의 반투명 유리 스타일 — 헤더 위 알약·아이콘 버튼용.
//
// 진짜 리퀴드 글라스(굴절·배경 블러)는 네이티브 모듈(expo-blur/expo-glass-effect)이 필요한데,
// 그걸 넣으면 안드로이드 dev client를 다시 빌드해야 한다. 그래서 의존성 없이 간다:
//   웹     — backdropFilter로 실제 배경 블러 + 채도 보정 (리퀴드 글라스와 가장 비슷)
//   네이티브 — 반투명 유리 + '위쪽 모서리에 빛이 맺힌' 하이라이트 테두리로 유리 질감만 흉내
// 버튼 배경이 어두운 헤더(오로라·에스프레소 브라운) 위라는 전제의 흰 유리다.
import { Platform } from 'react-native';

export const liquidGlass = {
  // 우유빛이 진하면 플라스틱처럼 보인다 — 거의 투명하게 깔고 블러·빛맺힘이 유리를 만든다
  backgroundColor: 'rgba(255,255,255,0.06)',
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.28)',
  // 위는 밝게, 아래는 어둡게 — 곡면 유리에 빛이 위에서 맺힌 것처럼 보이는 핵심 한 끗
  borderTopColor: 'rgba(255,255,255,0.65)',
  borderBottomColor: 'rgba(255,255,255,0.10)',
  // 유리의 깊이 — RN 0.76+ boxShadow(inset 지원, 네이티브 포함):
  //   ① 안쪽 위 빛맺힘  ② 안쪽 아래 은은한 젖빛 확산  ③ 바깥 부양 그림자
  boxShadow:
    'inset 0 1px 2px rgba(255,255,255,0.45), inset 0 -5px 12px rgba(255,255,255,0.06), 0 5px 14px rgba(0,0,0,0.16)',
  ...(Platform.OS === 'web'
    ? ({ backdropFilter: 'blur(24px) saturate(190%) brightness(1.08)' } as object)
    : null),
} as const;
