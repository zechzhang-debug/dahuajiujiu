import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'word-web-cloud', 'chinese-classical.html');
const source = fs.readFileSync(sourcePath, 'utf8');
const dataStart = source.indexOf('const data=') + 'const data='.length;
const dataEnd = source.indexOf('\n    const params=', dataStart);

if (dataStart < 'const data='.length || dataEnd < 0) {
  throw new Error('Unable to locate classical Chinese data.');
}

const data = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'classical-reviewed.json'), 'utf8'));
for (const stage of ['junior', 'senior']) {
  for (const entry of data[stage]) {
    if (!entry[3]?.length || entry[3].some(e => !e.text?.includes(entry[1]) || !e.source || !e.note)) {
      throw new Error(`Missing quotation, provenance or contextual explanation: ${stage}/${entry[1]}`);
    }
  }
}
fs.writeFileSync(sourcePath, source.slice(0, dataStart) + JSON.stringify(data, null, 2) + ';' + source.slice(dataEnd), 'utf8');

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function selectExamples(entry) {
  const examples = Array.isArray(entry[3]) ? entry[3] : [{ text: entry[3], source: entry[4] }];
  return examples
    .filter((example) => example?.text && example?.source)
    .slice(0, 2);
}

function renderEntry(entry) {
  const [kind, word, meaning] = entry;
  const examples = selectExamples(entry).map((example) => `
          <li><span class="quote">${escapeHtml(example.text)}</span><span class="source">${escapeHtml(example.source)}</span><p class="usage-note">${escapeHtml(example.note)}</p></li>`).join('');
  return `
      <article class="word-entry" id="word-${encodeURIComponent(word)}">
        <div><h2 class="word-name">${escapeHtml(word)}</h2><span class="word-kind">${escapeHtml(kind)}</span></div>
        <div class="meaning"><h3>核心义项</h3><p>${escapeHtml(meaning)}</p></div>
        <div class="examples"><h3>原文短句</h3><ul>${examples}</ul></div>
      </article>`;
}

function renderPage(stage) {
  const isJunior = stage === 'junior';
  const label = isJunior ? '初中' : '高中';
  const otherLabel = isJunior ? '高中' : '初中';
  const otherFile = isJunior ? 'chinese-senior.html' : 'chinese-junior.html';
  const filename = isJunior ? 'chinese-junior.html' : 'chinese-senior.html';
  const description = isJunior
    ? '初中文言词语学习：原文短句、篇目出处与逐句用法。'
    : '高中文言词语学习：原文短句、篇目出处与逐句用法。';
  const intro = isJunior
    ? '从七至九年级常见篇目中提取高频实词、虚词。先比较核心义项，再回到原文短句判断语境，避免把同一个词在不同文章中的意思混为一谈。'
    : '从高中必修与选择性必修常见篇目中整理高频实词、虚词。重点比较古今义、一词多义与句中用法，为文言文阅读和翻译建立稳定的语境判断依据。';
  const entries = data[stage].map(renderEntry).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${description}">
  <link rel="canonical" href="https://dahuajiujiu.com/${filename}">
  <title>${label}文言文实词虚词与原文例句｜大华舅舅</title>
  <link rel="stylesheet" href="chinese-static.css?v=1.0.0">
</head>
<body>
  <header class="site-header">
    <a class="brand" href="index.html"><span class="brand-mark" aria-hidden="true">文</span><span>大华舅舅</span></a>
    <nav class="top-links" aria-label="文言文学习导航"><a href="chinese.html">语文首页</a><a href="${filename}" aria-current="page">${label}文言文</a><a href="${otherFile}">${otherLabel}文言文</a><a href="chinese-classical.html?stage=${stage}">完整筛选表</a></nav>
  </header>
  <main>
    <section class="hero">
      <p class="eyebrow">语文 · ${label}文言文</p>
      <h1>${label}文言文实词、虚词与原文例句</h1>
      <p>${intro}</p>
    </section>
    <section class="study-note" aria-labelledby="study-note-title">
      <h2 id="study-note-title">按语境辨析词义</h2>
      <p>每个词条提供两条经校对的原文短句、准确篇目与句中用法。学段是学习分组，不代表固定教材册次；兼有多种词性的词，以逐句说明为准。总表支持按词性、字词和篇目筛选。</p>
    </section>
    ${isJunior ? "<section class=\"study-note\"><h2>先试译，再查词</h2><p>遮住下方词条，先判断句中的字在问什么或描述什么。</p><details><summary>“安能辨我是雄雌”与“风雨不动安如山”中的“安”可以互换解释吗？</summary><p>前一句“安能”相当于“怎么能”，全句为反问。后一句用山作比较，写的是稳固的状态。若把后一句译成“怎么像山”，句意就断了。</p></details><details><summary>“去国怀乡”中，“去”是前往还是离开？用后半句验证。</summary><p>应译为离开国都。“怀乡”提示人已远离熟悉的地方。若按现代口语把“去国”理解成前往一个国家，就解释不了这里的情绪。</p></details></section>" : "<section class=\"study-note\"><h2>用上下文排除错误译法</h2><details><summary>“爱其子，择师而教之”与“不爱珍器重宝肥饶之地”能否都译为“喜爱”？</summary><p>择师是爱护孩子的具体行动。后一句把“珍器重宝肥饶之地”并列为可付出的财物，“不爱”应理解为不吝惜。如果译成不喜欢宝物，就把付出代价误解成了个人喜好。</p></details><details><summary>“师者，所以传道受业解惑也”与“道之所存，师之所存也”，能否把“道”译成道路？</summary><p>前句中“道”是“传”的对象，与学业、疑惑构成教学语境，应指道理。后句承接同一话题，意思是道理所在之处便有可以学习的老师。判断词义时可以用前文为后句排除歧义。</p></details></section>"}
    <section class="word-list" aria-label="${label}文言文词语清单">${entries}
    </section>
    <section class="continue" aria-label="继续查看完整资料">
      <p>需要比较同一词语在更多篇目中的用法，可进入完整筛选表按词性、关键词和篇目查找。</p>
      <a href="chinese-classical.html?stage=${stage}">进入完整筛选表</a>
    </section>
  </main>
  <footer class="site-footer">
    <span>北京一个半文化科技有限公司</span>
    <nav class="footer-links" aria-label="网站信息"><a href="about.html">关于与联系</a><a href="privacy.html">隐私政策</a><a href="terms.html">用户协议</a><a href="https://beian.miit.gov.cn/" rel="noopener" target="_blank">京ICP备2026041766号-1</a></nav>
  </footer>
</body>
</html>
`;
}

for (const stage of ['junior', 'senior']) {
  const filename = stage === 'junior' ? 'chinese-junior.html' : 'chinese-senior.html';
  fs.writeFileSync(path.join(root, 'word-web-cloud', filename), renderPage(stage), 'utf8');
}
