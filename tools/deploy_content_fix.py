"""Deploy an explicitly listed content correction, with conflict checks and rollback."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

ALLOWED = {
    'index.html', 'math.html', 'physics.html', 'chinese.html',
    'chinese-classical.html', 'chinese-junior.html', 'chinese-senior.html', 'about.html',
    'math-lessons/bisector-parallel-isosceles-model-proof.html',
    'math-lessons/cosine-law-proof-junior.html',
    'math-lessons/junior2-congruence-finale.html',
    'math-lessons/junior2-fraction-equation-finale.html',
}

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def atomic_copy(source, destination):
    fd, tmp = tempfile.mkstemp(prefix='.content-fix-', dir=destination.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(source.read_bytes())
            f.flush()
            os.fsync(f.fileno())
        shutil.copymode(destination, tmp)
        os.replace(tmp, destination)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

def deploy(release, target, backup):
    release, target, backup = map(lambda p: Path(p).resolve(), (release, target, backup))
    rows = json.loads((release/'manifest.json').read_text(encoding='utf-8'))['files']
    assert rows and len({r['path'] for r in rows}) == len(rows)
    # Complete preflight before any production write.
    for row in rows:
        rel = row['path']
        if rel not in ALLOWED:
            raise ValueError('File outside content-only scope: '+rel)
        dest = target/rel
        if dest.is_symlink() or os.path.commonpath([str(dest.resolve()), str(target)]) != str(target):
            raise ValueError('Unexpected destination link: '+rel)
        if digest(dest) != row['before_sha256']:
            raise ValueError('Live file changed since review: '+rel)
        if digest(release/'files'/rel) != row['after_sha256']:
            raise ValueError('Invalid release checksum: '+rel)
    backup.mkdir(parents=True, exist_ok=False)
    for row in rows:
        dest = backup/row['path']
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target/row['path'], dest)
    shutil.copy2(release/'manifest.json', backup/'manifest.json')
    changed=[]
    try:
        for row in rows:
            rel=row['path']
            # Check again to avoid overwriting another deployment during backup.
            if digest(target/rel) != row['before_sha256']:
                raise ValueError('Concurrent content change: '+rel)
            changed.append(rel)
            atomic_copy(release/'files'/rel, target/rel)
        for row in rows:
            if digest(target/row['path']) != row['after_sha256']:
                raise ValueError('Post-deployment checksum mismatch')
    except BaseException:
        for rel in reversed(changed):
            atomic_copy(backup/rel, target/rel)
        raise
    print('CONTENT_FIX_OK files='+str(len(rows))+' backup='+str(backup))

if __name__ == '__main__':
    deploy(*sys.argv[1:])
