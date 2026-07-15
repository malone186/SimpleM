/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        coffee: {
          50: '#FDFCF7',   // 전체 폰 배경 (매우 밝은 크림 화이트)
          100: '#F5F0E6',  // 주요 카드 및 섹션 배경 (따뜻한 연베이지)
          200: '#EADFC9',  // 연한 브라운 테두리 및 구분선
          300: '#C3B091',  // 중간 톤 모카 베이지
          500: '#8C6F56',  // 연한 브라운 포인트/보조 텍스트
          700: '#614838',  // 진한 코코아 브라운
          800: '#4E3629',  // 메인 텍스트 및 헤더용 짙은 에스프레소 브라운
          900: '#2D1F17',  // 아주 깊은 다크 초콜릿 브라운
          950: '#1F1510',  
        },
        point: {
          orange: '#C25E35', // 포인트 주황색 (발주 버튼 등)
          green: {
            bg: '#EBF4E0',   // 상승 배지 연두색 배경
            text: '#4E7D3A', // 상승 배지 텍스트
          }
        }
      },
    },
  },
  plugins: [],
};
