// [한글 주석] 프런트 테스트 설정.
//
//   왜 필요한가 — 타입체크가 못 잡는 버그가 실제로 났다.
//     · API 호출에 토큰을 안 붙여 401  (string은 string이라 타입은 통과)
//     · 세션 복원에서 isStaff 누락      (선택 필드라 타입은 통과)
//     · 환불에 잘못된 금액 전달         (number는 number라 타입은 통과)
//   셋 다 tsc를 통과했고 실행해봐야만 드러난다.
//
//   preset은 jest-expo를 쓴다. Expo/React Native 모듈은 그냥 두면
//   변환되지 않아 import 단계에서 터진다.
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  // node_modules 안의 RN/Expo 패키지는 ESM이라 변환이 필요하다
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg))',
  ],
  collectCoverageFrom: ['src/lib/**/*.ts', 'src/auth/**/*.tsx'],
};
