import { removeById, restoreAt } from './state-utils.js';
import { directIdeaFrom, isLongForm, needsAiAnalysis } from './capture-utils.js';

const STORAGE_KEY = 'suishouji-data-v1';
const SYNC_CURSOR_KEY = 'suishouji-sync-cursor-v2';
const PENDING_CHANGES_KEY = 'suishouji-pending-changes-v2';
const PARTIAL_CACHE_KEY = 'suishouji-partial-cache-v2';
const FORCE_CLOUD = new URLSearchParams(location.search).get('cloud') === '1';
const LOCAL_API_OVERRIDE = ['localhost','127.0.0.1'].includes(location.hostname)
  ? new URLSearchParams(location.search).get('apiOrigin') : '';
const IS_CLOUD = FORCE_CLOUD || !['localhost', '127.0.0.1'].includes(location.hostname);
const BASE_PATH = location.pathname.startsWith('/hua') || FORCE_CLOUD ? '/hua' : '';
const API_ORIGIN = LOCAL_API_OVERRIDE || (location.hostname === 'dahuajiujiu.com' ? '' : (FORCE_CLOUD ? 'https://xiangxiang-private.dahuajiujiu-hua.workers.dev' : ''));
const apiUrl = (name) => `${API_ORIGIN}${BASE_PATH}/api/${name}`;
const authHeaders = () => ({});
const themeColors = { 工作:'#7550ed', 生活:'#f26722', 创作:'#e77ddd', 学习:'#eff357', 其他:'#65d69e' };
const themeEmoji = { 工作:'●', 生活:'●', 创作:'●', 学习:'●', 其他:'●' };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value='') => String(value).replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;

let state = loadState();
let currentTheme = '全部';
let search = '';
let visibleIdeaLimit = 20;
let selectedCalendarDate = '';
let floatingScheduleDate = '';
let floatingMode = '';
let floatingWindow = null;
let floatingHealthTimer = null;
const calendarCursor = new Date();
calendarCursor.setDate(1);
calendarCursor.setHours(12,0,0,0);
let toastTimer;
let pendingUndo = null;
let syncBusy = false;
let syncDirty = false;
let syncInitialized = localStorage.getItem(SYNC_CURSOR_KEY) !== null
  && localStorage.getItem(STORAGE_KEY) !== null
  && localStorage.getItem(PARTIAL_CACHE_KEY) !== '1';
let syncCursor = Number(localStorage.getItem(SYNC_CURSOR_KEY) || 0);
let pendingChanges = loadPendingChanges();
let persistedState = structuredClone(state);
let incrementalUnavailable = false;

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed && Array.isArray(parsed.ideas) && Array.isArray(parsed.events)) return parsed;
  } catch {}
  return { ideas: [], events: [] };
}

function loadPendingChanges() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_CHANGES_KEY));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function recordKey(kind,id) { return `${kind}:${id}`; }
function itemMap(items) { return new Map(items.map((item) => [item.id, item])); }
function mutationId() { return uid(); }

function diffState(before,after) {
  const changes=[];
  for (const [kind,field] of [['idea','ideas'],['event','events']]) {
    const previous=itemMap(before[field]);
    const current=itemMap(after[field]);
    for (const [id,item] of current) {
      if (JSON.stringify(previous.get(id)) === JSON.stringify(item)) continue;
      changes.push({kind,id,item:structuredClone(item),deleted:false,clientMutationId:mutationId()});
    }
    for (const id of previous.keys()) {
      if (!current.has(id)) changes.push({kind,id,item:null,deleted:true,clientMutationId:mutationId()});
    }
  }
  return changes;
}

function persistPendingChanges() {
  try { localStorage.setItem(PENDING_CHANGES_KEY,JSON.stringify(pendingChanges)); } catch {}
}

function persistLocalState() {
  try {
    const serialized=JSON.stringify(state);
    if (new Blob([serialized]).size<=3_500_000) {
      localStorage.setItem(STORAGE_KEY,serialized);
      localStorage.removeItem(PARTIAL_CACHE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY,JSON.stringify({ideas:state.ideas.slice(0,1000),events:state.events.slice(0,1000)}));
      localStorage.setItem(PARTIAL_CACHE_KEY,'1');
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem(PARTIAL_CACHE_KEY,'1');
  }
  persistedState=structuredClone(state);
}

function saveState() {
  const changes=diffState(persistedState,state);
  for (const change of changes) pendingChanges[recordKey(change.kind,change.id)]=change;
  persistLocalState();
  if (changes.length) persistPendingChanges();
  render();
  if (IS_CLOUD && changes.length) queueCloudSync();
}

function setSyncStatus(text, error=false) {
  const el = $('#sync-status');
  if (!el) return;
  el.textContent = text;
  el.closest('.ai-status')?.classList.toggle('sync-error', error);
}

async function cloudRequest(name, options={}) {
  const response = await fetch(apiUrl(name), {
    ...options,
    headers:{ 'Content-Type':'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `云端同步失败（${response.status}）`);
  return payload;
}

function applyRemoteChange(target,change,skipPending=true) {
  if (!['idea','event'].includes(change.kind) || !change.id) return;
  if (activeEditKey()===recordKey(change.kind,change.id)) return;
  if (skipPending && pendingChanges[recordKey(change.kind,change.id)]) return;
  const field=change.kind==='idea'?'ideas':'events';
  const index=target[field].findIndex((item)=>item.id===change.id);
  if (change.deleted) {
    if (index>=0) target[field].splice(index,1);
  } else if (change.item) {
    if (index>=0) target[field][index]=change.item;
    else target[field].unshift(change.item);
  }
}

async function pushPendingChanges() {
  const snapshot=Object.values(pendingChanges);
  if (!snapshot.length) return;
  const payload=await cloudRequest('sync',{method:'POST',body:JSON.stringify({changes:snapshot})});
  for (const sent of snapshot) {
    const key=recordKey(sent.kind,sent.id);
    if (pendingChanges[key]?.clientMutationId===sent.clientMutationId) delete pendingChanges[key];
  }
  persistPendingChanges();
  return payload;
}

async function pullChanges(target=state,fromCursor=syncCursor,skipPending=true,seenKeys=null) {
  let cursor=fromCursor;
  let pages=0;
  do {
    const payload=await cloudRequest(`sync?cursor=${cursor}&limit=500`);
    for (const change of payload.changes || []) {
      if (seenKeys) seenKeys.add(recordKey(change.kind,change.id));
      applyRemoteChange(target,change,skipPending);
    }
    cursor=Number(payload.cursor || cursor);
    pages+=1;
    if (!payload.hasMore) break;
  } while (pages<250);
  return cursor;
}

async function initialCloudSync() {
  const localBefore=structuredClone(state);
  const remote={ideas:[],events:[]};
  const remoteKeys=new Set();
  const cursor=await pullChanges(remote,0,false,remoteKeys);
  state=remote;
  for (const item of localBefore.ideas) if (!remoteKeys.has(recordKey('idea',item.id))) state.ideas.push(item);
  for (const item of localBefore.events) if (!remoteKeys.has(recordKey('event',item.id))) state.events.push(item);
  persistedState=structuredClone(remote);
  saveState();
  syncCursor=cursor;
  localStorage.setItem(SYNC_CURSOR_KEY,String(syncCursor));
  await pushPendingChanges();
  syncCursor=await pullChanges(state,syncCursor);
  syncInitialized=true;
  localStorage.setItem(SYNC_CURSOR_KEY,String(syncCursor));
  persistLocalState();
  renderUnlessEditing();
}

async function legacyCloudSync() {
  if (Object.keys(pendingChanges).length) {
    await cloudRequest('state',{method:'PUT',body:JSON.stringify({state})});
    pendingChanges={};
    persistPendingChanges();
  }
  const payload=await cloudRequest('state');
  if (payload.state && Array.isArray(payload.state.ideas) && Array.isArray(payload.state.events)) state=payload.state;
  persistLocalState();
  renderUnlessEditing();
  setSyncStatus('云端已同步（兼容模式）');
}

async function syncCloud() {
  if (!IS_CLOUD) return;
  if (isInlineEditing()) { syncDirty=true; return; }
  if (syncBusy) { syncDirty=true; return; }
  syncBusy=true;
  setSyncStatus('正在同步…');
  try {
    if (incrementalUnavailable) await legacyCloudSync();
    else if (!syncInitialized) await initialCloudSync();
    else {
      await pushPendingChanges();
      syncCursor=await pullChanges();
      localStorage.setItem(SYNC_CURSOR_KEY,String(syncCursor));
      persistLocalState();
      renderUnlessEditing();
    }
    setSyncStatus(Object.keys(pendingChanges).length ? '等待同步…' : '云端已同步');
  } catch (error) {
    if (!incrementalUnavailable && /404|502|not found|bad gateway/i.test(error.message || '')) {
      incrementalUnavailable=true;
      try { await legacyCloudSync(); }
      catch (fallbackError) { setSyncStatus(fallbackError.message || '同步失败，稍后重试',true); }
    } else setSyncStatus(error.message || '同步失败，稍后重试',true);
  } finally {
    syncBusy=false;
    if (syncDirty) { syncDirty=false; queueMicrotask(syncCloud); }
  }
}

function queueCloudSync() {
  syncDirty = true;
  queueMicrotask(() => {
    if (!syncBusy && syncDirty) { syncDirty = false; syncCloud(); }
  });
}

async function bootstrapCloudSync() {
  if (!IS_CLOUD) { setSyncStatus('仅保存在此设备'); return; }
  await syncCloud();
  window.setInterval(syncCloud,5000);
  window.addEventListener('focus',syncCloud);
  window.addEventListener('online',syncCloud);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncCloud();
  });
}

function formatCreated(date) {
  const d = new Date(date);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `今天 ${d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`;
  return d.toLocaleDateString('zh-CN',{month:'short',day:'numeric'});
}

function dayKey(event) {
  if (!event.start) return '9999-99-99';
  const d = new Date(event.start);
  return Number.isNaN(d.getTime()) ? '9999-99-99' : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function showToast(message, error=false, undoAction=null) {
  const el = $('#toast');
  pendingUndo = undoAction;
  el.innerHTML = `<span>${esc(message)}</span>${undoAction ? '<button id="undo-button">撤销</button>' : ''}`;
  el.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; pendingUndo = null; }, undoAction ? 5000 : 3000);
}

$('#toast').addEventListener('click', (event) => {
  if (event.target.id !== 'undo-button' || !pendingUndo) return;
  pendingUndo(); pendingUndo = null; clearTimeout(toastTimer); $('#toast').className = 'toast';
});

function renderIdeas() {
  const filtered = state.ideas
    .filter((item) => (currentTheme === '全部' || item.theme === currentTheme) && `${item.title} ${item.content} ${item.theme}`.toLowerCase().includes(search))
    .sort((a,b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0));
  const items=filtered.slice(0,visibleIdeaLimit);
  $('#ideas-summary').textContent = filtered.length===state.ideas.length ? `${state.ideas.length} 个灵感` : `${filtered.length} 个匹配 · 共 ${state.ideas.length} 个`;
  $('#idea-count-side').textContent = state.ideas.length;
  $('#bubble-grid').innerHTML = items.map((item) => `
    <article class="bubble" style="--bubble:${themeColors[item.theme] || themeColors.其他}">
      <div class="bubble-actions">
        <button class="copy-button" data-copy-idea="${item.id}" aria-label="复制灵感" title="复制"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg></button>
        <button class="delete" data-delete-idea="${item.id}" aria-label="删除灵感" title="删除"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6"/></svg></button>
      </div>
      <p class="bubble-content editable-text" data-edit-idea-content="${item.id}" title="双击修改">${esc(item.content || item.title)}</p>
      <time>${formatCreated(item.createdAt)}</time>
    </article>`).join('');
  $('#ideas-empty').classList.toggle('hidden', filtered.length > 0);
  const loadMore=$('#ideas-load-more');
  const remaining=Math.max(0,filtered.length-items.length);
  loadMore.classList.toggle('hidden',remaining===0);
  if (remaining) loadMore.textContent=`展开更多 ${Math.min(40,remaining)} 条 · 还剩 ${remaining} 条`;
}

function localDateKey(date) {
  const year=date.getFullYear();
  const month=String(date.getMonth()+1).padStart(2,'0');
  const day=String(date.getDate()).padStart(2,'0');
  return `${year}-${month}-${day}`;
}

function renderCalendar() {
  const year=calendarCursor.getFullYear();
  const month=calendarCursor.getMonth();
  $('#calendar-month-title').textContent=`${year}年${month+1}月`;
  const eventsByDate=new Map();
  for (const item of state.events) {
    if (!item.start) continue;
    const date=new Date(item.start);
    if (Number.isNaN(date.getTime())) continue;
    const key=localDateKey(date);
    if (!eventsByDate.has(key)) eventsByDate.set(key,[]);
    eventsByDate.get(key).push(item);
  }
  const first=new Date(year,month,1,12);
  first.setDate(first.getDate()-((first.getDay()+6)%7));
  const todayKey=localDateKey(new Date());
  $('#calendar-grid').innerHTML=Array.from({length:42},(_,index)=>{
    const date=new Date(first); date.setDate(first.getDate()+index);
    const key=localDateKey(date);
    const events=eventsByDate.get(key) || [];
    const classes=['calendar-day'];
    if (date.getMonth()!==month) classes.push('outside');
    if (key===todayKey) classes.push('today');
    if (events.length) classes.push('has-events');
    const dots=events.slice(0,3).map(()=>'<i></i>').join('');
    const firstTitle=events[0] ? `<span class="day-event">${esc(events[0].title)}</span>` : '';
    const title=events.length ? `${date.getMonth()+1}月${date.getDate()}日 · ${events.map((item)=>item.title).join('、')}` : `${date.getMonth()+1}月${date.getDate()}日`;
    return `<button type="button" class="${classes.join(' ')}" data-calendar-date="${key}" title="${esc(title)}"><span class="day-number">${date.getDate()}</span>${events.length?`<span class="event-dots">${dots}</span>`:''}${firstTitle}</button>`;
  }).join('');
  renderCalendarDetail();
}

function eventTime(item) {
  if (!item.start) return '时间待定';
  if (item.allDay) return '全天';
  const date = new Date(item.start);
  if (Number.isNaN(date.getTime())) return '时间待定';
  return date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
}

function sortEvents(items) {
  return [...items].sort((a,b) => {
    if (!a.start && !b.start) return b.createdAt.localeCompare(a.createdAt);
    if (!a.start) return 1; if (!b.start) return -1;
    return new Date(a.start)-new Date(b.start);
  });
}

function calendarEventHtml(item) {
  return `<article class="event-card ${item.done ? 'done':''}">
    <button class="check" data-toggle-event="${item.id}" aria-label="${item.done?'标记未完成':'标记完成'}">${item.done?'✓':''}</button>
    <span class="event-time">${eventTime(item)}</span>
    <div class="event-copy"><h3 class="editable-text" data-edit-event-title="${item.id}" title="双击修改">${esc(item.title)}</h3>${item.note ? `<p class="editable-text" data-edit-event-note="${item.id}" title="双击修改">${esc(item.note)}</p>`:''}</div>
    <button class="delete" data-delete-event="${item.id}" aria-label="删除日程" title="删除"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6"/></svg></button>
  </article>`;
}

function eventsForCalendarDate(key) {
  const todayKey=localDateKey(new Date());
  const isPast=key<todayKey;
  return sortEvents(state.events.filter((item)=>dayKey(item)===key && (!isPast || !item.done)));
}

function renderCalendarDetail() {
  const panel=$('#calendar-panel');
  const front=$('#calendar-front');
  const detail=$('#calendar-detail');
  const flipped=Boolean(selectedCalendarDate);
  panel.classList.toggle('is-flipped',flipped);
  panel.setAttribute('aria-label',flipped?'当日日程':'月历');
  front.setAttribute('aria-hidden',String(flipped));
  detail.setAttribute('aria-hidden',String(!flipped));
  front.inert=flipped;
  detail.inert=!flipped;
  if (!flipped) return;

  const selected=new Date(`${selectedCalendarDate}T12:00:00`);
  const todayKey=localDateKey(new Date());
  const isPast=selectedCalendarDate<todayKey;
  const isToday=selectedCalendarDate===todayKey;
  const events=eventsForCalendarDate(selectedCalendarDate);
  $('#calendar-detail-title').textContent=selected.toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'short'});
  $('#calendar-detail-hint').textContent=isPast?'过去日期 · 只显示未完成':(isToday?'今天 · 显示全部日程':'显示全部日程');
  $('#calendar-detail-count').textContent=events.length;
  $('#calendar-detail-events').innerHTML=events.length
    ? events.map(calendarEventHtml).join('')
    : `<div class="calendar-detail-empty"><b>✓</b><strong>${isPast?'没有未完成任务':'这一天还没有安排'}</strong><span>${isPast?'已经处理妥当':'有明确时间的待办会显示在这里'}</span></div>`;
}

const FLOATING_SCHEDULE_STYLES=`
  :root{color-scheme:dark;font-family:'Microsoft YaHei','PingFang SC',system-ui,sans-serif}
  *{box-sizing:border-box}
  html,body{margin:0;width:100%;min-height:100%;background:transparent!important;overflow:hidden}
  body{color:#fff}
  button,input{font:inherit}
  .float-shell{min-height:100vh;padding:12px;display:grid;place-items:center;background:transparent}
  .float-card{width:100%;max-height:calc(100vh - 24px);overflow:auto;padding:16px 18px 14px;border:1px solid transparent;border-radius:17px;color:#fff;background:rgba(34,35,32,0);box-shadow:0 18px 50px rgba(0,0,0,0);backdrop-filter:blur(0);transition:background .2s ease,box-shadow .2s ease,border-color .2s ease,backdrop-filter .2s ease;scrollbar-width:none}
  .float-card::-webkit-scrollbar{display:none}
  .float-card:hover{background:rgba(131,129,125,.96);border-color:rgba(255,255,255,.16);box-shadow:0 18px 48px rgba(0,0,0,.24);backdrop-filter:blur(14px)}
  .float-chrome{max-height:0;margin:0;opacity:0;overflow:hidden;pointer-events:none;transform:translateY(-4px);transition:opacity .16s ease,max-height .2s ease,transform .2s ease,margin .2s ease}
  .float-card:hover .float-chrome{max-height:60px;margin-bottom:11px;opacity:1;pointer-events:auto;transform:translateY(0)}
  .float-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .float-head>div{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:1}.float-brand{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:800}.float-dot{width:8px;height:8px;border-radius:50%;background:#99ffaa;box-shadow:0 0 12px rgba(153,255,170,.75)}
  .float-date{color:rgba(255,255,255,.68);font-size:10px}.float-count{display:none}
  .float-list{list-style:none;margin:0;padding:0}
  .float-item{display:grid;grid-template-columns:46px 0 1fr;gap:0;align-items:center;padding:8px 2px;border-top:1px solid transparent;text-shadow:0 2px 5px rgba(0,0,0,.36),0 0 14px rgba(0,0,0,.18);transition:grid-template-columns .18s ease,gap .18s ease,border-color .18s ease}
  .float-card:hover .float-item{grid-template-columns:46px 17px 1fr;gap:9px;border-top-color:rgba(255,255,255,.12)}
  .float-time{padding-top:1px;color:rgba(255,255,255,.9);font-size:10px;font-variant-numeric:tabular-nums;text-shadow:0 2px 5px rgba(0,0,0,.24),0 5px 14px rgba(0,0,0,.12)}
  .float-check{appearance:none;width:17px;height:17px;margin:0;border:1px solid rgba(255,255,255,.55);border-radius:6px;background:transparent;opacity:0;pointer-events:none;transform:scale(.7);cursor:pointer;transition:opacity .16s ease,transform .16s ease}
  .float-card:hover .float-check{opacity:1;pointer-events:auto;transform:scale(1)}.float-check:checked{background:#99ffaa;border-color:#99ffaa;box-shadow:inset 0 0 0 4px #83817d}
  .float-copy{min-width:0}.float-title{display:block;color:#fff;font-size:14px;font-weight:760;line-height:1.35;overflow-wrap:anywhere;text-shadow:0 2px 5px rgba(0,0,0,.36),0 5px 15px rgba(0,0,0,.22)}.float-item.featured .float-title{color:#99ffaa}
  .float-note{display:block;max-height:0;margin:0;opacity:0;overflow:hidden;color:rgba(255,255,255,.66);font-size:10px;line-height:1.4;transition:opacity .16s ease,max-height .18s ease,margin .18s ease}.float-card:hover .float-note{max-height:42px;margin-top:3px;opacity:1}
  .float-item.done .float-title{opacity:.58;text-decoration:line-through}
  .float-empty{display:grid;place-items:center;align-content:center;gap:9px;min-height:120px;color:rgba(255,255,255,.72);text-align:center;text-shadow:0 2px 5px rgba(0,0,0,.3)}.float-empty b{color:#99ffaa;font-size:22px}.float-empty strong{color:#fff;font-size:14px}.float-empty span{font-size:10px}
  .float-foot{color:rgba(255,255,255,.7);font-size:10px;text-align:center}
`;

function getFloatingWindow() {
  if (!('documentPictureInPicture' in window)) return null;
  const active=window.documentPictureInPicture.window;
  if (active && !active.closed) return active;
  if (floatingWindow && !floatingWindow.closed && floatingWindow.document?.body) return floatingWindow;
  return null;
}

function resetFloatingSchedule() {
  floatingWindow=null;
  floatingScheduleDate='';
  floatingMode='';
  if (floatingHealthTimer) clearInterval(floatingHealthTimer);
  floatingHealthTimer=null;
  $('#floating-button').classList.remove('active');
}

function floatingEventHtml(item,index,featuredIndex) {
  return `<li class="float-item ${item.done?'done':''} ${index===featuredIndex?'featured':''}" data-floating-event="${item.id}">
    <span class="float-time">${eventTime(item)}</span>
    <input class="float-check" type="checkbox" aria-label="${item.done?'标记未完成':'标记完成'}" ${item.done?'checked':''}>
    <span class="float-copy"><span class="float-title">${esc(item.title)}</span>${item.note?`<small class="float-note">${esc(item.note)}</small>`:''}</span>
  </li>`;
}

function renderFloatingSchedule() {
  if (!floatingScheduleDate) return;
  const date=new Date(`${floatingScheduleDate}T12:00:00`);
  const events=eventsForCalendarDate(floatingScheduleDate);
  if (floatingMode==='native') {
    sendNativeFloatingSchedule(events,false).catch(()=>{});
    return;
  }
  floatingWindow=getFloatingWindow();
  if (!floatingWindow) return;
  const featuredIndex=events.findIndex((item)=>!item.done);
  const dateLabel=date.toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
  floatingWindow.document.body.innerHTML=`<main class="float-shell"><section class="float-card">
    <header class="float-head float-chrome"><div><span class="float-brand"><i class="float-dot"></i>想想 · 日程</span><span class="float-date">${esc(dateLabel)}</span></div><b class="float-count">${events.length}</b></header>
    ${events.length?`<ul class="float-list">${events.map((item,index)=>floatingEventHtml(item,index,featuredIndex)).join('')}</ul>`:'<div class="float-empty"><b>✓</b><strong>这一天没有待处理日程</strong><span>在网页中新增后会自动同步到这里</span></div>'}
    <footer class="float-foot float-chrome">移开鼠标只保留日程 · 勾选即同步</footer>
  </section></main>`;
  floatingWindow.document.querySelectorAll('.float-check').forEach((checkbox)=>checkbox.addEventListener('change',(event)=>{
    const id=event.target.closest('[data-floating-event]')?.dataset.floatingEvent;
    const item=state.events.find((entry)=>entry.id===id);
    if (!item) return;
    item.done=event.target.checked;
    saveState();
  }));
}

function nativeScheduleBody(events) {
  const json=JSON.stringify({schedule:events.map((item)=>({
    id:item.id,
    time:eventTime(item),
    title:item.title,
    note:item.note || '',
    done:Boolean(item.done),
  }))});
  const bytes=new TextEncoder().encode(json);
  let binary='';
  for (const byte of bytes) binary+=String.fromCharCode(byte);
  return btoa(binary);
}

async function sendNativeFloatingSchedule(events,show=true) {
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),20000);
  try {
    const response=await fetch(`http://127.0.0.1:4174/${show?'show':'update'}`,{
      method:'POST',
      mode:'cors',
      cache:'no-store',
      targetAddressSpace:'loopback',
      headers:{'Content-Type':'text/plain;charset=UTF-8'},
      body:nativeScheduleBody(events),
      signal:controller.signal,
    });
    if (!response.ok) return false;
    const result=await response.json();
    return Boolean(result?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function openFloatingSchedule() {
  const active=getFloatingWindow();
  if (active) {
    active.focus();
    showToast('悬浮日程已经在屏幕上');
    return;
  }
  resetFloatingSchedule();
  floatingScheduleDate=selectedCalendarDate || localDateKey(new Date());
  const events=eventsForCalendarDate(floatingScheduleDate);
  if (await sendNativeFloatingSchedule(events,true)) {
    floatingMode='native';
    $('#floating-button').classList.add('active');
    showToast('已启用透明悬浮；移入可显示操作层');
    return;
  }
  floatingScheduleDate='';
  showToast('请启动透明悬浮助手，并允许浏览器访问本地网络',true);
}

function render() {
  renderIdeas(); renderCalendar();
  $('#ideas-view').classList.remove('hidden');
  renderFloatingSchedule();
}

function isInlineEditing() { return Boolean(document.querySelector('.editable-text.inline-editing')); }
function activeEditKey() {
  const element=document.querySelector('.editable-text.inline-editing');
  if (!element) return '';
  if (element.dataset.editIdeaContent) return recordKey('idea',element.dataset.editIdeaContent);
  if (element.dataset.editEventTitle) return recordKey('event',element.dataset.editEventTitle);
  if (element.dataset.editEventNote) return recordKey('event',element.dataset.editEventNote);
  return '';
}
function renderUnlessEditing() { if (!isInlineEditing()) render(); }
function resumeSyncAfterEdit() {
  if (IS_CLOUD && syncDirty) queueCloudSync();
}

function showEventAtTop(item) {
  const date=item?.start ? new Date(item.start) : null;
  if (date && !Number.isNaN(date.getTime())) {
    calendarCursor.setFullYear(date.getFullYear(),date.getMonth(),1);
    selectedCalendarDate=localDateKey(date);
    renderCalendar();
  } else {
    selectedCalendarDate='';
    renderCalendarDetail();
  }
  requestAnimationFrame(()=>$('#calendar-panel').scrollIntoView({behavior:'smooth',block:'center'}));
}

async function analyze() {
  const input = $('#capture-input');
  const text = input.value.trim();
  if (!text) return showToast('先写点什么吧', true);
  const button = $('#analyze-button');
  const original = button.innerHTML;
  const longForm=isLongForm(text);
  const useAi=needsAiAnalysis(text);
  button.disabled = true; button.querySelector('span').textContent = useAi ? 'AI 正在整理…' : '正在保存…';
  $('#capture-hint').textContent = useAi ? (longForm ? '长文原样保存，并抽取明确待办' : '正在辨认灵感与日程') : '整段直接保存为灵感，不消耗 AI';
  try {
    if (!useAi) {
      state.ideas.unshift(directIdeaFrom(text,{id:uid(),createdAt:new Date().toISOString()}));
      saveState(); input.value=''; showToast('已直接保存为灵感 · 未使用 AI');
      return;
    }
    const response = await fetch(apiUrl('analyze'), { method:'POST', headers:{'Content-Type':'application/json',...authHeaders()}, body:JSON.stringify({ text, longForm, now:new Date().toISOString(), timezone:Intl.DateTimeFormat().resolvedOptions().timeZone }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '分析失败');
    const createdAt = new Date().toISOString();
    const analyzedIdeas=Array.isArray(result.ideas) ? result.ideas : [];
    const analyzedEvents=Array.isArray(result.events) ? result.events : [];
    const keepAsIdea=longForm || analyzedIdeas.length>0;
    const directIdea=directIdeaFrom(text,{id:uid(),createdAt});
    const ideas=keepAsIdea ? [{...directIdea,title:analyzedIdeas[0]?.title || directIdea.title,theme:analyzedIdeas[0]?.theme || directIdea.theme}] : [];
    const events = analyzedEvents.map((item) => ({...item,id:uid(),createdAt,source:text,done:false}));
    if (!ideas.length && !events.length) throw new Error('没有识别出可记录的内容，请换种说法');
    state.ideas.unshift(...ideas); state.events.unshift(...events); saveState(); input.value='';
    const parts=[]; if(ideas.length) parts.push(`${ideas.length} 个灵感`); if(events.length) parts.push(`${events.length} 个日程`);
    showToast(`已记下 ${parts.join('、')}`);
    if (events.length) showEventAtTop(events[0]);
  } catch (error) {
    state.ideas.unshift(directIdeaFrom(text,{id:uid(),createdAt:new Date().toISOString()}));
    saveState(); input.value='';
    showToast('AI 暂时没有整理成功，已先保存为灵感',true);
  }
  finally { button.disabled=false; button.innerHTML=original; $('#capture-hint').textContent='灵感、日程，或两者混合都可以'; }
}

$$('[data-tab]').forEach((button) => button.addEventListener('click', () => window.scrollTo({top:0,behavior:'smooth'})));
$('#calendar-prev').addEventListener('click',()=>{calendarCursor.setMonth(calendarCursor.getMonth()-1);renderCalendar();});
$('#calendar-next').addEventListener('click',()=>{calendarCursor.setMonth(calendarCursor.getMonth()+1);renderCalendar();});
$('#calendar-grid').addEventListener('click',(event)=>{
  const day=event.target.closest('[data-calendar-date]');
  if (!day) return;
  selectedCalendarDate=day.dataset.calendarDate;
  renderCalendarDetail();
});
$('#calendar-back').addEventListener('click',()=>{selectedCalendarDate='';renderCalendarDetail();});
$('#floating-button').addEventListener('click',openFloatingSchedule);
$('#analyze-button').addEventListener('click', analyze);
$('#capture-input').addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') analyze(); });
$('#search-toggle').addEventListener('click', () => { $('#search-row').classList.toggle('hidden'); if (!$('#search-row').classList.contains('hidden')) $('#search-input').focus(); });
$('#search-input').addEventListener('input', (event) => { search=event.target.value.trim().toLowerCase(); visibleIdeaLimit=20; render(); });
$('#theme-filters').addEventListener('click', (event) => { const button=event.target.closest('button'); if(!button)return; currentTheme=button.dataset.theme; visibleIdeaLimit=20; $$('#theme-filters button').forEach((b)=>b.classList.toggle('active',b===button)); renderIdeas(); });
$('#ideas-load-more').addEventListener('click',()=>{visibleIdeaLimit+=40;renderIdeas();});

function inlineEditDescriptor(element) {
  if (element.dataset.editIdeaContent) return { item:state.ideas.find((entry)=>entry.id===element.dataset.editIdeaContent), field:'content', label:'灵感内容', allowEmpty:false };
  if (element.dataset.editEventTitle) return { item:state.events.find((entry)=>entry.id===element.dataset.editEventTitle), field:'title', label:'日程名称', allowEmpty:false };
  if (element.dataset.editEventNote) return { item:state.events.find((entry)=>entry.id===element.dataset.editEventNote), field:'note', label:'日程备注', allowEmpty:true };
  return null;
}

let inlineEditSession=null;

function startInlineEdit(element) {
  if (!element || element.isContentEditable) return;
  if (inlineEditSession && inlineEditSession.element!==element) inlineEditSession.finish(true);
  const descriptor=inlineEditDescriptor(element);
  if (!descriptor?.item) return;
  const {item,field,label,allowEmpty}=descriptor;
  const original=String(item[field] || '');
  let finished=false;
  let onKeydown;
  const actions=document.createElement('div');
  actions.className='inline-edit-actions';
  actions.setAttribute('role','group');
  actions.setAttribute('aria-label',`${label}编辑操作`);
  actions.innerHTML='<button type="button" data-inline-save>保存</button><button type="button" data-inline-cancel>取消</button>';
  element.contentEditable='true';
  element.classList.add('inline-editing');
  element.setAttribute('role','textbox');
  element.setAttribute('aria-multiline',String(field!=='title'));
  element.insertAdjacentElement('afterend',actions);
  element.focus();
  const range=document.createRange(); range.selectNodeContents(element); range.collapse(false);
  const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);

  const finish=(save) => {
    if (finished) return;
    finished=true;
    const value=element.innerText.trim();
    actions.remove();
    element.contentEditable='false';
    element.classList.remove('inline-editing');
    element.removeAttribute('role');
    element.removeAttribute('aria-multiline');
    element.removeEventListener('keydown',onKeydown);
    if (inlineEditSession?.element===element) inlineEditSession=null;
    if (!save || (!value && !allowEmpty)) {
      element.textContent=original;
      if (save && !value) showToast(`${label}不能为空`,true);
      resumeSyncAfterEdit();
      return;
    }
    if (value===original) {
      resumeSyncAfterEdit();
      return;
    }
    item[field]=value;
    saveState();
    showToast(`${label}已更新`);
    resumeSyncAfterEdit();
  };
  inlineEditSession={element,finish};
  actions.querySelector('[data-inline-save]').addEventListener('click',()=>finish(true));
  actions.querySelector('[data-inline-cancel]').addEventListener('click',()=>finish(false));
  onKeydown=(event)=>{
    if (event.key==='Escape') { event.preventDefault(); finish(false); }
    if (event.key==='Enter' && (field==='title' || event.ctrlKey || event.metaKey)) { event.preventDefault(); finish(true); }
  };
  element.addEventListener('keydown',onKeydown);
}

function editableFrom(target) { return target instanceof Element ? target.closest('.editable-text') : null; }
document.addEventListener('dblclick',(event)=>startInlineEdit(editableFrom(event.target)));
let lastTouchTarget=null; let lastTouchAt=0;
document.addEventListener('pointerup',(event)=>{
  if (event.pointerType!=='touch') return;
  const target=editableFrom(event.target); if(!target)return;
  const now=Date.now();
  if (target===lastTouchTarget && now-lastTouchAt<450) { event.preventDefault(); startInlineEdit(target); lastTouchTarget=null; lastTouchAt=0; }
  else { lastTouchTarget=target; lastTouchAt=now; }
});

document.addEventListener('click', (event) => {
  const ideaButton=event.target.closest('[data-delete-idea]');
  const eventButton=event.target.closest('[data-delete-event]');
  const toggleButton=event.target.closest('[data-toggle-event]');
  const copyButton=event.target.closest('[data-copy-idea]');
  const ideaId=ideaButton?.dataset.deleteIdea; const eventId=eventButton?.dataset.deleteEvent; const toggleId=toggleButton?.dataset.toggleEvent;
  if(copyButton) {
    const item=state.ideas.find((idea)=>idea.id===copyButton.dataset.copyIdea);
    if(item) copyText(item.content || item.title);
  }
  if(ideaId) {
    const removal=removeById(state.ideas,ideaId); if(!removal)return; saveState();
    showToast('灵感已删除',false,()=>{restoreAt(state.ideas,removal);saveState();showToast('已恢复灵感')});
  }
  if(eventId) {
    const removal=removeById(state.events,eventId); if(!removal)return; saveState();
    showToast('日程已删除',false,()=>{restoreAt(state.events,removal);saveState();showToast('已恢复日程')});
  }
  if(toggleId) { const item=state.events.find((event)=>event.id===toggleId); if(item){item.done=!item.done;saveState();} }
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('灵感已复制');
  } catch {
    const input=document.createElement('textarea'); input.value=text; input.style.position='fixed'; input.style.opacity='0';
    document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove(); showToast('灵感已复制');
  }
}

$('#export-button').addEventListener('click', async () => {
  try {
    let blob;
    let filename;
    if (IS_CLOUD) {
      const response = await fetch(apiUrl('archive?format=markdown'), {headers:authHeaders()});
      if (!response.ok) throw new Error((await response.json().catch(()=>({}))).error || '知识归档下载失败');
      blob = await response.blob();
      filename = `想想-知识库-${new Date().toISOString().slice(0,10)}.md`;
    } else {
      blob = new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
      filename = `想想-${new Date().toISOString().slice(0,10)}.json`;
    }
    const url=URL.createObjectURL(blob); const a=document.createElement('a');
    a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);showToast('知识归档已导出');
  } catch (error) { showToast(error.message || '知识归档下载失败',true); }
});

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const recognition=new SpeechRecognition(); recognition.lang='zh-CN'; recognition.continuous=false; recognition.interimResults=true;
  recognition.onstart=()=>{$('#mic-button').classList.add('listening');$('#capture-hint').textContent='正在听你说…'};
  recognition.onresult=(event)=>{$('#capture-input').value=[...event.results].map((r)=>r[0].transcript).join('')};
  recognition.onend=()=>{$('#mic-button').classList.remove('listening');$('#capture-hint').textContent='语音已转成文字，确认后记下'};
  $('#mic-button').addEventListener('click',()=>recognition.start());
} else { $('#mic-button').addEventListener('click',()=>showToast('当前浏览器不支持语音输入',true)); }

const now=new Date();
$('#today-label').textContent=now.toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'});
render();
bootstrapCloudSync();
if ('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{}));
