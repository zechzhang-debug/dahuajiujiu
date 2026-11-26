import calendar
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
from html import escape
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
from socketserver import ThreadingMixIn
import threading
import time
from urllib.parse import parse_qs, urlsplit


BEIJING = timezone(timedelta(hours=8))
ORIGIN = 'https://dahuajiujiu.com'
DEVICE = '__Secure-wenan_device'
SESSION = '__Secure-wenan_session'
TOKEN = re.compile(r'[A-Za-z0-9_-]{43}\Z')
VIDEO_ID = re.compile(r'\d{15,23}\Z')
BASE = '/wenan'
MAX_SLOTS = 8
MAX_SYNC_BYTES = 4 * 1024 * 1024
SESSION_LIFE = 7 * 86400
DEVICE_LIFE = 365 * 86400


def digest(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def earliest(now):
    d = datetime.fromtimestamp(now, BEIJING)
    year, month = divmod(d.year*12+d.month-1-2, 12)
    return int(d.replace(year=year, month=month+1, day=min(d.day, calendar.monthrange(year, month+1)[1])).timestamp())


def moment(when):
    return datetime.fromtimestamp(when, BEIJING).strftime('%Y-%m-%d %H:%M')


def cookie(name, token, age):
    return f'{name}={token}; Path={BASE}; Max-Age={age}; Secure; HttpOnly; SameSite=Strict'


STYLE = '''
:root{color-scheme:light dark;--background:#f8faf9;--foreground:#172521;--muted-foreground:#526760;--border:#d6e1dc;--surface:#fff;--accent:#e9f1ec;--prime:#1d624e;--blue:#275bd1;--orange:#ac4c12;--font-size-base:15px}
@media(prefers-color-scheme:dark){:root{--background:#171e1c;--foreground:#edf6f0;--muted-foreground:#aebfb7;--border:#34453e;--surface:#202a26;--accent:#2b3c35;--prime:#72d1ac;--blue:#86a8ff;--orange:#ffa772}}
*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font:400 15px/1.55 system-ui,'Microsoft YaHei',sans-serif}main{max-width:1080px;margin:auto;padding:22px 24px 50px}.bar{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);margin-bottom:20px;padding-bottom:12px}.bar strong{color:var(--prime)}h1,h2,h3,p{margin:0}h1{font-size:26px}h2{font-size:22px}h3{font-size:16px}.text-small{font-size:13px}.text-muted{color:var(--muted-foreground)}.tabular-nums{font-variant-numeric:tabular-nums}.viz-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}hr{margin:18px 0;border:0;border-top:1px solid var(--border)}
.btn,button{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:7px 12px;color:var(--foreground);font:inherit;cursor:pointer}.btn-primary,.btn[aria-pressed=true],.submit{background:var(--prime);color:var(--background);border-color:var(--prime)}.btn-ghost:not([aria-pressed=true]){background:transparent;border-color:transparent}.btn-ghost:hover:not([aria-pressed=true]){background:var(--accent)}button:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--prime);outline-offset:3px}.cursor-interaction{cursor:pointer}a{color:var(--prime)}
.auth{max-width:405px;margin:8vh auto 0}.auth h1{margin-bottom:12px}.auth form,.editor form{display:grid;gap:10px}.auth label,.editor label{display:grid;gap:5px}.auth .submit{justify-self:start}input,textarea,select{width:100%;font:inherit;min-width:0;color:var(--foreground);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 10px}textarea{min-height:68px;resize:vertical}select{width:auto;max-width:100%}.error{color:#bc472b}.archive-list{display:flex;gap:8px 12px;align-items:center;flex-wrap:wrap;margin:6px 0 12px}.archive-list form{display:flex;gap:8px;align-items:center;min-width:0;flex-wrap:wrap}.tag{display:inline-block;padding:2px 7px;background:var(--accent);color:var(--prime);border-radius:4px;font-size:13px}.archive ol{margin:0 0 12px;padding-left:1.45em}.archive li{margin:0 0 6px;overflow-wrap:anywhere}.archive li p{white-space:pre-wrap}.editor{margin-top:12px}.editor summary{width:fit-content;color:var(--prime);cursor:pointer}.editor form{margin-top:12px}.draft-row{border:0;border-bottom:1px solid var(--border);margin:0;padding:0 0 10px;display:grid;gap:6px;min-width:0}.draft-row legend{color:var(--muted-foreground);padding:0;margin-bottom:4px}.add-draft{justify-self:start}.archive-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.editor [hidden]{display:none}.bar form{margin:0}.auth .error{margin:0 0 12px}
@media(max-width:600px){main{padding:16px 14px 36px}input,select,textarea{font-size:16px}.auth{margin:4vh auto 0}}
@media(max-width:380px){.bar .btn{padding:5px 8px}.archive-list form{width:100%}.archive-list select{max-width:100%}}
'''

EDIT_SCRIPT = '''document.getElementById("wenan-more")?.addEventListener("click",function(){const r=document.querySelector(".draft-row[hidden]");if(r){r.hidden=false;r.querySelector("input").focus()}if(!document.querySelector(".draft-row[hidden]"))this.hidden=true});'''


class Store:
    def __init__(self, root, asset):
        self.root = root
        self.asset = asset
        self.settings = json.loads((root/'settings.json').read_text(encoding='utf-8'))
        self.fragment = (asset/'compass.html').read_text(encoding='utf-8')
        if self.fragment.count('<!-- WENAN_ARCHIVE -->') != 1 or 'dc-embedded' not in self.fragment:
            raise ValueError('invalid private fragment')
        embedded=re.search(r'<script id="dc-embedded" type="application/json">([\s\S]+?)</script>',self.fragment)
        self.evidence={}
        if embedded:
            for author in json.loads(embedded.group(1))['accounts']:
                for row in author['rows']:
                    if row.get('w') and VIDEO_ID.fullmatch(row['id']):
                        self.evidence[row['id']]=row
        template=asset/'compass-template.html'
        self.template=template.read_text(encoding='utf-8') if template.is_file() else ''
        if self.template and (self.template.count('__COMPASS_DATA__')!=1 or self.template.count('<!-- WENAN_ARCHIVE -->')!=1):
            raise ValueError('invalid private dashboard template')
        token_file=root/'sync-fingerprint'
        self.sync_fingerprint=token_file.read_text(encoding='ascii').strip() if token_file.is_file() else ''
        seed = json.loads((asset/'seed.json').read_text(encoding='utf-8'))
        with self.db() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS flags (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS device (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS session (token TEXT PRIMARY KEY, device TEXT NOT NULL, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS attempt (device TEXT PRIMARY KEY, failures INTEGER NOT NULL, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS dashboard (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
            ''')
            db.execute('BEGIN IMMEDIATE')
            db.executemany('INSERT OR REPLACE INTO evidence VALUES(?,?)',[(ident,json.dumps(row,ensure_ascii=False)) for ident,row in self.evidence.items()])
            if db.execute("INSERT OR IGNORE INTO flags VALUES('seeded',1)").rowcount:
                db.execute('INSERT INTO versions(created,body) VALUES(?,?)',(seed['created'],json.dumps(seed['items'],ensure_ascii=False)))
            update=asset/'revision.json'
            if update.is_file():
                revision=json.loads(update.read_text(encoding='utf-8'))
                key='revision:'+revision['id']
                if db.execute('INSERT OR IGNORE INTO flags VALUES(?,1)',(key,)).rowcount:
                    self.append_in(db,revision['items'],revision['created'])
            self.prune(db, int(time.time()))

    @contextmanager
    def db(self):
        db = sqlite3.connect(str(self.root/'wenan.sqlite3'), timeout=3)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def prune(self, db, now):
        db.execute('DELETE FROM versions WHERE created < ?', (earliest(now),))
        for table in ('device','session','attempt'):
            db.execute(f'DELETE FROM {table} WHERE expires <= ?', (now,))

    def has_device(self, token, now):
        if not TOKEN.fullmatch(token):
            return False
        with self.db() as db:
            return db.execute('SELECT 1 FROM device WHERE token=? AND expires>?',(digest(token),now)).fetchone() is not None

    def has_session(self, token, device, now):
        if not TOKEN.fullmatch(token) or not TOKEN.fullmatch(device):
            return False
        with self.db() as db:
            sql = 'SELECT 1 FROM session JOIN device ON session.device=device.token WHERE session.token=? AND device.token=? AND session.expires>? AND device.expires>?'
            return db.execute(sql,(digest(token),digest(device),now,now)).fetchone() is not None

    def password_ok(self, password):
        if not password or len(password)>128:
            return False
        h = hashlib.pbkdf2_hmac('sha256',password.encode('utf-8'),bytes.fromhex(self.settings['salt']),600000).hex()
        return secrets.compare_digest(h,self.settings['verifier'])

    def issue_session(self, db, device, now):
        token = secrets.token_urlsafe(32)
        db.execute('DELETE FROM session WHERE device=?',(device,))
        db.execute('INSERT INTO session VALUES(?,?,?)',(digest(token),device,now+SESSION_LIFE))
        return token

    def login(self, device, password, now):
        if not self.has_device(device, now):
            return 'binding-required',None
        key = digest(device)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT failures,expires FROM attempt WHERE device=?',(key,)).fetchone()
            live = row and row['expires']>now
            if live and row['failures']>=5:
                return 'locked',None
            if not self.password_ok(password):
                count = 1+row['failures'] if live else 1
                db.execute('INSERT OR REPLACE INTO attempt VALUES(?,?,?)',(key,count,now+900))
                return 'wrong',None
            db.execute('DELETE FROM attempt WHERE device=?',(key,))
            return 'ok',self.issue_session(db,key,now)

    def enroll(self, code, password, now):
        if not TOKEN.fullmatch(code) or self.settings['activation_expires']<=now or not secrets.compare_digest(digest(code),self.settings['activation']):
            return None
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute("SELECT 1 FROM flags WHERE key='bound'").fetchone():
                return None
            attempt = db.execute("SELECT failures,expires FROM attempt WHERE device='enroll'").fetchone()
            live = attempt and attempt['expires']>now
            if live and attempt['failures']>=5:
                return None
            if not self.password_ok(password):
                db.execute("INSERT OR REPLACE INTO attempt VALUES('enroll',?,?)",(1+attempt['failures'] if live else 1,now+900))
                return None
            device = secrets.token_urlsafe(32)
            db.execute("INSERT INTO flags VALUES('bound',1)")
            db.execute('INSERT INTO device VALUES(?,?)',(digest(device),now+DEVICE_LIFE))
            return device,self.issue_session(db,digest(device),now)

    def versions(self, now):
        with self.db() as db:
            self.prune(db, now)
            return db.execute('SELECT id,created,body FROM versions ORDER BY created DESC,id DESC').fetchall()

    def reference(self, ident):
        if not VIDEO_ID.fullmatch(ident):
            return None
        with self.db() as db:
            item=db.execute('SELECT body FROM evidence WHERE id=?',(ident,)).fetchone()
        return json.loads(item['body']) if item else None

    def current_fragment(self):
        if self.template:
            with self.db() as db:
                row=db.execute('SELECT body FROM dashboard WHERE id=1').fetchone()
                if row:
                    return self.template.replace('__COMPASS_DATA__',row['body'].replace('<','\\u003c'))
        return self.fragment

    def authorized_release(self, header):
        prefix='Wenan-Update '
        if not self.template or not re.fullmatch(r'[0-9a-f]{64}',self.sync_fingerprint) or not header.startswith(prefix):
            return False
        candidate=header[len(prefix):]
        return TOKEN.fullmatch(candidate) and secrets.compare_digest(digest(candidate),self.sync_fingerprint)

    def sync_release(self, package, now):
        if not isinstance(package,dict) or set(package)-{'compass','revision'}:
            raise ValueError('invalid release')
        compass=package['compass']
        topics=compass['topics']
        hooks=compass['hooks']
        authors=compass['accounts']
        if not (2<=len(authors)<=40 and 1<=len(topics)<=24 and 1<=len(hooks)<=24):
            raise ValueError('invalid dashboard dimensions')
        all_ids=set()
        source={}
        for a in authors:
            if not isinstance(a['name'],str) or not (1<=len(a['name'])<=100) or not isinstance(a['floor'],int) or a['floor']<0 or not isinstance(a['base'],int) or a['base']<len(a['rows']) or not a['rows']:
                raise ValueError('invalid account metrics')
            counts={}
            for row in a['rows']:
                ident=row['id']
                if not VIDEO_ID.fullmatch(ident) or ident in all_ids or row['t'] not in topics or row['h'] not in hooks or not isinstance(row['l'],int) or row['l']<max(1,a['floor']) or not isinstance(row['x'],str):
                    raise ValueError('invalid work identity or metrics')
                all_ids.add(ident)
                topic=row['t']
                counts[topic]=1+counts.get(topic,0)
                words=row.get('w')
                if topic!='other' and counts[topic]<=3 and (not isinstance(words,str) or not words.strip()):
                    raise ValueError('a recommended work has no full script')
                if words:
                    if not isinstance(words,str) or len(words)>32767:
                        raise ValueError('invalid full script')
                    source[ident]=row
        if len(all_ids)>20000:
            raise ValueError('too many videos')
        revision=package.get('revision')
        if revision:
            if not isinstance(revision,dict) or not re.fullmatch(r'[a-f0-9]{64}',revision['id']) or not isinstance(revision['created'],int) or not earliest(now)<=revision['created']<=now+600 or not 1<=len(revision['items'])<=MAX_SLOTS:
                raise ValueError('invalid revision')
            for x in revision['items']:
                if not isinstance(x['title'],str) or not 1<=len(x['title'])<=200 or not isinstance(x['body'],str) or len(x['body'])>3000 or x['source'] not in source:
                    raise ValueError('invalid reference or suggestion')
        normalized=json.dumps(compass,ensure_ascii=False,separators=(',',':'),allow_nan=False)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            self.prune(db,now)
            db.execute('INSERT OR REPLACE INTO dashboard VALUES(1,?)',(normalized,))
            db.executemany('INSERT OR REPLACE INTO evidence VALUES(?,?)',[(ident,json.dumps(row,ensure_ascii=False)) for ident,row in source.items()])
            if revision and db.execute('INSERT OR IGNORE INTO flags VALUES(?,1)',('revision:'+revision['id'],)).rowcount:
                self.append_in(db,revision['items'],revision['created'])
            latest=db.execute('SELECT id FROM versions ORDER BY created DESC,id DESC LIMIT 1').fetchone()
        return {'works':len(all_ids),'fullScripts':len(source),'latestVersion':latest['id'] if latest else None}

    def append(self, items, now):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            self.prune(db, now)
            self.append_in(db,items,now)

    @staticmethod
    def append_in(db, items, now):
        body = json.dumps(items,ensure_ascii=False)
        latest = db.execute('SELECT body FROM versions ORDER BY created DESC,id DESC LIMIT 1').fetchone()
        if not latest or latest['body']!=body:
            db.execute('INSERT INTO versions(created,body) VALUES(?,?)',(now,body))


ERRORS = {'wrong':'密码不正确。','binding-required':'当前浏览器还未绑定。','locked':'尝试次数过多，请 15 分钟后再试。','bind':'绑定失败。请核对密码和一次性绑定码。'}


def shell(body, nonce, bar=''):
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>文案工作台 · 大华舅舅</title><style nonce="{nonce}">{STYLE}</style></head><body><main><header class="bar"><strong>大华舅舅 · 文案工作台</strong>{bar}</header>{body}</main></body></html>'''


def locked(bound, nonce, problem=None):
    notice = f'<p class="error" role="alert">{escape(ERRORS.get(problem,"请求失败。"))}</p>' if problem else ''
    fields = '<label>登录密码<input name="password" type="password" maxlength="128" autocomplete="current-password" required></label>'
    if bound:
        form = f'<form method="post" action="/wenan/login">{fields}<button class="submit" type="submit">登录</button></form>'
    else:
        form = f'<form method="post" action="/wenan/bind">{fields}<label>一次性绑定码<input name="code" autocomplete="off" spellcheck="false" maxlength="43" required></label><button class="submit" type="submit">绑定并登录</button></form>'
    return shell(f'<section class="auth" data-wenan-locked><h1>私人文案工作台</h1>{notice}{form}</section>',nonce)


def archive(versions, wanted, nonce):
    latest = versions[0] if versions else None
    selected = next((row for row in versions if str(row['id'])==wanted),latest)
    choices = ''.join(f'<option value="{r["id"]}"{" selected" if selected and r["id"]==selected["id"] else ""}>{moment(r["created"])} · 版本 {r["id"]}{"（最新）" if r["id"]==latest["id"] else ""}</option>' for r in versions)
    dates = f'<form method="get" action="/wenan"><label for="version">历史版本</label><select id="version" name="version">{choices}</select><button type="submit">查看</button></form>' if choices else ''
    items = json.loads(selected['body']) if selected else []
    rendered=[]
    for x in items:
        ident=x.get('source','')
        ref=f'<p class="text-small"><a href="/wenan/transcript?id={ident}">查看参考原稿</a></p>' if VIDEO_ID.fullmatch(ident) else ''
        rendered.append(f'<li><strong>{escape(x["title"])}</strong><p class="text-muted">{escape(x["body"])}</p>{ref}</li>')
    display=''.join(rendered)
    fields = []
    current = json.loads(latest['body']) if latest else []
    show = min(MAX_SLOTS,max(3,len(current)))
    for i in range(MAX_SLOTS):
        item = current[i] if i<len(current) else {'title':'','body':''}
        src=escape(item.get('source',''),quote=True)
        fields.append(f'<fieldset class="draft-row"{" hidden" if i>=show else ""}><legend>选题 {i+1}</legend><label>标题<input name="title{i}" maxlength="200" value="{escape(item["title"],quote=True)}"></label><label>建议<textarea name="body{i}" maxlength="3000" rows="2">{escape(item["body"])}</textarea></label><input type="hidden" name="source{i}" value="{src}"></fieldset>')
    stamp = f'<time class="tag">更新于 {moment(selected["created"])}</time>' if selected else '<span class="text-muted">最近两个月暂无更新</span>'
    return f'''<section class="archive" id="wenan-archive"><h3>文案建议</h3><div class="archive-list">{stamp}{dates}</div>{'<ol>'+display+'</ol>' if display else ''}<details class="editor"><summary>更新文案建议</summary><form method="post" action="/wenan/suggestions">{''.join(fields)}<div class="archive-actions"><button id="wenan-more" type="button"{' hidden' if show==MAX_SLOTS else ''}>添加选题</button><button class="submit" type="submit">保存新版本</button></div></form></details></section><script nonce="{nonce}">{EDIT_SCRIPT}</script>'''


class Handler(BaseHTTPRequestHandler):
    server_version = 'Wenan'

    def log_message(self, *args):
        return

    def reply(self, status, body='', headers=(), nonce='', media='text/html; charset=utf-8'):
        data = body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type',media)
        self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','private, no-store')
        self.send_header('X-Robots-Tag','noindex, nofollow, noarchive')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','same-origin')
        self.send_header('X-Frame-Options','DENY')
        self.send_header('Content-Security-Policy',f"default-src 'none'; style-src 'nonce-{nonce}'; script-src 'nonce-{nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
        for key,value in headers:
            self.send_header(key,value)
        self.end_headers()
        if self.command!='HEAD' and data:
            self.wfile.write(data)

    def redirect(self, location=BASE, headers=(), status=303):
        self.reply(status,headers=[('Location',location),*headers])

    def tokens(self):
        try:
            tokens=SimpleCookie(self.headers.get('Cookie',''))
        except CookieError:
            return '',''
        return tuple(tokens[k].value if k in tokens else '' for k in (DEVICE,SESSION))

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path==BASE+'/':
            return self.redirect(status=308)
        if url.path not in (BASE,BASE+'/transcript'):
            return self.reply(404)
        nonce=secrets.token_urlsafe(18)
        device,session=self.tokens()
        now=int(time.time())
        store=self.server.store
        if not store.has_session(session,device,now):
            if url.path!=BASE:
                return self.reply(403)
            return self.reply(200,locked(store.has_device(device,now),nonce),nonce=nonce)
        if url.path==BASE+'/transcript':
            ident=parse_qs(url.query).get('id',[''])[0]
            row=store.reference(ident)
            if not row:
                return self.reply(404)
            body=f'<article class="archive"><p><a href="/wenan">返回文案工作台</a></p><h1>{escape(row["x"])}</h1><p class="text-small text-muted">原声机器转写 · 完整口播</p><p><a href="https://www.douyin.com/video/{ident}" target="_blank" rel="noopener noreferrer">原视频</a></p><ol><li><p>{escape(row["w"])}</p></li></ol></article>'
            return self.reply(200,shell(body,nonce),nonce=nonce)
        wanted=parse_qs(url.query).get('version',[''])[0]
        part=store.current_fragment().replace('<style>','<style nonce="'+nonce+'">').replace('<script>','<script nonce="'+nonce+'">')
        part=part.replace('<!-- WENAN_ARCHIVE -->',archive(store.versions(now),wanted,nonce))
        bar='<form method="post" action="/wenan/logout"><button class="btn" type="submit">退出登录</button></form>'
        return self.reply(200,shell(part,nonce,bar),nonce=nonce)

    def do_POST(self):
        route=urlsplit(self.path).path
        if route==BASE+'/_sync':
            if self.headers.get('Origin') or not self.server.store.authorized_release(self.headers.get('Authorization','')):
                return self.reply(404)
            length=self.headers.get('Content-Length','')
            if not length.isdigit() or not 0<int(length)<=MAX_SYNC_BYTES:
                return self.reply(413)
            if self.headers.get_content_type()!='application/json':
                return self.reply(415)
            try:
                update=json.loads(self.rfile.read(int(length)).decode('utf-8'))
                result=self.server.store.sync_release(update,int(time.time()))
            except (ValueError,KeyError,TypeError,AttributeError):
                return self.reply(422)
            return self.reply(200,json.dumps(result),media='application/json; charset=utf-8')
        if route not in [BASE+'/'+r for r in ('login','bind','logout','suggestions')]:
            return self.reply(404)
        if self.headers.get('Origin')!=ORIGIN:
            return self.reply(403)
        length=self.headers.get('Content-Length','')
        if not length.isdigit() or int(length)>64*1024:
            return self.reply(413)
        if self.headers.get_content_type()!='application/x-www-form-urlencoded':
            return self.reply(415)
        raw = self.rfile.read(int(length)).decode('utf-8',errors='replace')
        if raw.count('&')>25 or ';' in raw:
            return self.reply(400)
        values=parse_qs(raw,keep_blank_values=True)
        form=lambda key:values.get(key,[''])[0].strip()
        device,session=self.tokens()
        now=int(time.time())
        store=self.server.store
        nonce=secrets.token_urlsafe(18)
        if route==BASE+'/bind':
            bound=store.enroll(form('code'),form('password'),now)
            if not bound:
                return self.reply(403,locked(store.has_device(device,now),nonce,'bind'),nonce=nonce)
            return self.redirect(headers=[('Set-Cookie',cookie(DEVICE,bound[0],DEVICE_LIFE)),('Set-Cookie',cookie(SESSION,bound[1],SESSION_LIFE))])
        if route==BASE+'/login':
            status, token=store.login(device,form('password'),now)
            if not token:
                return self.reply(429 if status=='locked' else 403,locked(store.has_device(device,now),nonce,status),nonce=nonce)
            return self.redirect(headers=[('Set-Cookie',cookie(SESSION,token,SESSION_LIFE))])
        if not store.has_session(session,device,now):
            return self.reply(403)
        if route==BASE+'/logout':
            with store.db() as db:
                db.execute('DELETE FROM session WHERE token=?',(digest(session),))
            return self.redirect(headers=[('Set-Cookie',cookie(SESSION,'',0))])
        items=[]
        for i in range(MAX_SLOTS):
            title,body=form(f'title{i}'),form(f'body{i}')
            if not title and not body:
                continue
            if not title or len(title)>200 or len(body)>3000:
                return self.reply(422,shell('<p class="error">请给每条建议填写标题，并检查内容长度。</p><p><a href="/wenan">返回文案工作台</a></p>',nonce),nonce=nonce)
            item={'title':title,'body':body}
            source=form(f'source{i}')
            if store.reference(source):
                item['source']=source
            items.append(item)
        if not items:
            return self.reply(422,shell('<p class="error">请至少保留一条文案建议。</p><p><a href="/wenan">返回文案工作台</a></p>',nonce),nonce=nonce)
        store.append(items,now)
        return self.redirect()


def gc_loop(store):
    while True:
        time.sleep(3600)
        try:
            with store.db() as db:
                store.prune(db,int(time.time()))
        except sqlite3.Error:
            pass


class PrivateServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def main():
    directory=Path(os.environ.get('WENAN_STATE','/var/lib/dahuajiujiu-wenan'))
    files=Path(os.environ.get('WENAN_ASSETS','/usr/local/lib/dahuajiujiu-wenan'))
    store=Store(directory,files)
    server=PrivateServer(('127.0.0.1',int(os.environ.get('WENAN_PORT',3017))),Handler)
    server.store=store
    threading.Thread(target=gc_loop,args=(store,),daemon=True).start()
    server.serve_forever()


if __name__=='__main__':
    main()
