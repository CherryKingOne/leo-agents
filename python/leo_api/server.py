"""HTTP 接口：FastAPI + uvicorn。打开 /docs 查看交互式接口文档。

请求经 Bridge 转给 Node 侧常驻的 leo（见 bridge.py / src/api/bridge.ts）。
Bridge 是阻塞式的，所以路由都用普通 def（FastAPI 自动放进线程池执行）。
"""

import json
import secrets
import sys
import time
import uuid
from typing import Any, Dict, Iterator, List, Optional, Union

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from . import __version__
from .bridge import Bridge, BridgeError

_STATUS = {
    "invalid_params": 400,
    "unauthorized": 401,
    "not_found": 404,
    "unknown_method": 404,
    "tool_not_found": 404,
    "busy": 409,
    "no_model": 503,
    "bridge_closed": 503,
}


# —— 请求模型 ——————————————————————————————————————————————————————————————
class ChatRequest(BaseModel):
    message: Union[str, List[Dict[str, Any]]] = Field(..., description="用户输入：文本，或内容块数组")
    session_id: Optional[str] = Field(None, description="会话 id；传入即续聊，不传则新建会话")
    model: Optional[str] = Field(None, description="模型，如 deepseek/deepseek-chat；不传用默认模型")
    system_prompt: Optional[str] = Field(None, description="覆盖 system prompt")
    max_steps: Optional[int] = Field(None, ge=1, description="本次最多模型调用次数")
    stream: bool = Field(False, description="true 时以 SSE 流式返回事件（event: text_delta / tool_start / ... / done）")


class ToolCallRequest(BaseModel):
    arguments: Dict[str, Any] = Field(default_factory=dict, description="工具参数")
    session_id: Optional[str] = Field(None, description="归属的会话 id（可选，用于审批与日志）")


class OpenAIMessage(BaseModel):
    role: str
    content: Union[str, List[Dict[str, Any]], None] = None


class OpenAIChatRequest(BaseModel):
    model: Optional[str] = "leo"
    messages: List[OpenAIMessage]
    stream: bool = False
    user: Optional[str] = Field(None, description="作为 leo 会话 id 使用")


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


def _sse(data: Any, event: Optional[str] = None) -> str:
    body = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    return ("event: %s\n" % event if event else "") + "data: %s\n\n" % body


def create_app(bridge: Bridge, token: Optional[str] = None) -> FastAPI:
    app = FastAPI(
        title="leo api",
        version=__version__,
        description="leo-agents 的 HTTP API：对话、会话、工具（含插件工具）、OpenAI 兼容接口。leo 常驻，插件一直在线。",
    )
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    bearer = HTTPBearer(auto_error=False)

    def auth(cred: Optional[HTTPAuthorizationCredentials] = Depends(bearer)) -> None:
        if token and not (cred and secrets.compare_digest(cred.credentials, token)):
            raise BridgeError("unauthorized", "缺少或错误的访问令牌（Authorization: Bearer <token>）")

    @app.exception_handler(BridgeError)
    def _bridge_error(_: Request, e: BridgeError) -> JSONResponse:
        return JSONResponse({"error": {"code": e.code, "message": e.message}}, status_code=_STATUS.get(e.code, 500))

    @app.exception_handler(RequestValidationError)
    def _validation_error(_: Request, e: RequestValidationError) -> JSONResponse:
        return JSONResponse({"error": {"code": "invalid_params", "message": str(e.errors())}}, status_code=400)

    @app.exception_handler(HTTPException)
    def _http_error(_: Request, e: HTTPException) -> JSONResponse:
        return JSONResponse({"error": {"code": "not_found" if e.status_code == 404 else "http_error", "message": str(e.detail)}}, status_code=e.status_code)

    def stream_events(params: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
        """开流前先取第一条：参数错误、会话忙等以普通 HTTP 错误返回。"""
        it = bridge.stream("chat", params)
        first = next(it)

        def gen() -> Iterator[Dict[str, Any]]:
            session_id = None
            finished = False
            try:
                for item in _chain(first, it):
                    if "event" in item and item["event"].get("type") == "turn_start":
                        session_id = item["event"].get("sessionId")
                    if "result" in item:
                        finished = True
                    yield item
            finally:
                # 客户端断开：取消 leo 中正在跑的任务
                if not finished and session_id:
                    try:
                        bridge.call("abort", {"sessionId": session_id})
                    except BridgeError:
                        pass

        return gen()

    # —— 路由 ——————————————————————————————————————————————————————————
    @app.get("/", include_in_schema=False)
    def root() -> RedirectResponse:
        return RedirectResponse("/docs")

    @app.get("/health", tags=["系统"], summary="存活检查")
    def health() -> Dict[str, Any]:
        return {"ok": True}

    @app.get("/v1/info", tags=["系统"], summary="版本、默认模型、插件、工具、活跃会话", dependencies=[Depends(auth)])
    def info() -> Any:
        return bridge.call("info")

    @app.get("/v1/models", tags=["系统"], summary="提供方与默认模型", dependencies=[Depends(auth)])
    def models() -> Any:
        return bridge.call("models")

    @app.get("/v1/plugins", tags=["插件"], summary="插件树与服务表", dependencies=[Depends(auth)])
    def plugins() -> Any:
        return bridge.call("plugins")

    @app.get("/v1/tools", tags=["插件"], summary="工具列表（JSON Schema，含插件注册的工具）", dependencies=[Depends(auth)])
    def tools() -> Any:
        return bridge.call("tools")

    @app.post("/v1/tools/{name}", tags=["插件"], summary="直接调用工具（含插件工具）", dependencies=[Depends(auth)])
    def call_tool(name: str, body: Optional[ToolCallRequest] = None) -> Any:
        body = body or ToolCallRequest()
        params: Dict[str, Any] = {"name": name, "arguments": body.arguments}
        if body.session_id:
            params["sessionId"] = body.session_id
        return bridge.call("tools.call", params)

    @app.get("/v1/sessions", tags=["会话"], summary="会话列表", dependencies=[Depends(auth)])
    def sessions() -> Any:
        return bridge.call("sessions.list")

    @app.get("/v1/sessions/{session_id}/messages", tags=["会话"], summary="会话消息", dependencies=[Depends(auth)])
    def session_messages(session_id: str) -> Any:
        return bridge.call("sessions.messages", {"sessionId": session_id})

    @app.delete("/v1/sessions/{session_id}", tags=["会话"], summary="删除会话", dependencies=[Depends(auth)])
    def delete_session(session_id: str) -> Any:
        return bridge.call("sessions.delete", {"sessionId": session_id})

    @app.post("/v1/sessions/{session_id}/abort", tags=["会话"], summary="取消会话当前任务", dependencies=[Depends(auth)])
    def abort(session_id: str) -> Any:
        return bridge.call("abort", {"sessionId": session_id})

    @app.post("/v1/chat", tags=["对话"], summary="对话（stream=true 时返回 SSE）", dependencies=[Depends(auth)])
    def chat(body: ChatRequest, accept: Optional[str] = Header(None)) -> Any:
        params: Dict[str, Any] = {"message": body.message}
        for src, dst in (("session_id", "sessionId"), ("model", "model"), ("system_prompt", "systemPrompt"), ("max_steps", "maxSteps")):
            v = getattr(body, src)
            if v is not None:
                params[dst] = v
        if not (body.stream or "text/event-stream" in (accept or "")):
            return bridge.call("chat", params)
        events = stream_events(params)

        def sse() -> Iterator[str]:
            try:
                for item in events:
                    if "event" in item:
                        yield _sse(item["event"], item["event"].get("type"))
                    else:
                        yield _sse(item["result"], "done")
            except BridgeError as e:
                yield _sse({"code": e.code, "message": e.message}, "error")

        return StreamingResponse(sse(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    @app.post("/v1/chat/completions", tags=["对话"], summary="OpenAI 兼容对话", dependencies=[Depends(auth)])
    def chat_completions(body: OpenAIChatRequest, x_session_id: Optional[str] = Header(None)) -> Any:
        user = [m for m in body.messages if m.role == "user"]
        if not user:
            raise BridgeError("invalid_params", "messages 里没有 user 消息")
        system = "\n".join(_content_text(m.content) for m in body.messages if m.role == "system")
        params: Dict[str, Any] = {"message": _content_text(user[-1].content)}
        if x_session_id or body.user:
            params["sessionId"] = x_session_id or body.user
        if body.model and body.model != "leo":
            params["model"] = body.model
        if system:
            params["systemPrompt"] = system
        cid = "chatcmpl-" + uuid.uuid4().hex
        created = int(time.time())
        model = body.model or "leo"

        def finish(r: Dict[str, Any]) -> Optional[str]:
            return "stop" if r.get("reason") == "completed" else r.get("reason")

        if not body.stream:
            r = bridge.call("chat", params) or {}
            usage = r.get("usage") or {}
            return {
                "id": cid,
                "object": "chat.completion",
                "created": created,
                "model": model,
                "session_id": r.get("sessionId"),
                "choices": [{"index": 0, "message": {"role": "assistant", "content": r.get("text", "")}, "finish_reason": finish(r)}],
                "usage": {
                    "prompt_tokens": usage.get("inputTokens", 0),
                    "completion_tokens": usage.get("outputTokens", 0),
                    "total_tokens": usage.get("inputTokens", 0) + usage.get("outputTokens", 0),
                },
            }
        events = stream_events(params)

        def chunk(delta: Dict[str, Any], reason: Optional[str] = None, extra: Optional[Dict[str, Any]] = None) -> str:
            data = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": reason}]}
            if extra:
                data.update(extra)
            return _sse(data)

        def sse() -> Iterator[str]:
            yield chunk({"role": "assistant"})
            try:
                for item in events:
                    if "event" in item:
                        if item["event"].get("type") == "text_delta":
                            yield chunk({"content": item["event"].get("text", "")})
                    else:
                        r = item["result"] or {}
                        yield chunk({}, finish(r), {"session_id": r.get("sessionId")})
                yield _sse("[DONE]")
            except BridgeError as e:
                yield _sse({"error": {"code": e.code, "message": e.message}})

        return StreamingResponse(sse(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    return app


def _chain(first: Dict[str, Any], it: Iterator[Dict[str, Any]]) -> Iterator[Dict[str, Any]]:
    yield first
    yield from it


def serve(bridge: Bridge, host: str, port: int, token: Optional[str]) -> int:
    import uvicorn

    app = create_app(bridge, token)
    try:
        info = bridge.call("info")
    except BridgeError:
        info = {}
    print(
        "leo api 已启动：http://%s:%s  接口文档 http://%s:%s/docs  （模型 %s，插件 %d 个%s）Ctrl+C 停止"
        % (host, port, host, port, info.get("model") or "无", len(info.get("plugins") or []), "，已启用令牌" if token else ""),
        file=sys.stderr,
        flush=True,
    )
    config = uvicorn.Config(app, host=host, port=port, log_level="info", access_log=True)
    server = uvicorn.Server(config)
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    return 0 if server.started else 1
