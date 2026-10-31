import argparse
import os
import sys

from .bridge import Bridge
from .server import serve


def main() -> int:
    parser = argparse.ArgumentParser(prog="leo api", description="leo HTTP API 服务（由 leo api 启动）")
    parser.add_argument("--host", default=os.environ.get("LEO_API_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("LEO_API_PORT", "8765")))
    args = parser.parse_args()

    # stdout 是与 Node 通信的通道，其他输出一律走 stderr
    channel_out = sys.stdout
    sys.stdout = sys.stderr
    bridge = Bridge(sys.stdin, channel_out)
    bridge.start()
    return serve(bridge, args.host, args.port, os.environ.get("LEO_API_TOKEN") or None)


if __name__ == "__main__":
    sys.exit(main())
