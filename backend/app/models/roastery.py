# c:\STUDY\SimpleM\backend\app\models\roastery.py
from sqlalchemy import Column, Integer, String, Boolean, Float, ForeignKey, Text
from sqlalchemy.orm import relationship
from app.core.database import Base

# [한글 주석] 1. 외부 로스터리(원두 볶는 매장) 업체 정보를 보관하는 테이블입니다.
class Roastery(Base):
    """로스터리 브랜드 업체 모델"""
    __tablename__ = "roasteries"

    # 로스터리 업체 고유 번호 (JSON의 id와 매핑됩니다)
    id = Column(Integer, primary_key=True, index=True)
    
    # 로스터리 이름 (예: 가델로 커피)
    name = Column(String(100), nullable=False)
    
    # 썸네일 이미지 파일 주소
    thumbnail_url = Column(String(255), nullable=True)
    
    # 로스터리 업체 정보 요약 설명 (예: 블렌딩 천재가 만드는 맛도리)
    roastery_info = Column(String(255), nullable=True)
    
    # 이미지 파일 실제 저장 경로 (webp 파일명)
    file_path = Column(String(255), nullable=True)

    # [한글 주석] 이 로스터리가 판매하는 원두 상품들과의 1대N 관계선을 연결해 둡니다.
    beans = relationship("RoasteryBean", back_populates="roastery", cascade="all, delete-orphan")


# [한글 주석] 2. 로스터리 업체들이 판매하는 개별 원두 상품 상세 정보를 보관하는 테이블입니다.
class RoasteryBean(Base):
    """로스터리별 판매 원두 상품 모델"""
    __tablename__ = "roastery_beans"

    # 원두 상품 고유 일련번호
    id = Column(Integer, primary_key=True, index=True)
    
    # 원두 상품 이름 (예: BG블랜드, 500g)
    name = Column(String(100), nullable=False)
    
    # 판매 단가 가격 (원)
    price = Column(Integer, nullable=False, default=0)
    
    # 이 원두를 만들어 파는 제조사가 어느 로스터리(Roastery)인지 연결해 주는 아파트 동수(외래키)입니다.
    roastery_id = Column(Integer, ForeignKey("roasteries.id", ondelete="CASCADE"), nullable=False)
    
    # 상품 썸네일 이미지 주소
    thumbnail_url = Column(String(255), nullable=True)
    
    # 상품을 구매할 수 있는 쇼핑몰 실제 상세 웹페이지 주소
    product_url = Column(String(255), nullable=True)
    
    # 네이버 쇼핑 수집 및 등록일자 (YYYYMMDD 형식 문자열)
    date_added = Column(String(8), nullable=True)
    
    # 베스트 상품 딱지 여부
    best = Column(Boolean, default=False, nullable=False)
    
    # 신상품 딱지 여부
    new = Column(Boolean, default=False, nullable=False)
    
    # 품절 처리 여부
    sold_out = Column(Boolean, default=False, nullable=False)
    
    # 원두의 풍미, 아로마 등 텍스트 설명
    description = Column(Text, nullable=True)
    
    # 원산지 국가명 (예: 에티오피아, 브라질)
    country = Column(String(50), nullable=True)
    
    # 가공 방식 (예: 내추럴, 워시드)
    process = Column(String(50), nullable=True)
    
    # 블렌딩 원두 여부 (여러 생두를 섞어 볶았는지 여부)
    blend = Column(Boolean, default=False, nullable=False)
    
    # 디카페인 원두 여부
    decaf = Column(Boolean, default=False, nullable=False)
    
    # 게샤 품종 여부 (고가 품종인 게이샤 원두 여부)
    gesha = Column(Boolean, default=False, nullable=False)
    
    # 원두 1g당 단가 가격 (원/g)
    price_per_gram = Column(Float, nullable=True)
    
    # 네이버 쇼핑 원본 상품 고유 ID
    naver_product_id = Column(String(50), nullable=True)

    # [한글 주석] 이 원두를 파는 로스터리 업체 정보를 역추적해서 읽어올 수 있게 관계선을 이어 줍니다.
    roastery = relationship("Roastery", back_populates="beans")
