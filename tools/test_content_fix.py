import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest
import urllib.request
from deploy_content_fix import deploy, digest, ALLOWED

ROOT=Path(__file__).resolve().parents[1]
SITE=ROOT/'word-web-cloud'
MANIFEST=ROOT/'.github/content-fixes/20261105.json'

class ContentTests(unittest.TestCase):
    def test_reviewed_data_and_rendered_pages_match(self):
        data=json.loads((ROOT/'tools/classical-reviewed.json').read_text(encoding='utf8'))
        html=(SITE/'chinese-classical.html').read_text(encoding='utf8')
        embedded=html.split('const data=',1)[1].split('\n    const params=',1)[0].strip().rstrip(';')
        self.assertEqual(json.loads(embedded),data)
        for stage,entries in data.items():
            self.assertEqual(len(entries),16)
            page=(SITE/f'chinese-{stage}.html').read_text(encoding='utf8')
            for _,word,meaning,examples in entries:
                self.assertEqual(len(examples),2)
                for e in examples:
                    self.assertIn(word,e['text'])
                    self.assertIn(e['text'],page)
                    self.assertIn(e['source'],page)
                    self.assertIn(e['note'],page)
        for bad in ['安徽亳州','兵台旧址建楼','以叫操蛇之神','好，爱慕、草']:
            self.assertNotIn(bad,html)
    def test_geometry_in_general_and_external_foot_cases(self):
        for b in [2,4,7]:
            for c in [3,5,9]:
                for deg in [25,45,70,88]:
                    a=math.radians(deg)
                    A=(0,0); B=(c,0); C=(b*math.cos(a),b*math.sin(a))
                    D=((b*B[0]+c*C[0])/(b+c),c*C[1]/(b+c))
                    E=(c*C[0]/(b+c),c*C[1]/(b+c))
                    self.assertAlmostEqual(math.dist(A,E),math.dist(D,E))
                    x=b*math.cos(a);h=b*math.sin(a)
                    self.assertAlmostEqual(abs(c-x)**2+h*h,b*b+c*c-2*b*c*math.cos(a))
        page=(SITE/'math-lessons/bisector-parallel-isosceles-model-proof.html').read_text(encoding='utf8')
        self.assertNotIn('AD=DE',page)
        self.assertIn('AE=DE',page)
    def test_deployment_keeps_english_and_rejects_stale_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp); release=base/'release';target=base/'site'
            (release/'files').mkdir(parents=True);target.mkdir()
            (target/'index.html').write_bytes(b'old page')
            (target/'words_primary.txt').write_bytes(b'English stays identical')
            (release/'files/index.html').write_bytes(b'corrected page')
            manifest={'files':[{'path':'index.html','before_sha256':digest(target/'index.html'),'after_sha256':digest(release/'files/index.html')}]}
            (release/'manifest.json').write_text(json.dumps(manifest))
            deploy(release,target,base/'backup')
            self.assertEqual((target/'index.html').read_bytes(),b'corrected page')
            self.assertEqual((base/'backup/index.html').read_bytes(),b'old page')
            self.assertEqual((target/'words_primary.txt').read_bytes(),b'English stays identical')
            with self.assertRaisesRegex(ValueError,'changed since review'):
                deploy(release,target,base/'backup2')
            self.assertFalse((base/'backup2').exists())
    def test_manifest_scope_and_checksums(self):
        rows=json.loads(MANIFEST.read_text())['files']
        self.assertTrue(rows)
        self.assertEqual(len(rows),len({r["path"] for r in rows}))
        for row in rows:
            self.assertIn(row['path'],ALLOWED)
            self.assertEqual(digest(SITE/row['path']),row['after_sha256'])

if __name__=='__main__':
    if '--live' in sys.argv:
        for row in json.loads(MANIFEST.read_text())['files']:
            url='https://dahuajiujiu.com/'+row['path']
            body=urllib.request.urlopen(url,timeout=30).read()
            assert hashlib.sha256(body).hexdigest()==row['after_sha256'],url
            print('PUBLIC_OK '+row['path'])
    else:
        unittest.main()
