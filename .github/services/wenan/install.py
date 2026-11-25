import grp
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request


APP = 'dahuajiujiu-wenan'
LIB = Path('/usr/local/lib') / APP
STATE = Path('/var/lib') / APP
USER = 'dahuawenan'
HOST = 'dahuajiujiu.com'
DIAL = '127.0.0.1:3017'
ADMIN = 'http://127.0.0.1:2019'
ROUTE_ID = 'private-wenan-dahuajiujiu'


SERVICE = '''[Unit]
Description=Dahuajiujiu private Wenan workspace
After=network.target

[Service]
User=dahuawenan
Group=dahuawenan
UMask=0077
Environment=WENAN_ASSETS=/var/lib/dahuajiujiu-wenan
ExecStart=/usr/bin/python3 /usr/local/lib/dahuajiujiu-wenan/server.py
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/dahuajiujiu-wenan

[Install]
WantedBy=multi-user.target
'''

HOOK = '''[Service]
ExecStartPost=-/usr/bin/python3 /usr/local/lib/dahuajiujiu-wenan/install.py --route
ExecReload=-/usr/bin/python3 /usr/local/lib/dahuajiujiu-wenan/install.py --route
'''


def admin(path, method='GET', body=None):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    request = urllib.request.Request(ADMIN+path,data=data,method=method,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=5) as response:
        value=response.read()
        return json.loads(value.decode('utf-8')) if value else None


def choose_server(servers):
    def score(pair):
        _, config = pair
        hosts = {host for r in config.get('routes',[]) for m in r.get('match',[]) for host in m.get('host',[])}
        secure = any(addr.endswith(':443') for addr in config.get('listen',[]))
        return (HOST in hosts, secure)
    if not servers:
        raise RuntimeError('no Caddy HTTP server')
    ranking = sorted(servers.items(),key=score,reverse=True)
    name, selected = ranking[0]
    if not any(score(ranking[0])) or not re.fullmatch(r'[a-zA-Z0-9_-]+',name):
        raise RuntimeError('cannot identify production Caddy server')
    if len(ranking)>1 and score(ranking[0])==score(ranking[1]):
        raise RuntimeError('ambiguous production Caddy server')
    return name,selected


def route():
    for attempt in range(8):
        try:
            servers=admin('/config/apps/http/servers')
            break
        except (OSError,urllib.error.URLError):
            if attempt==7:
                raise
            time.sleep(1)
    server, config=choose_server(servers)
    wanted={'@id':ROUTE_ID,'match':[{'host':[HOST],'path':['/wenan','/wenan/*']}],
            'handle':[{'handler':'reverse_proxy','upstreams':[{'dial':DIAL}]}],'terminal':True}
    relevant=[r for r in config.get('routes',[]) if r.get('@id')==ROUTE_ID]
    if len(relevant)>1:
        raise RuntimeError('duplicate private route')
    if not relevant:
        admin('/config/apps/http/servers/'+server+'/routes/0','PUT',wanted)
    elif relevant[0]!=wanted:
        admin('/id/'+ROUTE_ID,'PATCH',wanted)
    target=admin('/id/'+ROUTE_ID)
    if target!=wanted:
        raise RuntimeError('Caddy private route not active')


def publish(path, data, mode, owner=0, group=0):
    alternate=path.with_suffix(path.suffix+'.new')
    try:
        fd=os.open(str(alternate),os.O_WRONLY | os.O_CREAT | os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chown(str(alternate),owner,group)
        alternate.chmod(mode)
        alternate.replace(path)
    finally:
        if alternate.exists():
            alternate.unlink()


def python_check(path):
    compile(path.read_bytes(),str(path),'exec')


def systemctl(*args):
    subprocess.run(['systemctl',*args],check=True)


def check_local():
    for attempt in range(12):
        try:
            with urllib.request.urlopen('http://'+DIAL+'/wenan',timeout=2) as reply:
                body=reply.read()
                if reply.status==200 and b'data-wenan-locked' in body and b'dc-embedded' not in body:
                    return
        except OSError:
            pass
        time.sleep(.5)
    raise RuntimeError('private origin health check did not pass')


def install(stage):
    if os.geteuid()!=0:
        raise SystemExit('root required')
    agent=stage/'server.py'
    hook=stage/'install.py'
    python_check(agent)
    python_check(hook)
    choose_server(admin('/config/apps/http/servers'))
    with tarfile.open(str(stage/'private.tgz'),'r:gz') as release:
        wanted={'compass.html','settings.json','seed.json'}
        members=release.getmembers()
        if len(members)!=len(wanted) or {m.name for m in members}!=wanted or any(not m.isfile() or m.size>400000 for m in members):
            raise RuntimeError('private release contents mismatch')
        files={m.name:release.extractfile(m).read() for m in members}
    if files['compass.html'].count(b'<!-- WENAN_ARCHIVE -->')!=1:
        raise RuntimeError('invalid private dashboard')
    json.loads(files['seed.json'].decode('utf-8'))
    setting=json.loads(files['settings.json'].decode('utf-8'))
    if not all(re.fullmatch('[a-f0-9]{64}',setting[k]) for k in ('salt','verifier','activation')):
        raise RuntimeError('invalid private credential data')
    try:
        account=pwd.getpwnam(USER)
    except KeyError:
        subprocess.run(['/usr/sbin/useradd','--system','--user-group','--no-create-home','--home-dir',str(STATE),'--shell','/sbin/nologin',USER],check=True)
        account=pwd.getpwnam(USER)
    gid=grp.getgrnam(USER).gr_gid
    uid=account.pw_uid
    STATE.mkdir(mode=0o700,exist_ok=True)
    os.chown(str(STATE),uid,gid)
    STATE.chmod(0o700)
    LIB.mkdir(mode=0o755,exist_ok=True)
    LIB.chmod(0o755)
    for name, data in files.items():
        dest=STATE/name
        if name=='settings.json' and dest.exists():
            continue
        publish(dest,data,0o600,uid,gid)
    publish(LIB/'server.py',agent.read_bytes(),0o644)
    publish(LIB/'install.py',hook.read_bytes(),0o644)
    unit=Path('/etc/systemd/system')/(APP+'.service')
    publish(unit,SERVICE.encode('utf-8'),0o644)
    subprocess.run(['systemd-analyze','verify',str(unit)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    systemctl('daemon-reload')
    systemctl('enable',APP)
    systemctl('restart',APP)
    check_local()
    route()
    # The primary Caddy service starts from a Caddyfile, so restore this isolated route after service-managed reloads.
    drop=Path('/etc/systemd/system/caddy.service.d')
    drop.mkdir(mode=0o755,exist_ok=True)
    publish(drop/'40-dahua-wenan.conf',HOOK.encode('utf-8'),0o644)
    systemctl('daemon-reload')
    print('Private Wenan service active; existing application files untouched.')


if __name__=='__main__':
    if sys.argv[1]=='--route':
        route()
    else:
        install(Path(sys.argv[1]))
