# SimpleM 프론트엔드 (Expo 웹 빌드) — Cloud Run 정적 서빙 이미지
# EXPO_PUBLIC_* 값은 빌드 시점에 번들에 박힌다. API 주소는 .env.production이
# 단일 소스 (deploy/deploy_frontend.ps1이 백엔드 Cloud Run URL로 갱신).
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# expo export가 NODE_ENV=production으로 돌므로 .env.production이 .env를 덮는다
RUN npx expo export --platform web

FROM node:22-alpine
RUN npm install -g serve@14
COPY --from=build /app/dist /srv/dist

EXPOSE 8080
# -s: SPA 폴백 (모든 경로를 index.html로) — expo-router 딥링크 대응
CMD ["sh", "-c", "serve -s /srv/dist -l ${PORT:-8080}"]
