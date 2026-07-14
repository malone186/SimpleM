"""로스터리 및 원두 시세 챗봇 도구 래퍼 (백엔드 C)"""

# LangChain @tool 데코레이터 안전 로드 구조
try:
    from langchain.tools import tool
except ImportError:
    try:
        from langchain_core.tools import tool
    except ImportError:
        def tool(func):
            return func

# 가상 외부 원두 시세 데이터베이스
_bean_market_prices = {
    "에티오피아": 18000,
    "콜롬비아": 15000,
    "브라질": 12000,
    "케냐": 20000
}

@tool
def get_roastery_beans_price_tool(bean_name: str) -> dict:
    """지정한 원두 품종(에티오피아, 콜롬비아, 브라질, 케냐 등)의 현재 가상 생두 시세 정보를 외부 조회합니다.
    - bean_name: 조회하고자 하는 원두 이름 (예: '에티오피아')
    """
    try:
        cleaned_name = bean_name.strip()
        matched_price = None
        
        # 키워드 부분 일치 매핑
        for key, val in _bean_market_prices.items():
            if key in cleaned_name or cleaned_name in key:
                matched_price = val
                cleaned_name = key
                break
                
        if matched_price is None:
            # 기본값 우회 매핑
            matched_price = 16000
            cleaned_name = "일반 아라비카"

        summary = f"현재 {cleaned_name} 생두 시세는 kg당 {matched_price:,}원입니다. (가상 시뮬레이션 외부 정보)"
        
        return {
            "success": True,
            "data": {
                "bean_name": cleaned_name,
                "price_per_kg": matched_price,
                "beans_price_summary": summary
            },
            "documents": [],
            "message": "원두 생두 시세 조회가 완료되었습니다."
        }
    except Exception as e:
        return {
            "success": False,
            "data": {},
            "documents": [],
            "message": f"생두 시세 외부 조회 실패: {str(e)}"
        }
