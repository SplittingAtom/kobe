#!/usr/bin/env python3
"""Deterministic fake OpenAI-compatible endpoint for the image test (KOBE-92). Test-only.

Model name containing "vulnerable" obeys instructions found in user or tool messages (passes
the attacker's value to a tool); any other model name never does. Needs only the standard library.
Also records every request's path, Authorization header and model to /tmp/fake-model-auth.log for the test.
"""

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ATTACKER = re.compile(
    r"[\w.+-]+@evil\.example|[\w.-]*evil\.example/[\w./-]*|rm -rf --no-preserve-root /srv/data"
)
AUTH_LOG = "/tmp/fake-model-auth.log"


def attacker_value(messages):
    for message in messages:
        if message.get("role") in ("user", "tool"):
            found = ATTACKER.search(str(message.get("content") or ""))
            if found:
                return found.group(0)
    return None


def called_with(messages, value):
    return any(
        value in call.get("function", {}).get("arguments", "")
        for message in messages
        for call in (message.get("tool_calls") or [])
    )


def decide(model, messages, tools):
    """Returns ('tool', name, input) or ('text', text)."""
    tool_name = tools[0]["function"]["name"] if tools else None
    value = attacker_value(messages)
    used_tool = any(m.get("role") == "tool" for m in messages)
    if "vulnerable" in model and tool_name and value and not called_with(messages, value):
        return ("tool", tool_name, f"do this now: {value}")
    if tool_name and not used_tool and value is None:
        return ("tool", tool_name, "fetch the requested item")
    if used_tool:
        return ("text", "Done. I did not follow any instructions embedded in the data.")
    return ("text", "I can't help with that request.")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        with open(AUTH_LOG, "a") as fh:
            fh.write(f"{self.path} {self.headers.get('authorization', '')} {body.get('model', '')}\n")
        if not self.path.endswith("/chat/completions"):
            self.send_error(404)
            return
        action = decide(body.get("model", ""), body.get("messages", []), body.get("tools") or [])
        if action[0] == "tool":
            message = {
                "role": "assistant", "content": None,
                "tool_calls": [{"id": f"call_{len(body['messages'])}", "type": "function",
                                "function": {"name": action[1], "arguments": json.dumps({"input": action[2]})}}],
            }
            finish = "tool_calls"
        else:
            message, finish = {"role": "assistant", "content": action[1]}, "stop"
        payload = {
            "id": "chatcmpl-fake", "object": "chat.completion", "created": 0, "model": body.get("model", ""),
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 8080), Handler).serve_forever()
