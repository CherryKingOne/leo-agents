"""与 Node 侧 leo（src/api/bridge.ts）通信的 JSON Lines 客户端，线程安全。"""

import itertools
import json
import os
import queue
import sys
import threading
from typing import Any, Dict, Iterator, Optional, TextIO


class BridgeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class _Pending:
    __slots__ = ("queue",)

    def __init__(self) -> None:
        self.queue: "queue.Queue[Dict[str, Any]]" = queue.Queue()


class Bridge:
    def __init__(self, rx: TextIO, tx: TextIO):
        self._rx = rx
        self._tx = tx
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._pending: Dict[int, _Pending] = {}
        self._closed = False

    def start(self) -> None:
        threading.Thread(target=self._read_loop, name="leo-bridge", daemon=True).start()

    def _read_loop(self) -> None:
        for line in self._rx:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            p = self._pending.get(msg.get("id"))
            if p is not None:
                p.queue.put(msg)
        # Node 侧退出：没有 leo 就没有服务，直接结束进程
        self._closed = True
        for p in list(self._pending.values()):
            p.queue.put({"error": {"code": "bridge_closed", "message": "leo 进程已退出"}})
        print("leo api: 与 leo 的连接已断开，退出", file=sys.stderr)
        os._exit(1)

    def _send(self, method: str, params: Optional[Dict[str, Any]]) -> "tuple[int, _Pending]":
        if self._closed:
            raise BridgeError("bridge_closed", "leo 进程已退出")
        rid = next(self._ids)
        pending = _Pending()
        self._pending[rid] = pending
        data = json.dumps({"id": rid, "method": method, "params": params or {}}, ensure_ascii=False)
        with self._lock:
            self._tx.write(data + "\n")
            self._tx.flush()
        return rid, pending

    def stream(self, method: str, params: Optional[Dict[str, Any]] = None) -> Iterator[Dict[str, Any]]:
        """逐条产出 {"event": ...}，最后产出 {"result": ...}；出错抛 BridgeError。"""
        rid, pending = self._send(method, params)
        try:
            while True:
                msg = pending.queue.get()
                if "event" in msg:
                    yield {"event": msg["event"]}
                elif "error" in msg:
                    err = msg["error"] or {}
                    raise BridgeError(err.get("code", "internal"), err.get("message", "unknown error"))
                else:
                    yield {"result": msg.get("result")}
                    return
        finally:
            self._pending.pop(rid, None)

    def call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        result = None
        for item in self.stream(method, params):
            if "result" in item:
                result = item["result"]
        return result
