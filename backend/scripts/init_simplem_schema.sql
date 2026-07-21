-- ====================================================================
-- [SimpleM] 팀 공용 PostgreSQL 데이터베이스 simplem 전용 스키마 및 권한 SQL
-- 실행 방법: pgAdmin Query Tool 또는 psql 커맨드라인에서 1회 실행
-- ====================================================================

-- 1. simplem 전용 스키마 생성
CREATE SCHEMA IF NOT EXISTS simplem;

-- 2. 서비스 전용 DB 계정 생성 (선택 사항: 기존 계정 사용 시 해당 계정명으로 변경)
-- CREATE USER simplem_app_user WITH PASSWORD 'StrongPassword123!';

-- 3. simplem 스키마 사용 및 CRUD 최소 권한 부여
-- (다른 서비스 스키마 접근 방지 및 최소 권한 원칙)
GRANT USAGE ON SCHEMA simplem TO CURRENT_USER;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA simplem TO CURRENT_USER;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA simplem TO CURRENT_USER;

-- 4. 향후 simplem 스키마 내 새로 생성되는 테이블/시퀀스에 대한 기본 권한 자동 부여
ALTER DEFAULT PRIVILEGES IN SCHEMA simplem GRANT ALL ON TABLES TO CURRENT_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA simplem GRANT ALL ON SEQUENCES TO CURRENT_USER;

-- 5. 검색 경로(search_path) 설정 (선택 사항)
-- SET search_path TO simplem, public;

COMMENT ON SCHEMA simplem IS '카페용 매장 관리 서비스 (SimpleM) 전용 데이터베이스 스키마';
