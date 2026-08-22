import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path


SERVER = Path(__file__).with_name("server.py")


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class XiangxiangApiTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        data_dir = Path(self.temp.name)
        legacy = {
            "state": {
                "ideas": [{
                    "id": "idea-old", "title": "旧灵感", "content": "迁移内容",
                    "theme": "创作", "createdAt": "2026-08-22T00:00:00Z", "source": "原话"
                }],
                "events": [{
                    "id": "event-old", "title": "旧日程", "note": "迁移日程", "start": None,
                    "end": None, "allDay": False, "done": False,
                    "createdAt": "2026-08-22T00:00:00Z", "source": "原话"
                }],
            }
        }
        (data_dir / "state.json").write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")
        self.port = free_port()
        env = {**os.environ, "PORT": str(self.port), "XIANGXIANG_DATA_DIR": str(data_dir)}
        self.process = subprocess.Popen(
            [sys.executable, str(SERVER)], env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        for _ in range(50):
            try:
                if self.get("/health").get("ok"):
                    break
            except Exception:
                time.sleep(0.05)
        else:
            output = self.process.stdout.read() if self.process.stdout else ""
            self.fail(f"server did not start: {output}")

    def tearDown(self):
        self.process.terminate()
        self.process.wait(timeout=5)
        if self.process.stdout:
            self.process.stdout.close()
        self.temp.cleanup()

    def request(self, path, method="GET", body=None):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))

    def get(self, path):
        return self.request(path)

    def test_migrates_legacy_and_syncs_incrementally(self):
        first = self.get("/hua/api/sync?cursor=0&limit=10")
        self.assertEqual(2, len(first["changes"]))
        cursor = first["cursor"]

        created = self.request("/hua/api/sync", "POST", {"changes": [{
            "kind": "idea", "id": "idea-new", "deleted": False,
            "clientMutationId": "mutation-1",
            "item": {"id": "idea-new", "title": "新灵感", "content": "只上传这一条", "theme": "学习"},
        }]})
        self.assertTrue(created["ok"])
        self.assertEqual("mutation-1", created["applied"][0]["clientMutationId"])

        delta = self.get(f"/hua/api/sync?cursor={cursor}&limit=10")
        self.assertEqual(["idea-new"], [change["id"] for change in delta["changes"]])
        state = self.get("/hua/api/state")["state"]
        self.assertEqual(2, len(state["ideas"]))
        self.assertEqual(1, len(state["events"]))

    def test_delete_is_a_tombstone(self):
        initial = self.get("/hua/api/sync?cursor=0&limit=10")
        self.request("/hua/api/sync", "POST", {"changes": [{
            "kind": "idea", "id": "idea-old", "deleted": True, "clientMutationId": "delete-1"
        }]})
        delta = self.get(f"/hua/api/sync?cursor={initial['cursor']}&limit=10")
        self.assertTrue(delta["changes"][0]["deleted"])
        self.assertEqual([], self.get("/hua/api/state")["state"]["ideas"])


if __name__ == "__main__":
    unittest.main()
