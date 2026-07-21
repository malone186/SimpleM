import os
import re
import hashlib
from datetime import datetime
from typing import List, Dict, Any, Optional
from sqlalchemy.orm import Session

# [한글 주석] ChromaDB 라이브러리 안전 로드
try:
    import chromadb
except ImportError:
    chromadb = None

# [한글 주석] 스크래핑 서비스 및 RDB 모델 로드
from app.services.operation.scraping_service import LawScrapingService
from app.models.law import LawArticle

# =========================================================
# [상수 정의] ChromaDB 물리적 데이터 저장 경로 및 컬렉션 명칭
# =========================================================
BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
CHROMA_DB_DIR = os.path.join(BASE_DIR, "data", "chroma_db")
LAW_COLLECTION_NAME = "law_documents"


class LawRAGService:
    """
    [한글 주석] 카페 운영 관련 주요 법령(근로기준법, 최저임금법, 상가임대차법, 식품위생법 등)을 
    조문 단위로 청킹 및 RDB/ChromaDB 적재하고, content_hash 기반 변경분 재임베딩,
    하이브리드 검색(Dense Vector + Sparse Lexical)과 RRF 리랭킹을 거쳐 
    환각 방지(score 임계값 미달 시 정보 부족)를 제공하는 실서비스 RAG 엔진입니다.
    """

    @staticmethod
    def calculate_content_hash(text: str) -> str:
        """[한글 주석] 텍스트 변경 여부를 감지하기 위한 SHA256 해시를 계산합니다."""
        return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()

    @staticmethod
    def build_law_rag_documents(raw_data: Any) -> List[Dict[str, Any]]:
        """
        [한글 주석] 수집된 법령 데이터를 '조문 단위' 청킹으로 정제하고 
        content_hash 및 필수 메타데이터(law_name, article_no, category, source, effective_date 등)를 부착합니다.
        """
        processed_docs = []
        now_str = datetime.now().isoformat()

        if isinstance(raw_data, list):
            for item in raw_data:
                if isinstance(item, dict):
                    content_str = item.get("content", "").strip()
                    if not content_str:
                        continue
                    
                    c_hash = LawRAGService.calculate_content_hash(content_str)
                    doc = {
                        "law_name": item.get("law_name", "미지정 법령"),
                        "article_no": item.get("article_no", "제0조"),
                        "category": item.get("category", "운영/법률"),
                        "content": content_str,
                        "summary": item.get("summary", content_str[:100]),
                        "source": item.get("source", "국가법령정보센터 (https://www.law.go.kr)"),
                        "effective_date": item.get("effective_date", "2026-01-01"),
                        "content_hash": c_hash,
                        "updated_at": item.get("updated_at", now_str)
                    }
                    processed_docs.append(doc)
            return processed_docs

        if isinstance(raw_data, str):
            article_pattern = r"(제\s*\d+\s*조(?:\s*\([^)]+\))?)"
            parts = re.split(article_pattern, raw_data)
            law_title = "카페 관련 주요 법령"

            for i in range(1, len(parts), 2):
                header = parts[i].strip()
                body = parts[i+1].strip() if (i + 1) < len(parts) else ""
                full_content = f"{header} {body}".strip()
                if not full_content:
                    continue

                c_hash = LawRAGService.calculate_content_hash(full_content)
                doc = {
                    "law_name": law_title,
                    "article_no": header,
                    "category": "운영/노무",
                    "content": full_content,
                    "summary": body[:100] if body else header,
                    "source": "국가법령정보센터 (https://www.law.go.kr)",
                    "effective_date": "2026-01-01",
                    "content_hash": c_hash,
                    "updated_at": now_str
                }
                processed_docs.append(doc)

        return processed_docs

    @staticmethod
    def index_law_documents(docs: List[Dict[str, Any]]) -> int:
        """
        [한글 주석] 정제된 조문 문서들을 ChromaDB 벡터 저장소에 배치 임베딩 및 upsert 처리합니다.
        """
        if not docs or chromadb is None:
            return 0

        os.makedirs(CHROMA_DB_DIR, exist_ok=True)
        client = chromadb.PersistentClient(path=CHROMA_DB_DIR)
        collection = client.get_or_create_collection(name=LAW_COLLECTION_NAME)

        ids = []
        documents = []
        metadatas = []

        for idx, doc in enumerate(docs):
            # 조문 식별 고유 ID 생성 (특수문자 정제)
            safe_law_name = re.sub(r'[\s/]', '_', doc['law_name'])
            safe_article_no = re.sub(r'[\s/()만]', '_', doc['article_no'])
            doc_id = f"law_{safe_law_name}_{safe_article_no}_{idx}"

            ids.append(doc_id)
            page_content = f"[{doc['law_name']} {doc['article_no']}] {doc['content']}"
            documents.append(page_content)
            
            metadatas.append({
                "law_name": str(doc.get("law_name", "")),
                "article_no": str(doc.get("article_no", "")),
                "category": str(doc.get("category", "")),
                "summary": str(doc.get("summary", "")),
                "source": str(doc.get("source", "")),
                "effective_date": str(doc.get("effective_date", "")),
                "content_hash": str(doc.get("content_hash", "")),
                "updated_at": str(doc.get("updated_at", ""))
            })

        collection.upsert(
            ids=ids,
            documents=documents,
            metadatas=metadatas
        )

        return len(docs)

    @staticmethod
    def sync_law_documents(db: Optional[Session] = None, target_law: str = "전체") -> Dict[str, Any]:
        """
        [한글 주석] 수집 파이프라인을 실행하여 content_hash 기반으로 변경되거나 신규인 조문만 
        RDB에 저장/갱신하고 ChromaDB에 선택적 재임베딩을 수행합니다.
        """
        raw_data = LawScrapingService.fetch_law_article_data(target_law)
        processed_docs = LawRAGService.build_law_rag_documents(raw_data)

        updated_docs_to_index = []

        if db is not None:
            for doc in processed_docs:
                existing_article = db.query(LawArticle).filter(
                    LawArticle.law_name == doc["law_name"],
                    LawArticle.article_no == doc["article_no"]
                ).first()

                if not existing_article:
                    # 신규 데이터 추가
                    new_art = LawArticle(
                        law_name=doc["law_name"],
                        article_no=doc["article_no"],
                        category=doc["category"],
                        content=doc["content"],
                        summary=doc["summary"],
                        source=doc["source"],
                        effective_date=doc["effective_date"],
                        content_hash=doc["content_hash"]
                    )
                    db.add(new_art)
                    updated_docs_to_index.append(doc)
                elif existing_article.content_hash != doc["content_hash"]:
                    # content_hash가 달라진 경우 갱신 및 재임베딩
                    existing_article.content = doc["content"]
                    existing_article.summary = doc["summary"]
                    existing_article.effective_date = doc["effective_date"]
                    existing_article.content_hash = doc["content_hash"]
                    updated_docs_to_index.append(doc)
            db.commit()
        else:
            # DB 세션이 전달되지 않은 경우 전체 재임베딩
            updated_docs_to_index = processed_docs

        indexed_count = LawRAGService.index_law_documents(updated_docs_to_index)

        return {
            "success": True,
            "total_fetched": len(processed_docs),
            "total_updated_or_new": len(updated_docs_to_index),
            "total_indexed": indexed_count,
            "timestamp": datetime.now().isoformat(),
            "message": f"법령 조문 수집 완료 (전체 {len(processed_docs)}건 중 변경분 {indexed_count}건 ChromaDB 적재 완료)"
        }

    @staticmethod
    def search_law_documents(
        query: str,
        category: Optional[str] = None,
        top_k: int = 5,
        min_similarity_score: float = 0.55
    ) -> List[Dict[str, Any]]:
        """
        [한글 주석] 하이브리드 검색 (Dense Vector + Sparse Keyword RRF 리랭킹) 및 score 임계값 미달 컷 구현
        """
        return LawRAGService.hybrid_search_law_documents(
            query=query,
            category=category,
            top_k=top_k,
            min_similarity_score=min_similarity_score
        )

    @staticmethod
    def hybrid_search_law_documents(
        query: str,
        category: Optional[str] = None,
        top_k: int = 5,
        min_similarity_score: float = 0.55
    ) -> List[Dict[str, Any]]:
        """
        [한글 주석] 하이브리드 검색 및 중복 제거, score 컷오프(환각 방지)
        1. Dense Vector 검색 (ChromaDB)
        2. 키워드/조문 매칭 (Sparse Lexical Match)
        3. RRF (Reciprocal Rank Fusion) 스코어 계산
        4. min_similarity_score 미달 항목 제거 (결과 부족 시 빈 리스트)
        5. 동일 (law_name, article_no) 중복 제거
        """
        if not query or not query.strip() or chromadb is None:
            return []

        if not os.path.exists(CHROMA_DB_DIR):
            # DB 파일이 없을 경우 온디맨드로 자동 동기화 구동
            LawRAGService.sync_law_documents(db=None, target_law="전체")

        client = chromadb.PersistentClient(path=CHROMA_DB_DIR)
        try:
            collection = client.get_collection(name=LAW_COLLECTION_NAME)
        except Exception:
            # 컬렉션이 없으면 자동 생성 후 동기화
            LawRAGService.sync_law_documents(db=None, target_law="전체")
            try:
                collection = client.get_collection(name=LAW_COLLECTION_NAME)
            except Exception:
                return []

        where_clause = {"category": category} if category else None
        candidate_k = max(top_k * 3, 15)

        try:
            results = collection.query(
                query_texts=[query],
                n_results=candidate_k,
                where=where_clause
            )
        except Exception:
            return []

        if not results or not results.get("documents") or not results["documents"][0]:
            return []

        retrieved_docs = results["documents"][0]
        retrieved_metas = results["metadatas"][0] if results.get("metadatas") else []
        retrieved_distances = results["distances"][0] if results.get("distances") else []

        query_tokens = [t.strip() for t in re.findall(r'\w+', query) if len(t.strip()) > 1]
        k_const = 60
        hybrid_candidates = []

        keyword_scores = []
        for i, text in enumerate(retrieved_docs):
            meta = retrieved_metas[i] if i < len(retrieved_metas) else {}
            law_title = meta.get("law_name", "")
            article_no = meta.get("article_no", "")
            
            # 조문 및 원문 키워드 일치 수 측정
            kw_match_count = sum(1 for token in query_tokens if token in text or token in law_title or token in article_no)
            keyword_scores.append((i, kw_match_count))

        sorted_by_kw = sorted(keyword_scores, key=lambda x: x[1], reverse=True)
        kw_rank_map = {idx: rank + 1 for rank, (idx, _) in enumerate(sorted_by_kw)}
        kw_count_map = {idx: count for idx, count in keyword_scores}

        seen_articles = set()

        for vector_rank, text in enumerate(retrieved_docs):
            distance = retrieved_distances[vector_rank] if vector_rank < len(retrieved_distances) else 1.0
            vector_similarity = round(1.0 / (1.0 + distance), 4)

            kw_rank = kw_rank_map.get(vector_rank, candidate_k)
            vec_rank = vector_rank + 1

            rrf_score = (1.0 / (k_const + vec_rank)) + (1.0 / (k_const + kw_rank))
            meta = retrieved_metas[vector_rank] if vector_rank < len(retrieved_metas) else {}

            kw_match_count = kw_count_map.get(vector_rank, 0)
            if kw_match_count > 0:
                final_score = round(vector_similarity * 0.65 + (rrf_score * 30) * 0.35, 4)
            else:
                final_score = round(vector_similarity * 0.65, 4)

            # [환각 방지 1] 최소 임계값 미달 시 제외
            if final_score < min_similarity_score:
                continue

            law_key = (meta.get("law_name", ""), meta.get("article_no", ""))
            # [중복 제거] 동일 조문 중복 제거
            if law_key in seen_articles:
                continue
            seen_articles.add(law_key)

            hybrid_candidates.append({
                "law_name": meta.get("law_name", "관련 법령"),
                "article_no": meta.get("article_no", ""),
                "category": meta.get("category", ""),
                "content": text,
                "summary": meta.get("summary", ""),
                "source": meta.get("source", "국가법령정보센터"),
                "effective_date": meta.get("effective_date", ""),
                "updated_at": meta.get("updated_at", ""),
                "score": final_score,
                "rrf_score": round(rrf_score, 6)
            })

        hybrid_candidates.sort(key=lambda x: x["score"], reverse=True)
        return hybrid_candidates[:top_k]

    @staticmethod
    def get_collection_stats() -> Dict[str, Any]:
        """[한글 주석] ChromaDB 법령 컬렉션의 상태 및 인덱싱 수량을 반환합니다."""
        if chromadb is None or not os.path.exists(CHROMA_DB_DIR):
            return {"status": "unavailable", "total_documents": 0}

        client = chromadb.PersistentClient(path=CHROMA_DB_DIR)
        try:
            collection = client.get_collection(name=LAW_COLLECTION_NAME)
            return {
                "status": "active",
                "total_documents": collection.count(),
                "collection_name": LAW_COLLECTION_NAME
            }
        except Exception:
            return {"status": "empty", "total_documents": 0}


