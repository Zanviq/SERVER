"""큰 JSON 응답은 엔드포인트 안에서(= 스레드풀에서) 직렬화한다.

FastAPI 는 response_model 이 없는 엔드포인트가 돌려준 값을 `jsonable_encoder` 로 한 번
더 훑어 바꾼 뒤 보낸다. 그 변환은 엔드포인트가 스레드풀에서 돌아도 **이벤트 루프
위에서** 돈다(fastapi.routing.serialize_response, 0.116·0.141 모두). 그동안 서버는 다른
어떤 요청도 받지 못한다.

실측(단어 3천 개 = 객체 7만 개): 변환만 322ms. 두 사람이 단어장을 거듭 여는 동안
다른 사람의 /api/health 가 5ms → 중앙 295ms, 최대 635ms 로 밀렸다. 같은 값을
json.dumps 로 바로 쓰면 24ms 이고, 스레드풀 안이라 루프를 막지도 않는다.

저장소에서 읽은 값은 이미 JSON 그대로(dict·list·str·수)라 jsonable_encoder 가 바꿀
것이 없다. Response 를 돌려주면 FastAPI 는 손대지 않고 보낸다.

**쓰는 곳**: 항목 수에 비례해 커지는 목록(단어장·할 일·대화·받아쓰기). 작은 응답에는
쓸 이유가 없다. test_big_lists_skip_the_event_loop_encoder 가 큰 목록을 돌려주는 GET 을
찾아 이 길을 쓰는지 확인한다.
"""
from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse


def json_response(data: Any, status_code: int = 200) -> JSONResponse:
    """이미 JSON 모양인 값을 곧장 응답으로. datetime·Path 같은 것이 섞이면 쓰지 말 것
    (json.dumps 가 TypeError 를 낸다 — 조용히 틀린 값을 보내지는 않는다)."""
    return JSONResponse(content=data, status_code=status_code)
