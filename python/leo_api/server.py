"""HTTP 接口（标准库 ThreadingHTTPServer）。

接口一览（JSON 进 JSON 出；chat 支持 SSE 流式）：

  GET    /health                          存活检查
  GET    /v1/info                         版本、默认模型、插件、工具、活跃会话
  GET    /v1/models                       提供方与默认模型
  GET    /v1/tools                        工具列表（JSON Schema）
  GET    /v1/plugins                      插件树与服务表
  GET    /v1/sessions                     会话列表
  GET    /v1/sessions/{id}/messages       会话消息
  DELETE /v1/sessions/{id}                删除会话
  POST   /v1/sessions/{id}/abort          取消会话当前任务
  POST   /v1/chat                         对话 {message, session_id?, model?, system_prompt?, max_steps?, stream?}
  POST   /v1/tools/{name}                 直接调用工具（含插件工具）{arguments?, session_id?}
  POST   /v1/chat/completions             OpenAI 兼容对话（取最后一条 user 消息；会话用 user 字段或 X-Session-Id）
"""

import json
import secrets
import sys
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional
from urllib.parse import unquote, urlsplit

from . import __version__
from .bridge import Bridge, BridgeError

_STATUS = {
    "invalid_params": 400,
    "invalid_json": 400,
    "unauthorized": 401,
    "not_found": 404,
    "unknown_method": 404,
    "tool_not_found": 404,
    "busy": 409,
    "no_model": 503,
    "bridge_closed": 503,
}


def _camel(params: Dict[str, Any], mapping: Dict[str, str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for src, dst in mapping.items():
        if src in params and params[src] is not None:
            out[dst] = params[src]
        elif dst in params and params[dst] is not None:
            out[dst] = params[dst]
    return out


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


class Handler(BaseHTTPRequestHandler):
    server_version = "leo-api/" + __version__
    protocol_version = "HTTP/1.1"
    bridge: Bridge
    token: Optional[str] = None

    # —— 基础设施 ——————————————————————————————————————————————————————
    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("leo api: %s %s\n" % (self.address_string(), fmt % args))

    def _json(self, status: int, body: Any) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _error(self, code: str, message: str, status: Optional[int] = None) -> None:
        self._json(status or _STATUS.get(code, 500), {"error": {"code": code, "message": message}})

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Session-Id")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")

    def _body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except ValueError:
            raise BridgeError("invalid_json", "请求体不是合法 JSON")
        if not isinstance(data, dict):
            raise BridgeError("invalid_json", "请求体必须是 JSON 对象")
        return data

    def _authorized(self) -> bool:
        if not self.token:
            return True
        got = self.headers.get("Authorization", "")
        return got.startswith("Bearer ") and secrets.compare_digest(got[7:].strip(), self.token)

    def _sse_start(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self._cors()
        self.end_headers()
        self.close_connection = True

    def _sse(self, data: Any, event: Optional[str] = None) -> None:
        chunk = ("event: %s\n" % event if event else "") + "data: %s\n\n" % (
            data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
        )
        self.wfile.write(chunk.encode("utf-8"))
        self.wfile.flush()

    def _route(self, method: str) -> None:
        path = urlsplit(self.path).path.rstrip("/") or "/"
        if method == "OPTIONS":
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/health":
            return self._json(200, {"ok": True})
        if not self._authorized():
            return self._error("unauthorized", "缺少或错误的访问令牌（Authorization: Bearer <token>）")
        parts = [unquote(p) for p in path.strip("/").split("/")]
        try:
            self._dispatch(method, parts)
        except BridgeError as e:
            self._error(e.code, e.message)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            self._error("internal", str(e))

    def do_GET(self) -> None:
        self._route("GET")

    def do_POST(self) -> None:
        self._route("POST")

    def do_DELETE(self) -> None:
        self._route("DELETE")

    def do_OPTIONS(self) -> None:
        self._route("OPTIONS")

    # —— 路由 ——————————————————————————————————————————————————————————
    def _dispatch(self, method: str, parts: list) -> None:
        b = self.bridge
        if parts[0] != "v1":
            raise BridgeError("not_found", "没有这个接口：%s" % self.path)
        rest = parts[1:]
        if method == "GET" and rest in (["info"], ["models"], ["tools"], ["plugins"]):
            return self._json(200, b.call(rest[0]))
        if rest == ["sessions"] and method == "GET":
            return self._json(200, b.call("sessions.list"))
        if len(rest) == 3 and rest[0] == "sessions" and rest[2] == "messages" and method == "GET":
            return self._json(200, b.call("sessions.messages", {"sessionId": rest[1]}))
        if len(rest) == 2 and rest[0] == "sessions" and method == "DELETE":
            return self._json(200, b.call("sessions.delete", {"sessionId": rest[1]}))
        if len(rest) == 3 and rest[0] == "sessions" and rest[2] == "abort" and method == "POST":
            return self._json(200, b.call("abort", {"sessionId": rest[1]}))
        if rest == ["chat"] and method == "POST":
            return self._chat(self._body())
        if rest == ["chat", "completions"] and method == "POST":
            return self._openai(self._body())
        if len(rest) == 2 and rest[0] == "tools" and method == "POST":
            body = self._body()
            params = {"name": rest[1], "arguments": body.get("arguments", {})}
            params.update(_camel(body, {"session_id": "sessionId"}))
            return self._json(200, b.call("tools.call", params))
        raise BridgeError("not_found", "没有这个接口：%s %s" % (method, self.path))

    def _wants_stream(self, body: Dict[str, Any]) -> bool:
        return bool(body.get("stream")) or "text/event-stream" in self.headers.get("Accept", "")

    def _chat(self, body: Dict[str, Any]) -> None:
        params = _camel(
            body,
            {"message": "message", "session_id": "sessionId", "model": "model", "system_prompt": "systemPrompt", "max_steps": "maxSteps"},
        )
        if not self._wants_stream(body):
            return self._json(200, self.bridge.call("chat", params))
        it = self.bridge.stream("chat", params)
        try:
            first = next(it)  # 参数错误、会话忙等在开流前以普通 HTTP 错误返回
        except BridgeError as e:
            return self._error(e.code, e.message)
        self._sse_start()
        session_id = None
        try:
            for item in _chain(first, it):
                if "event" in item:
                    ev = item["event"]
                    if ev.get("type") == "turn_start":
                        session_id = ev.get("sessionId")
                    self._sse(ev, ev.get("type"))
                else:
                    self._sse(item["result"], "done")
        except BridgeError as e:
            self._sse({"code": e.code, "message": e.message}, "error")
        except (BrokenPipeError, ConnectionResetError):
            if session_id:
                try:
                    self.bridge.call("abort", {"sessionId": session_id})
                except BridgeError:
                    pass

    def _openai(self, body: Dict[str, Any]) -> None:
        messages = body.get("messages") or []
        user = [m for m in messages if isinstance(m, dict) and m.get("role") == "user"]
        if not user:
            raise BridgeError("invalid_params", "messages 里没有 user 消息")
        system = "\n".join(_content_text(m.get("content")) for m in messages if isinstance(m, dict) and m.get("role") == "system")
        params: Dict[str, Any] = {"message": _content_text(user[-1].get("content"))}
        session_id = self.headers.get("X-Session-Id") or body.get("user")
        if session_id:
            params["sessionId"] = session_id
        if body.get("model") and body.get("model") != "leo":
            params["model"] = body["model"]
        if system:
            params["systemPrompt"] = system
        cid = "chatcmpl-" + uuid.uuid4().hex
        created = int(time.time())
        model = body.get("model") or "leo"
        if not body.get("stream"):
            r = self.bridge.call("chat", params)
            usage = r.get("usage") or {}
            return self._json(
                200,
                {
                    "id": cid,
                    "object": "chat.completion",
                    "created": created,
                    "model": model,
                    "session_id": r.get("sessionId"),
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": r.get("text", "")}, "finish_reason": "stop" if r.get("reason") == "completed" else r.get("reason")}],
                    "usage": {
                        "prompt_tokens": usage.get("inputTokens", 0),
                        "completion_tokens": usage.get("outputTokens", 0),
                        "total_tokens": usage.get("inputTokens", 0) + usage.get("outputTokens", 0),
                    },
                },
            )
        it = self.bridge.stream("chat", params)
        try:
            first = next(it)
        except BridgeError as e:
            return self._error(e.code, e.message)
        self._sse_start()

        def chunk(delta: Dict[str, Any], finish: Optional[str] = None, extra: Optional[Dict[str, Any]] = None) -> None:
            data = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if extra:
                data.update(extra)
            self._sse(data)

        sid = None
        try:
            chunk({"role": "assistant"})
            for item in _chain(first, it):
                if "event" in item:
                    ev = item["event"]
                    if ev.get("type") == "turn_start":
                        sid = ev.get("sessionId")
                    elif ev.get("type") == "text_delta":
                        chunk({"content": ev.get("text", "")})
                else:
                    r = item["result"] or {}
                    chunk({}, "stop" if r.get("reason") == "completed" else r.get("reason"), {"session_id": r.get("sessionId")})
            self._sse("[DONE]")
        except BridgeError as e:
            self._sse({"error": {"code": e.code, "message": e.message}})
        except (BrokenPipeError, ConnectionResetError):
            if sid:
                try:
                    self.bridge.call("abort", {"sessionId": sid})
                except BridgeError:
                    pass


def _chain(first: Dict[str, Any], it: Any):
    yield first
    yield from it


def serve(bridge: Bridge, host: str, port: int, token: Optional[str]) -> int:
    handler = type("LeoHandler", (Handler,), {"bridge": bridge, "token": token})
    try:
        httpd = ThreadingHTTPServer((host, port), handler)
    except OSError as e:
        print("leo api: 无法监听 %s:%s：%s" % (host, port, e), file=sys.stderr)
        return 1
    httpd.daemon_threads = True
    real_port = httpd.server_address[1]
    try:
        info = bridge.call("info")
    except BridgeError:
        info = {}
    print(
        "leo api 已启动：http://%s:%s  （模型 %s，插件 %d 个%s）Ctrl+C 停止"
        % (host, real_port, info.get("model") or "无", len(info.get("plugins") or []), "，已启用令牌" if token else ""),
        file=sys.stderr,
        flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0
