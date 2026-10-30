"""leo api：leo-agents 的 HTTP API 服务（FastAPI + uvicorn，uv 管理环境）。

由 `leo api` 启动：Node 进程持有常驻的 leo 实例（插件一直在线），
本包作为子进程，通过 stdin/stdout 的 JSON Lines 与它通信，并对外提供 HTTP 接口。
"""

__version__ = "0.1.0"
