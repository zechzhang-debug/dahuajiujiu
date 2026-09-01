import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lessonDir = path.join(root, 'word-web-cloud', 'math-lessons');

const notes = {
  'angle-bisector-congruence-model-proof.html': [
    ['辅助线为什么这样作', '题目出现角平分线上的点 P，要证明它到角两边距离相等，就应把“距离”翻译成垂线段，因此分别作 PD⊥AB、PE⊥AC。'],
    ['判定条件如何对应', '两个三角形都有直角，角平分线给出 ∠DAP=∠PAE，AP 又是公共边。这里按“两个角和一条对应边”使用 AAS。'],
    ['常见误区', '点到直线的距离必须是垂线段，任意连接到角两边的线段不能直接当作距离；写全等时也要按 D 与 E 的对应顺序排列顶点。完成证明后，可再用对应边相等分别读出 PD=PE 与 AD=AE。']
  ],
  'bisector-parallel-isosceles-model-proof.html': [
    ['模型入口', '角平分线把一个大角分成两个相等角，平行线再把其中一个角搬到三角形的另一个顶点，两次等角传递后即可使用“等角对等边”。'],
    ['为什么不用全等', '目标只是证明 AD=DE。在 △ADE 内已经得到 ∠DAE=∠ADE，直接用等腰三角形判定最短，不需要额外构造三角形全等。'],
    ['常见误区', '平行线产生的是内错角或同位角，必须写清是哪两条直线被哪条截线所截，不能只写“因为平行，所以两个角相等”。最后还要指出等角位于同一个三角形内，才能推出对应边相等。']
  ],
  'hand-in-hand-congruence-model-proof.html': [
    ['隐藏夹角从哪里来', '已知两个顶角相等，而 △ABD 与 △ACE 需要的是 ∠BAD 与 ∠CAE。把公共部分同时加上或减去，剩余的两角仍相等。'],
    ['为什么是 SAS', 'AB=AC、AD=AE 是两组对应边，∠BAD=∠CAE 正好是它们的夹角，因此满足边角边，不是容易误用的边边角。'],
    ['结论如何迁移', '全等后不仅得到 BD=CE，还能得到 ∠ABD=∠ACE。后续题目常利用这组对应角继续证明平行、垂直或新的等腰三角形。']
  ],
  'general-horse-reflection-model-proof.html': [
    ['为什么反射一个端点', 'P 在对称轴 l 上时，AP=A′P，所以反射可以在不改变路径长度的前提下，把同侧的折线改造成连接 A′ 与 B 的折线。'],
    ['最小值为何能取到', '三角形两边之和不小于第三边给出 A′P+PB≥A′B；当 A′、P、B 共线时等号成立，因此 A′B 是能够达到的最小值。'],
    ['作图时注意', '连接 A′B 后要取它与 l 的交点作为 P。如果交点不在线段 A′B 上，应结合题目对 P 的范围判断是否需要讨论端点。']
  ],
  'square-half-angle-model-proof.html': [
    ['为什么旋转 90°', '正方形提供 AD=AB 和直角，把 △ADF 绕 A 旋转 90° 后，DF 可以搬到与 BE 同一直线的方向，为证明线段和创造条件。'],
    ['45° 条件的作用', '∠EAF 是正方形直角的一半。旋转后的射线 AH 与 AF 相差 90°，结合半角关系可得到 ∠EAH=∠EAF，为 SAS 全等补齐夹角。'],
    ['最后怎样拼线段', '由全等得到 EH=EF，而旋转又给 BH=DF。由于 E、B、H 共线，EH=EB+BH，于是 EF=BE+DF。关键是先确认三点的顺序。']
  ]
};

for (const [filename, items] of Object.entries(notes)) {
  const filePath = path.join(lessonDir, filename);
  let html = fs.readFileSync(filePath, 'utf8');
  if (!html.includes('data-review="model"')) {
    const details = items.map(([title, copy]) => `<details open><summary>${title}</summary><div class="proof"><p>${copy}</p></div></details>`).join('');
    const section = `<section class="card" data-review="model"><h2>方法复盘</h2>${details}</section>`;
    html = html.replace('<footer class="footer">', `${section}<footer class="footer">`);
  }
  html = html.replace(
    '写全等时也要按 D 与 E 的对应顺序排列顶点。</p>',
    '写全等时也要按 D 与 E 的对应顺序排列顶点。完成证明后，可再用对应边相等分别读出 PD=PE 与 AD=AE。</p>'
  );
  html = html.replace(
    '不能只写“因为平行，所以两个角相等”。</p>',
    '不能只写“因为平行，所以两个角相等”。最后还要指出等角位于同一个三角形内，才能推出对应边相等。</p>'
  );
  fs.writeFileSync(filePath, html, 'utf8');
}
