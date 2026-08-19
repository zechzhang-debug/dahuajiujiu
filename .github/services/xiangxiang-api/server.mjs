import http from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3001);
const DATA_DIR = process.env.XIANGXIANG_DATA_DIR || path.join(process.cwd(), 'data');
const ACCESS_TOKEN_HASH = 'ffa03f654b95f91c09b96e0222105b497475ad0947d76c4bbcc81ca58f2f0ed9';
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ARCHIVE_FILE = path.join(DATA_DIR, 'idea-archive.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

await mkdir(DATA_DIR, { recursive: true });

function send(res, status, body, contentType='application/json; charset=utf-8', extra={}) {
  const value = contentType.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type':contentType, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer', 'X-Robots-Tag':'noindex, nofollow, noarchive', ...extra
  });
  res.end(value);
}

function hash(value='') { return createHash('sha256').update(String(value)).digest(); }
function authorized(req) {
  const value = req.headers.authorization || '';
  const token = value.startsWith('Bearer ') ? value.slice(7) : '';
  const expected = Buffer.from(ACCESS_TOKEN_HASH, 'hex');
  const actual = hash(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, file);
  await chmod(file, 0o600).catch(()=>{});
}
async function bodyOf(req, max=2_000_000) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const cleanText = (value,max) => String(value || '').slice(0,max);
function validateState(value) {
  const ideas = Array.isArray(value?.ideas) ? value.ideas.slice(0,5000) : [];
  const events = Array.isArray(value?.events) ? value.events.slice(0,5000) : [];
  return {
    ideas:ideas.map(item=>({
      id:cleanText(item.id,100), title:cleanText(item.title,120), content:cleanText(item.content,4000),
      theme:['工作','生活','创作','学习','其他'].includes(item.theme)?item.theme:'其他',
      createdAt:cleanText(item.createdAt,60), source:cleanText(item.source,4000)
    })).filter(item=>item.id),
    events:events.map(item=>({
      id:cleanText(item.id,100), title:cleanText(item.title,120), note:cleanText(item.note,4000),
      start:typeof item.start==='string'?cleanText(item.start,60):null,
      end:typeof item.end==='string'?cleanText(item.end,60):null,
      allDay:Boolean(item.allDay), done:Boolean(item.done), createdAt:cleanText(item.createdAt,60), source:cleanText(item.source,4000)
    })).filter(item=>item.id)
  };
}
function validateAnalysis(value) {
  return {
    ideas:(Array.isArray(value?.ideas)?value.ideas:[]).slice(0,8).map(item=>({
      title:cleanText(item.title || '未命名灵感',80), content:cleanText(item.content,1000),
      theme:['工作','生活','创作','学习','其他'].includes(item.theme)?item.theme:'其他'
    })),
    events:(Array.isArray(value?.events)?value.events:[]).slice(0,8).map(item=>({
      title:cleanText(item.title || '未命名日程',80), note:cleanText(item.note,1000),
      start:typeof item.start==='string'?item.start:null, end:typeof item.end==='string'?item.end:null,
      allDay:Boolean(item.allDay)
    }))
  };
}

async function archiveIdeas(ideas, now) {
  const archive = await readJson(ARCHIVE_FILE, { items:{} });
  const incoming = new Set(ideas.map(item=>item.id));
  for (const item of ideas) {
    const old = archive.items[item.id] || {};
    archive.items[item.id] = {...old,...item,firstSeenAt:old.firstSeenAt || now,lastSeenAt:now,deletedAt:null};
  }
  for (const [id,item] of Object.entries(archive.items)) {
    if (!incoming.has(id) && !item.deletedAt) archive.items[id] = {...item,lastSeenAt:now,deletedAt:now};
  }
  await writeJson(ARCHIVE_FILE, archive);
}
function markdownEscape(value='') { return String(value).replace(/([\\`*_{}\[\]<>#+.!|-])/g,'\\$1'); }
async function knowledgeMarkdown() {
  const archive = await readJson(ARCHIVE_FILE, { items:{} });
  const rows = Object.values(archive.items).sort((a,b)=>String(b.createdAt||b.firstSeenAt).localeCompare(String(a.createdAt||a.firstSeenAt)));
  const generatedAt = new Date().toISOString();
  const sections = rows.map((item,index)=>[
    `## ${index+1}. ${markdownEscape(item.title || '未命名灵感')}`,
    `- 主题：${markdownEscape(item.theme)}`,
    `- 创建时间：${markdownEscape(item.createdAt || item.firstSeenAt)}`,
    `- 状态：${item.deletedAt ? `已从页面隐藏（${markdownEscape(item.deletedAt)}）` : '当前可见'}`,
    '', item.content || '', ''
  ].join('\n')).join('\n');
  return { markdown:`# 想想 · 灵感知识库\n\n生成时间：${generatedAt}\n灵感总数：${rows.length}\n\n${sections}`, generatedAt };
}

async function stateApi(req,res) {
  if (req.method === 'GET') {
    const saved = await readJson(STATE_FILE, {state:{ideas:[],events:[]},updatedAt:null,version:0});
    return send(res,200,{...saved,state:validateState(saved.state)});
  }
  if (req.method !== 'PUT') return send(res,405,{error:'Method not allowed'});
  const {state} = await bodyOf(req);
  const clean = validateState(state);
  const previous = await readJson(STATE_FILE,{version:0});
  const updatedAt = new Date().toISOString();
  await archiveIdeas(clean.ideas,updatedAt);
  const saved = {state:clean,updatedAt,version:Number(previous.version||0)+1};
  await writeJson(STATE_FILE,saved);
  return send(res,200,{ok:true,updatedAt,version:saved.version});
}

async function analyzeApi(req,res) {
  if (req.method !== 'POST') return send(res,405,{error:'Method not allowed'});
  const {text,now,timezone} = await bodyOf(req,64_000);
  if (!text || typeof text !== 'string' || !text.trim()) return send(res,400,{error:'先写点什么吧'});
  const config = await readJson(CONFIG_FILE,{});
  if (!config.deepseekApiKey) return send(res,503,{error:'服务端尚未配置 DeepSeek API Key'});
  const prompt = `你是中文随手记应用的分类助手。分析用户的一段自然语言，将其中的信息完整拆分成“灵感”和“日程”。\n规则：\n1. 灵感是想法、感悟、知识、待探索的概念；日程是有行动意图的待办、约会、提醒，即使没有明确时间也算日程。\n2. 同一段话可能同时包含两类，必须分别提取，不能丢失信息。\n2.1 灵感的 content 要在保留原意、观点和关键细节的前提下重新整理：纠正明显错字，去掉语气词、口头重复和无效铺垫，合并成简洁、通顺、可直接复用的一段；不要原样照抄，也不要擅自扩写。\n2.2 日程的 title 用简短动作概括，note 只保留必要背景并同样去除口语和重复；时间不要在 note 中重复。\n3. 对相对时间结合当前时间转换成带时区的 ISO 8601；无时间线索时 start 为 null。\n4. 不要臆造用户未表达的细节。\n5. 灵感主题只能是：工作、生活、创作、学习、其他。\n6. 输出严格 JSON：{"ideas":[{"title":"短标题","content":"整理后的完整内容","theme":"创作"}],"events":[{"title":"短标题","note":"整理后的补充说明","start":null,"end":null,"allDay":false}]}\n当前时间：${now||new Date().toISOString()}\n时区：${timezone||'Asia/Shanghai'}\n用户输入：${text.trim()}`;
  const upstream = await fetch('https://api.deepseek.com/chat/completions',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.deepseekApiKey}`},
    body:JSON.stringify({model:config.deepseekModel||'deepseek-v4-pro',messages:[{role:'system',content:'你只输出有效的 JSON 对象。'},{role:'user',content:prompt}],thinking:{type:'disabled'},response_format:{type:'json_object'},temperature:.15,max_tokens:1400})
  });
  const payload = await upstream.json().catch(()=>({}));
  if (!upstream.ok) return send(res,502,{error:payload?.error?.message || `DeepSeek 请求失败（${upstream.status}）`});
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) return send(res,502,{error:'AI 没有返回内容，请再试一次'});
  return send(res,200,validateAnalysis(JSON.parse(content)));
}

async function setupApi(req,res) {
  if (req.method !== 'POST') return send(res,405,{error:'Method not allowed'});
  const {deepseekApiKey,deepseekModel} = await bodyOf(req,64_000);
  if (!deepseekApiKey || typeof deepseekApiKey !== 'string') return send(res,400,{error:'缺少 DeepSeek API Key'});
  await writeJson(CONFIG_FILE,{deepseekApiKey:deepseekApiKey.trim(),deepseekModel:cleanText(deepseekModel||'deepseek-v4-pro',80),updatedAt:new Date().toISOString()});
  return send(res,200,{ok:true});
}

const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/health') return send(res,200,{ok:true,service:'xiangxiang-api'});
    if (req.method === 'OPTIONS') return send(res,204,'','text/plain',{'Access-Control-Allow-Origin':req.headers.origin||'*','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, PUT, POST, OPTIONS'});
    if (!url.pathname.startsWith('/hua/api/')) return send(res,404,{error:'Not found'});
    if (!authorized(req)) return send(res,401,{error:'私人链接访问密钥无效'});
    if (url.pathname === '/hua/api/state') return await stateApi(req,res);
    if (url.pathname === '/hua/api/analyze') return await analyzeApi(req,res);
    if (url.pathname === '/hua/api/setup') return await setupApi(req,res);
    if (url.pathname === '/hua/api/archive' && req.method === 'GET') {
      const bundle = await knowledgeMarkdown();
      return send(res,200,bundle.markdown,'text/markdown; charset=utf-8',{'Content-Disposition':`attachment; filename="xiangxiang-knowledge-${bundle.generatedAt.slice(0,10)}.md"`});
    }
    return send(res,404,{error:'Not found'});
  } catch (error) {
    return send(res,500,{error:error?.message || '服务暂时不可用'});
  }
});

server.listen(PORT,HOST,()=>console.log(`xiangxiang-api listening on http://${HOST}:${PORT}`));
