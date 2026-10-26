import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.cookies import SimpleCookie
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, urlparse


HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "3001"))
DATA_DIR = Path(os.environ.get("XIANGXIANG_DATA_DIR", Path.cwd() / "data"))
DB_FILE = DATA_DIR / "xiangxiang.sqlite3"
STATE_FILE = DATA_DIR / "state.json"
ARCHIVE_FILE = DATA_DIR / "idea-archive.json"
CONFIG_FILE = DATA_DIR / "config.json"
ACCESS_TOKEN_HASH = "ffa03f654b95f91c09b96e0222105b497475ad0947d76c4bbcc81ca58f2f0ed9"
ACCESS_CODE_HASH = os.environ.get(
    "HUA_ACCESS_CODE_HASH",
    "9930fbf03143b03c2f296e83966cb5c23a0e8c5c3010648b00545d27a4133073",
)
SESSION_COOKIE = "hua_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 180
COOKIE_SECURE = os.environ.get("HUA_COOKIE_SECURE", "1") != "0"
LOGIN_WINDOW = 10 * 60
LOGIN_MAX_ATTEMPTS = 8
THEMES = {"工作", "生活", "创作", "学习", "其他"}
KINDS = {"idea", "event"}
LOGIN_ATTEMPTS = {}
LOGIN_LOCK = threading.Lock()


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

DATA_DIR.mkdir(parents=True, exist_ok=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def clean_text(value, maximum):
    return str(value or "")[:maximum]


def clean_item(kind, item):
    if not isinstance(item, dict):
        return None
    item_id = clean_text(item.get("id"), 100)
    if not item_id:
        return None
    if kind == "idea":
        return {
            "id": item_id,
            "title": clean_text(item.get("title"), 120),
            "content": clean_text(item.get("content"), 20000),
            "theme": item.get("theme") if item.get("theme") in THEMES else "其他",
            "createdAt": clean_text(item.get("createdAt"), 60),
            "source": clean_text(item.get("source"), 20000),
        }
    return {
        "id": item_id,
        "title": clean_text(item.get("title"), 120),
        "note": clean_text(item.get("note"), 20000),
        "start": clean_text(item.get("start"), 60) if isinstance(item.get("start"), str) else None,
        "end": clean_text(item.get("end"), 60) if isinstance(item.get("end"), str) else None,
        "allDay": bool(item.get("allDay")),
        "done": bool(item.get("done")),
        "createdAt": clean_text(item.get("createdAt"), 60),
        "source": clean_text(item.get("source"), 20000),
    }


def clean_state(value):
    value = value if isinstance(value, dict) else {}
    raw_ideas = value.get("ideas") if isinstance(value.get("ideas"), list) else []
    raw_events = value.get("events") if isinstance(value.get("events"), list) else []
    ideas = [clean_item("idea", item) for item in raw_ideas]
    events = [clean_item("event", item) for item in raw_events]
    return {"ideas": [item for item in ideas if item], "events": [item for item in events if item]}


def clean_analysis(value):
    value = value if isinstance(value, dict) else {}
    ideas = []
    for item in (value.get("ideas") if isinstance(value.get("ideas"), list) else [])[:1]:
        ideas.append({
            "title": clean_text(item.get("title") or "未命名灵感", 80),
            "content": clean_text(item.get("content"), 20000),
            "theme": item.get("theme") if item.get("theme") in THEMES else "其他",
        })
    events = []
    for item in (value.get("events") if isinstance(value.get("events"), list) else [])[:8]:
        events.append({
            "title": clean_text(item.get("title") or "未命名日程", 80),
            "note": clean_text(item.get("note"), 1000),
            "start": item.get("start") if isinstance(item.get("start"), str) else None,
            "end": item.get("end") if isinstance(item.get("end"), str) else None,
            "allDay": bool(item.get("allDay")),
        })
    return {"ideas": ideas, "events": events}


def db_connect():
    connection = sqlite3.connect(str(DB_FILE), timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=30000")
    return connection


def init_database():
    with db_connect() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS records (
                kind TEXT NOT NULL CHECK(kind IN ('idea','event')),
                id TEXT NOT NULL,
                data_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(kind,id)
            );
            CREATE INDEX IF NOT EXISTS idx_records_kind_deleted
                ON records(kind,deleted,updated_at);
            CREATE TABLE IF NOT EXISTS changes (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK(kind IN ('idea','event')),
                record_id TEXT NOT NULL,
                data_json TEXT,
                deleted INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_changes_seq ON changes(seq);
            CREATE TABLE IF NOT EXISTS idea_archive (
                id TEXT PRIMARY KEY,
                data_json TEXT NOT NULL,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                deleted_at TEXT
            );
            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash TEXT PRIMARY KEY,
                expires_at INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
                ON auth_sessions(expires_at);
        """)
        migrated = db.execute("SELECT value FROM metadata WHERE key='legacy_migrated'").fetchone()
        if migrated:
            return
        migrate_legacy(db)
        db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('legacy_migrated',?)", (now_iso(),))


def read_json_file(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def write_change(db, kind, record_id, item, deleted, updated_at):
    data_json = None if deleted else json.dumps(item, ensure_ascii=False, separators=(",", ":"))
    db.execute(
        "INSERT OR REPLACE INTO records(kind,id,data_json,updated_at,deleted) VALUES(?,?,?,?,?)",
        (kind, record_id, data_json or "{}", updated_at, int(deleted)),
    )
    cursor = db.execute(
        "INSERT INTO changes(kind,record_id,data_json,deleted,updated_at) VALUES(?,?,?,?,?)",
        (kind, record_id, data_json, int(deleted), updated_at),
    )
    if kind == "idea":
        if deleted:
            db.execute(
                "UPDATE idea_archive SET last_seen_at=?,deleted_at=? WHERE id=?",
                (updated_at, updated_at, record_id),
            )
        else:
            archived = db.execute("SELECT first_seen_at FROM idea_archive WHERE id=?", (record_id,)).fetchone()
            first_seen = archived["first_seen_at"] if archived else updated_at
            db.execute(
                "INSERT OR REPLACE INTO idea_archive(id,data_json,first_seen_at,last_seen_at,deleted_at) VALUES(?,?,?,?,NULL)",
                (record_id, data_json, first_seen, updated_at),
            )
    return int(cursor.lastrowid)


def migrate_legacy(db):
    saved = read_json_file(STATE_FILE, {})
    state = clean_state(saved.get("state", saved))
    migrated_at = now_iso()
    for item in state["ideas"]:
        write_change(db, "idea", item["id"], item, False, migrated_at)
    for item in state["events"]:
        write_change(db, "event", item["id"], item, False, migrated_at)
    archive = read_json_file(ARCHIVE_FILE, {}).get("items", {})
    if isinstance(archive, dict):
        for record_id, item in archive.items():
            clean = clean_item("idea", {**item, "id": record_id})
            if not clean:
                continue
            first_seen = clean_text(item.get("firstSeenAt"), 60) or migrated_at
            last_seen = clean_text(item.get("lastSeenAt"), 60) or migrated_at
            deleted_at = clean_text(item.get("deletedAt"), 60) or None
            db.execute(
                """INSERT OR IGNORE INTO idea_archive(id,data_json,first_seen_at,last_seen_at,deleted_at)
                   VALUES(?,?,?,?,?)""",
                (record_id, json.dumps(clean, ensure_ascii=False, separators=(",", ":")), first_seen, last_seen, deleted_at),
            )


def current_state(db):
    state = {"ideas": [], "events": []}
    rows = db.execute("SELECT kind,data_json FROM records WHERE deleted=0 ORDER BY updated_at DESC").fetchall()
    for row in rows:
        try:
            item = json.loads(row["data_json"])
        except ValueError:
            continue
        state["ideas" if row["kind"] == "idea" else "events"].append(item)
    cursor = int(db.execute("SELECT COALESCE(MAX(seq),0) AS cursor FROM changes").fetchone()["cursor"])
    return state, cursor


def sync_page(db, cursor, limit):
    rows = db.execute(
        "SELECT seq,kind,record_id,data_json,deleted,updated_at FROM changes WHERE seq>? ORDER BY seq LIMIT ?",
        (cursor, limit + 1),
    ).fetchall()
    has_more = len(rows) > limit
    rows = rows[:limit]
    changes = []
    for row in rows:
        changes.append({
            "seq": int(row["seq"]),
            "kind": row["kind"],
            "id": row["record_id"],
            "deleted": bool(row["deleted"]),
            "item": None if row["deleted"] else json.loads(row["data_json"]),
            "updatedAt": row["updated_at"],
        })
    next_cursor = int(rows[-1]["seq"]) if rows else cursor
    return {"changes": changes, "cursor": next_cursor, "hasMore": has_more}


def apply_changes(db, incoming):
    if not isinstance(incoming, list) or len(incoming) > 500:
        raise ValueError("单次最多同步 500 条变更")
    applied = []
    for change in incoming:
        if not isinstance(change, dict):
            continue
        kind = change.get("kind")
        record_id = clean_text(change.get("id"), 100)
        if kind not in KINDS or not record_id:
            continue
        deleted = bool(change.get("deleted"))
        item = None if deleted else clean_item(kind, {**(change.get("item") or {}), "id": record_id})
        if not deleted and not item:
            continue
        updated_at = now_iso()
        seq = write_change(db, kind, record_id, item, deleted, updated_at)
        applied.append({
            "clientMutationId": clean_text(change.get("clientMutationId"), 100),
            "seq": seq,
            "kind": kind,
            "id": record_id,
            "updatedAt": updated_at,
        })
    cursor = int(db.execute("SELECT COALESCE(MAX(seq),0) AS cursor FROM changes").fetchone()["cursor"])
    compact_changes(db)
    return {"ok": True, "applied": applied, "cursor": cursor}


def compact_changes(db):
    counts = db.execute(
        "SELECT (SELECT COUNT(*) FROM changes) AS changes_count, (SELECT COUNT(*) FROM records) AS records_count"
    ).fetchone()
    if int(counts["changes_count"]) <= max(10_000, int(counts["records_count"]) * 3):
        return
    db.execute("""
        DELETE FROM changes
        WHERE seq NOT IN (SELECT MAX(seq) FROM changes GROUP BY kind,record_id)
    """)


def reconcile_state(db, state):
    clean = clean_state(state)
    existing = {(row["kind"], row["id"]): bool(row["deleted"]) for row in db.execute("SELECT kind,id,deleted FROM records")}
    incoming = {}
    for item in clean["ideas"]:
        incoming[("idea", item["id"])] = item
    for item in clean["events"]:
        incoming[("event", item["id"])] = item
    for (kind, record_id), item in incoming.items():
        write_change(db, kind, record_id, item, False, now_iso())
    for (kind, record_id), deleted in existing.items():
        if not deleted and (kind, record_id) not in incoming:
            write_change(db, kind, record_id, None, True, now_iso())
    cursor = int(db.execute("SELECT COALESCE(MAX(seq),0) AS cursor FROM changes").fetchone()["cursor"])
    return {"ok": True, "updatedAt": now_iso(), "version": cursor, "cursor": cursor}


def build_markdown(db):
    rows = db.execute(
        "SELECT data_json,first_seen_at,deleted_at FROM idea_archive ORDER BY first_seen_at DESC"
    ).fetchall()
    generated = now_iso()
    sections = []
    for index, row in enumerate(rows, 1):
        item = json.loads(row["data_json"])
        status = f"已从页面隐藏（{row['deleted_at']}）" if row["deleted_at"] else "当前可见"
        sections.append(
            f"## {index}. {item.get('title') or '未命名灵感'}\n"
            f"- 主题：{item.get('theme') or '其他'}\n"
            f"- 创建时间：{item.get('createdAt') or row['first_seen_at']}\n"
            f"- 状态：{status}\n\n{item.get('content') or ''}\n"
        )
    return f"# 想想 · 灵感知识库\n\n生成时间：{generated}\n灵感总数：{len(rows)}\n\n" + "\n".join(sections), generated


class Handler(BaseHTTPRequestHandler):
    server_version = "Xiangxiang/2.0"

    def log_message(self, fmt, *args):
        sys.stdout.write(f"{self.log_date_time_string()} {fmt % args}\n")

    def send_bytes(self, status, body, content_type="application/json; charset=utf-8", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive")
        origin = self.headers.get("Origin", "")
        if origin.startswith("http://localhost:") or origin.startswith("http://127.0.0.1:"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, value, extra=None):
        self.send_bytes(
            status,
            json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            extra=extra,
        )

    def read_json(self, maximum=1_000_000):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > maximum:
            raise ValueError("请求内容过大")
        body = self.rfile.read(length)
        if len(body) > maximum:
            raise ValueError("请求内容过大")
        return json.loads(body.decode("utf-8") or "{}")

    def authorized(self):
        value = self.headers.get("Authorization", "")
        token = value[7:] if value.startswith("Bearer ") else ""
        digest = hashlib.sha256(token.encode()).hexdigest()
        return hmac.compare_digest(digest, ACCESS_TOKEN_HASH)

    def client_address_key(self):
        forwarded = self.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
        return forwarded or self.client_address[0]

    def login_limited(self):
        key = self.client_address_key()
        cutoff = time.time() - LOGIN_WINDOW
        with LOGIN_LOCK:
            recent = [attempt for attempt in LOGIN_ATTEMPTS.get(key, []) if attempt >= cutoff]
            LOGIN_ATTEMPTS[key] = recent
            return len(recent) >= LOGIN_MAX_ATTEMPTS

    def record_login_failure(self):
        key = self.client_address_key()
        cutoff = time.time() - LOGIN_WINDOW
        with LOGIN_LOCK:
            recent = [attempt for attempt in LOGIN_ATTEMPTS.get(key, []) if attempt >= cutoff]
            recent.append(time.time())
            LOGIN_ATTEMPTS[key] = recent

    def clear_login_failures(self):
        with LOGIN_LOCK:
            LOGIN_ATTEMPTS.pop(self.client_address_key(), None)

    def session_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return ""
        morsel = cookie.get(SESSION_COOKIE)
        return morsel.value if morsel else ""

    def authenticated(self):
        token = self.session_token()
        if not token:
            return False
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        now = int(time.time())
        with db_connect() as db:
            db.execute("DELETE FROM auth_sessions WHERE expires_at<=?", (now,))
            row = db.execute(
                "SELECT 1 FROM auth_sessions WHERE token_hash=? AND expires_at>?",
                (token_hash, now),
            ).fetchone()
        return bool(row)

    def require_auth(self):
        if self.authenticated():
            return True
        self.send_json(401, {"error": "请先输入访问口令", "authenticated": False})
        return False

    def login(self):
        if self.login_limited():
            return self.send_json(429, {"error": "尝试次数过多，请十分钟后再试"})
        payload = self.read_json(8_000)
        code = payload.get("code")
        digest = hashlib.sha256(str(code or "").encode()).hexdigest()
        if not hmac.compare_digest(digest, ACCESS_CODE_HASH):
            self.record_login_failure()
            return self.send_json(401, {"error": "口令不正确"})
        self.clear_login_failures()
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        expires_at = int(time.time()) + SESSION_MAX_AGE
        with db_connect() as db:
            db.execute("DELETE FROM auth_sessions WHERE expires_at<=?", (int(time.time()),))
            db.execute(
                "INSERT INTO auth_sessions(token_hash,expires_at,created_at) VALUES(?,?,?)",
                (token_hash, expires_at, now_iso()),
            )
        secure = "; Secure" if COOKIE_SECURE else ""
        cookie = (
            f"{SESSION_COOKIE}={token}; Path=/hua; Max-Age={SESSION_MAX_AGE}; "
            f"HttpOnly; SameSite=Strict{secure}"
        )
        return self.send_json(200, {"ok": True, "authenticated": True}, {"Set-Cookie": cookie})

    def do_OPTIONS(self):
        self.send_bytes(204, b"", "text/plain", {
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
        })

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                with db_connect() as db:
                    count = int(db.execute("SELECT COUNT(*) AS count FROM records WHERE deleted=0").fetchone()["count"])
                return self.send_json(200, {"ok": True, "service": "xiangxiang-api", "storage": "sqlite", "records": count})
            if parsed.path == "/hua/api/auth":
                return self.send_json(200, {"authenticated": self.authenticated()})
            if parsed.path.startswith("/hua/api/") and not self.require_auth():
                return
            if parsed.path == "/hua/api/sync":
                query = parse_qs(parsed.query)
                cursor = max(0, int(query.get("cursor", ["0"])[0]))
                limit = min(500, max(1, int(query.get("limit", ["200"])[0])))
                with db_connect() as db:
                    return self.send_json(200, sync_page(db, cursor, limit))
            if parsed.path == "/hua/api/state":
                with db_connect() as db:
                    state, cursor = current_state(db)
                return self.send_json(200, {"state": state, "updatedAt": now_iso(), "version": cursor, "cursor": cursor})
            if parsed.path == "/hua/api/archive":
                with db_connect() as db:
                    markdown, generated = build_markdown(db)
                return self.send_bytes(200, markdown.encode("utf-8"), "text/markdown; charset=utf-8", {
                    "Content-Disposition": f'attachment; filename="xiangxiang-knowledge-{generated[:10]}.md"'
                })
            return self.send_json(404, {"error": "Not found"})
        except Exception as error:
            return self.send_json(500, {"error": str(error) or "服务暂时不可用"})

    def do_PUT(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path != "/hua/api/state":
                return self.send_json(404, {"error": "Not found"})
            if not self.require_auth():
                return
            payload = self.read_json(20_000_000)
            with db_connect() as db:
                result = reconcile_state(db, payload.get("state"))
            return self.send_json(200, result)
        except ValueError as error:
            return self.send_json(400, {"error": str(error)})
        except Exception as error:
            return self.send_json(500, {"error": str(error) or "服务暂时不可用"})

    def do_POST(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/hua/api/login":
                return self.login()
            if parsed.path.startswith("/hua/api/") and not self.require_auth():
                return
            if parsed.path == "/hua/api/sync":
                payload = self.read_json(1_000_000)
                with db_connect() as db:
                    result = apply_changes(db, payload.get("changes"))
                return self.send_json(200, result)
            if parsed.path == "/hua/api/setup":
                if not self.authorized():
                    return self.send_json(401, {"error": "服务配置访问密钥无效"})
                payload = self.read_json(64_000)
                api_key = payload.get("deepseekApiKey")
                if not isinstance(api_key, str) or not api_key:
                    return self.send_json(400, {"error": "缺少 DeepSeek API Key"})
                config = {
                    "deepseekApiKey": api_key.strip(),
                    "deepseekModel": clean_text(payload.get("deepseekModel") or "deepseek-v4-pro", 80),
                    "updatedAt": now_iso(),
                }
                CONFIG_FILE.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
                os.chmod(CONFIG_FILE, 0o600)
                return self.send_json(200, {"ok": True})
            if parsed.path == "/hua/api/analyze":
                return self.analyze()
            return self.send_json(404, {"error": "Not found"})
        except ValueError as error:
            return self.send_json(400, {"error": str(error)})
        except Exception as error:
            return self.send_json(500, {"error": str(error) or "服务暂时不可用"})

    def analyze(self):
        payload = self.read_json(128_000)
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            return self.send_json(400, {"error": "先写点什么吧"})
        config = read_json_file(CONFIG_FILE, {})
        if not config.get("deepseekApiKey"):
            return self.send_json(503, {"error": "服务端尚未配置 DeepSeek API Key"})
        long_form = bool(payload.get("longForm")) or len(text.strip()) > 100
        prompt = (
            "你是中文随手记应用的分类助手。分析用户的一整条记录，识别其中的“灵感”和明确“日程”。\n"
            "规则：\n1. 回车和空行只是原文格式，绝对不能据此把灵感拆成多条；ideas 最多返回一条。\n"
            "2. 灵感是想法、感悟、知识、待探索的概念。灵感 content 必须保留整条原文的段落和换行，不删减、不总结、不改写。\n"
            "3. 只有出现明确待办信号时才生成 events，例如：提醒、别忘、待办、截止、预约，或具体时间加明确行动。模糊愿望、观点、经验、设想和叙述中的动作都不是待办。\n"
            "4. 同一条记录可以保留为一条灵感，并额外抽取其中明确的待办；日程 title 用简短动作概括，note 只保留必要背景。\n"
            "5. 对相对时间结合当前时间转换成带时区的 ISO 8601；无时间线索时 start 为 null。\n"
            "6. 不要臆造用户未表达的细节。灵感主题只能是：工作、生活、创作、学习、其他。\n"
            "7. 输出严格 JSON：{\"ideas\":[{\"title\":\"短标题\",\"content\":\"完整内容\",\"theme\":\"创作\"}],"
            "\"events\":[{\"title\":\"短标题\",\"note\":\"补充说明\",\"start\":null,\"end\":null,\"allDay\":false}]}\n"
            f"这是长文：{'是；ideas 请返回空数组，只抽取明确待办' if long_form else '否'}\n"
            f"当前时间：{payload.get('now') or now_iso()}\n时区：{payload.get('timezone') or 'Asia/Shanghai'}\n用户输入：{text.strip()}"
        )
        upstream_body = json.dumps({
            "model": config.get("deepseekModel") or "deepseek-v4-pro",
            "messages": [
                {"role": "system", "content": "你只输出有效的 JSON 对象。"},
                {"role": "user", "content": prompt},
            ],
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"},
            "temperature": 0.15,
            "max_tokens": 1400,
        }, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            "https://api.deepseek.com/chat/completions",
            data=upstream_body,
            method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {config['deepseekApiKey']}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                detail = json.loads(error.read().decode("utf-8"))
                message = detail.get("error", {}).get("message") or f"DeepSeek 请求失败（{error.code}）"
            except (ValueError, AttributeError):
                message = f"DeepSeek 请求失败（{error.code}）"
            return self.send_json(502, {"error": message})
        content = (((result.get("choices") or [{}])[0].get("message") or {}).get("content"))
        if not content:
            return self.send_json(502, {"error": "AI 没有返回内容，请再试一次"})
        return self.send_json(200, clean_analysis(json.loads(content)))


if __name__ == "__main__":
    init_database()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"xiangxiang-api listening on http://{HOST}:{PORT} with SQLite", flush=True)
    server.serve_forever()
