import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lessonDir = path.join(root, 'word-web-cloud', 'math-lessons');

const reviews = {
  'junior1-number-line-finale.html': [
    ['为什么先分位置', '绝对值表示距离，去掉绝对值符号时必须先知道 P 在 A、B 的左侧、之间还是右侧。P 在两点之间时，两段距离可以首尾相接成 AB；在区间外时，多走的距离会被计算两次。'],
    ['容易出错的地方', '不能直接把 |x+2|+|x−6| 写成 |2x−4|。两个绝对值分别表示两段距离，只有确定符号后才能化简。'],
    ['结果怎样检查', '把 x=−4 和 x=8 分别代入，距离和都是 12；再取区间内的 x=0，距离和为 2+6=8，说明最小值判断成立。']
  ],
  'junior1-algebra-finale.html': [
    ['为什么要处理公共边', '拼接后，长方形与正方形重合的那一段已经进入图形内部，不再属于外周长。最稳定的算法是“两个图形周长之和减去两倍公共边”。'],
    ['容易出错的地方', '公共边长为 x，要减去的是 2x，因为它在长方形周长和正方形周长中各被计算了一次。'],
    ['结果怎样检查', '取 x=2 时，原长方形长 8、宽 1，周长 18；拼上边长 2 的正方形后增加 4，得到 22，与代数式 10x+2 一致。']
  ],
  'junior1-equation-finale.html': [
    ['为什么两个式子能相等', '24x 是按每人 24 元得到的总钱数，它比计划多 48 元，所以 24x−48 才是计划总额；22x 比计划少 24 元，所以 22x+24 也是计划总额。'],
    ['容易出错的地方', '“多收”要从实际收款中减去，“少收”要向实际收款中补上。不要看到“多”就机械地在式子里写加号。'],
    ['结果怎样检查', '36 人按 24 元收取是 864 元，比 816 元多 48 元；按 22 元收取是 792 元，比 816 元少 24 元，两句话都满足。']
  ],
  'junior1-angle-finale.html': [
    ['为什么先求大角', 'A、O、B 在同一直线上，所以 ∠AOC 与 ∠COB 组成平角。先得到 ∠COB，角平分线 OD 才能把它平均分成两个确定的角。'],
    ['容易出错的地方', '∠EOD 不是 ∠EOC 与 ∠COD 的差。根据射线顺序，OE 位于 OA 与 OC 之间，因此 ∠EOD=∠EOC+∠COD。'],
    ['结果怎样检查', '∠EOC=30°，再加 ∠COD=70°，恰好得到题设的 ∠EOD=100°；同时 ∠COD=∠DOB，符合角平分线定义。']
  ],
  'junior1-digit-divisibility-finale.html': [
    ['为什么先确定首尾', '百位比个位大 2 是最强的限制条件，在数字 1、2、3、4 中只可能出现 (3,1) 或 (4,2) 两组首尾，枚举量立刻减少。'],
    ['容易出错的地方', '三位数能被 3 整除，判断的是各位数字之和能否被 3 整除；还要同时检查三个数字不能重复。'],
    ['结果怎样检查', '321 的百位 3 比个位 1 大 2，各位和为 6；432 的百位 4 比个位 2 大 2，各位和为 9，因此两数都满足全部条件。']
  ],
  'junior2-triangle-angle-finale.html': [
    ['为什么作平行线', '题目要求比较 CE 与 AB 的方向，但两条直线不在同一个顶点。过 C 作 AB 的平行线，就能把所求夹角转移到 C 点直接相减。'],
    ['容易出错的地方', '角平分线平分的是外角 ∠ACD=110°，不是三角形内角 ∠ACB=70°。直线夹角还要取较小的那个角。'],
    ['结果怎样检查', 'CE 与 CD 的夹角为 55°，AB 的平行线与 CD 的夹角为 60°，两条方向只差 5°，结果与图形中的锐角位置一致。']
  ],
  'junior2-congruence-finale.html': [
    ['为什么比较 ABD 与 ACE', 'AB=AC 给出一组边，BD=CE 给出第二组边；等腰三角形的两个底角相等，又提供两边夹角相等，正好组成边角边。'],
    ['容易出错的地方', '不能直接用“边边角”证明全等。这里使用的是 ∠ABD=∠ACE，它们分别是 AB、BD 与 AC、CE 的夹角。'],
    ['结果怎样检查', '全等后对应边 AD=AE，因此 △ADE 有两腰相等。结论只依赖全等三角形和等腰三角形性质，没有引入相似知识。']
  ],
  'junior2-reflection-shortest-finale.html': [
    ['为什么要作对称点', 'P 在对称轴 l 上，所以 PA=PA′。原来的折线路径 PA+PB 就转化为 PA′+PB，问题变成从 A′ 经 P 到 B 的最短路径。'],
    ['容易出错的地方', '只有 P 位于对称轴上时，PA=PA′ 才成立。最优点必须取直线 A′B 与 l 的交点，不能随意在 l 上选点。'],
    ['结果怎样检查', '根据两点之间线段最短，PA′+PB≥A′B=12；交点处三点共线，等号能够取得，因此 12 不只是下界，确实是最小值。']
  ],
  'junior2-factorization-finale.html': [
    ['为什么整体代入', '题目给的是 a+b 与 ab，而不是 a、b 的具体值，所以要把目标式改写成只含这两个整体的形式。这样能避免先解出 a、b。'],
    ['容易出错的地方', '展开 (a+b)² 时中间项是 2ab；展开 (a+b)³ 时应写成 a³+b³+3ab(a+b)，系数 3 不能漏。'],
    ['结果怎样检查', '满足和为 5、积为 6 的两个数可以取 2 和 3。直接计算 2²+3²=13、2³+3³=35，与整体代入结果一致。']
  ],
  'junior2-fraction-equation-finale.html': [
    ['为什么先看分母', '2−x=−(x−2)，因此 −1/(2−x)=1/(x−2)。先处理这个符号关系，左边就能合并成 4/(x−2)。'],
    ['容易出错的地方', '分式方程开始前必须写出 x≠2。把 2−x 改写成 −(x−2) 时，分式前面的减号也要一起处理。'],
    ['结果怎样检查', '把 x=4 代入原方程，3/2−1/(−2)=3/2+1/2=2；同时 4≠2，分母不为零，所以解有效。检验时应代回原方程，而不是只代回去分母后的整式方程。']
  ]
};

for (const [filename, items] of Object.entries(reviews)) {
  const filePath = path.join(lessonDir, filename);
  let html = fs.readFileSync(filePath, 'utf8');
  if (!html.includes('rel="canonical"')) {
    html = html.replace('<link rel="stylesheet"', `<link rel="canonical" href="https://dahuajiujiu.com/math-lessons/${filename}"><link rel="stylesheet"`);
  }
  if (!html.includes('data-review="lesson"')) {
    const body = items.map(([title, copy]) => `<div class="step"><h3>${title}</h3><p>${copy}</p></div>`).join('');
    const section = `<section class="card" data-review="lesson"><h2>解题复盘</h2><div class="steps">${body}</div></section>`;
    html = html.replace('<footer class="footer">', `${section}<footer class="footer">`);
  }
  if (filename === 'junior2-fraction-equation-finale.html') {
    html = html.replace(
      '同时 4≠2，分母不为零，所以解有效。</p></div></div></section>',
      '同时 4≠2，分母不为零，所以解有效。检验时应代回原方程，而不是只代回去分母后的整式方程。</p></div></div></section>'
    );
  }
  fs.writeFileSync(filePath, html, 'utf8');
}
