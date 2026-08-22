import { removeById, restoreAt } from './state-utils.js';

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
let currentTab = 'ideas';
let currentTheme = '全部';
let search = '';
let toastTimer;
let pendingUndo = null;
let otherExpanded = false;
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
  render();
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
  render();
  setSyncStatus('云端已同步（兼容模式）');
}

async function syncCloud() {
  if (!IS_CLOUD) return;
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
      render();
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
  const items = state.ideas.filter((item) => (currentTheme === '全部' || item.theme === currentTheme) && `${item.title} ${item.content} ${item.theme}`.toLowerCase().includes(search));
  $('#ideas-summary').textContent = `${state.ideas.length} 个灵感`;
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
  $('#ideas-empty').classList.toggle('hidden', items.length > 0);
}

function formatDayLabel(key) {
  if (key === '9999-99-99') return { day:'待定', week:'未安排' };
  const date = new Date(`${key}T12:00:00`);
  const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate()+1);
  let week = date.toLocaleDateString('zh-CN',{weekday:'short'});
  if (date.toDateString() === today.toDateString()) week = '今天';
  if (date.toDateString() === tomorrow.toDateString()) week = '明天';
  return { day:String(date.getDate()).padStart(2,'0'), week };
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

function eventGroupsHtml(items) {
  const groups = sortEvents(items).reduce((result, item) => {
    const key = dayKey(item);
    (result[key] ||= []).push(item);
    return result;
  }, {});
  return Object.entries(groups).map(([key,items]) => {
    const label = formatDayLabel(key);
    return `<div class="day-group"><div class="day-label"><b>${label.day}</b><span>${label.week}</span></div><div class="day-events">${items.map((item) => `
      <article class="event-card ${item.done ? 'done':''}">
        <button class="check" data-toggle-event="${item.id}" aria-label="${item.done?'标记未完成':'标记完成'}">${item.done?'✓':''}</button>
        <span class="event-time">${eventTime(item)}</span>
        <div class="event-copy"><h3 class="editable-text" data-edit-event-title="${item.id}" title="双击修改">${esc(item.title)}</h3>${item.note ? `<p class="editable-text" data-edit-event-note="${item.id}" title="双击修改">${esc(item.note)}</p>`:''}</div>
        <button class="delete" data-delete-event="${item.id}" aria-label="删除日程" title="删除"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6"/></svg></button>
      </article>`).join('')}</div></div>`;
  }).join('');
}

function renderSchedule() {
  const filtered = state.events.filter((item) => `${item.title} ${item.note}`.toLowerCase().includes(search));
  const today = new Date(); today.setHours(0,0,0,0);
  const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate()+7);
  const focused = filtered.filter((item) => {
    if (item.done || !item.start) return false;
    const date = new Date(item.start);
    return !Number.isNaN(date.getTime()) && date >= today && date < weekEnd;
  });
  const focusedIds = new Set(focused.map((item) => item.id));
  const others = filtered.filter((item) => !focusedIds.has(item.id));
  $('#timeline').innerHTML = eventGroupsHtml(focused);
  $('#other-timeline').innerHTML = eventGroupsHtml(others);
  $('#timeline-focus').classList.toggle('hidden', focused.length === 0);
  $('#schedule-empty').classList.toggle('hidden', focused.length > 0);
  $('#other-schedules').classList.toggle('hidden', others.length === 0);
  $('#other-content').classList.toggle('hidden', !otherExpanded);
  $('#other-toggle').setAttribute('aria-expanded', String(otherExpanded));
  $('#other-toggle').classList.toggle('expanded', otherExpanded);
  const pastPending = others.filter((item) => !item.done && item.start && new Date(item.start) < today).length;
  const laterPending = others.filter((item) => !item.done && item.start && new Date(item.start) >= weekEnd).length;
  const undated = others.filter((item) => !item.done && !item.start).length;
  const completed = others.filter((item) => item.done).length;
  const parts = [];
  if (pastPending) parts.push(`${pastPending} 个过期`);
  if (laterPending) parts.push(`${laterPending} 个稍后`);
  if (undated) parts.push(`${undated} 个待定`);
  if (completed) parts.push(`${completed} 个已完成`);
  $('#other-summary').textContent = parts.join(' · ');
  const done = state.events.filter((event) => event.done).length;
  $('#pending-count').textContent = state.events.length-done;
  $('#done-count').textContent = done;
  $('#event-count-side').textContent = state.events.filter((event) => !event.done).length;
}

function render() {
  renderIdeas(); renderSchedule();
  $$('.nav-item,.mobile-nav button').forEach((button) => button.classList.toggle('active', button.dataset.tab === currentTab));
  $('#ideas-view').classList.toggle('hidden', currentTab !== 'ideas');
  $('#schedule-view').classList.toggle('hidden', currentTab !== 'schedule');
  $('#page-title').textContent = currentTab === 'ideas' ? '灵感泡泡' : '我的日程';
}

function switchTab(tab) { currentTab = tab; render(); window.scrollTo({top:0,behavior:'smooth'}); }

async function analyze() {
  const input = $('#capture-input');
  const text = input.value.trim();
  if (!text) return showToast('先写点什么吧', true);
  const button = $('#analyze-button');
  const original = button.innerHTML;
  button.disabled = true; button.querySelector('span').textContent = 'AI 正在整理…';
  $('#capture-hint').textContent = '正在辨认灵感与日程';
  try {
    const response = await fetch(apiUrl('analyze'), { method:'POST', headers:{'Content-Type':'application/json',...authHeaders()}, body:JSON.stringify({ text, now:new Date().toISOString(), timezone:Intl.DateTimeFormat().resolvedOptions().timeZone }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '分析失败');
    const createdAt = new Date().toISOString();
    const ideas = result.ideas.map((item) => ({...item,id:uid(),createdAt,source:text}));
    const events = result.events.map((item) => ({...item,id:uid(),createdAt,source:text,done:false}));
    if (!ideas.length && !events.length) throw new Error('没有识别出可记录的内容，请换种说法');
    state.ideas.unshift(...ideas); state.events.unshift(...events); saveState(); input.value='';
    const parts=[]; if(ideas.length) parts.push(`${ideas.length} 个灵感`); if(events.length) parts.push(`${events.length} 个日程`);
    showToast(`已记下 ${parts.join('、')}`);
    if (!ideas.length && events.length) switchTab('schedule');
  } catch (error) {
    const message = error instanceof TypeError && /fetch/i.test(error.message)
      ? '连接不到整理服务，请确认随手记服务正在运行'
      : (error.message || '分析失败，请重试');
    showToast(message, true);
  }
  finally { button.disabled=false; button.innerHTML=original; $('#capture-hint').textContent='灵感、日程，或两者混合都可以'; }
}

$$('[data-tab]').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
$('#analyze-button').addEventListener('click', analyze);
$('#capture-input').addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') analyze(); });
$('#search-toggle').addEventListener('click', () => { $('#search-row').classList.toggle('hidden'); if (!$('#search-row').classList.contains('hidden')) $('#search-input').focus(); });
$('#search-input').addEventListener('input', (event) => { search=event.target.value.trim().toLowerCase(); render(); });
$('#theme-filters').addEventListener('click', (event) => { const button=event.target.closest('button'); if(!button)return; currentTheme=button.dataset.theme; $$('#theme-filters button').forEach((b)=>b.classList.toggle('active',b===button)); renderIdeas(); });
$('#other-toggle').addEventListener('click', () => { otherExpanded=!otherExpanded; renderSchedule(); });

function inlineEditDescriptor(element) {
  if (element.dataset.editIdeaContent) return { item:state.ideas.find((entry)=>entry.id===element.dataset.editIdeaContent), field:'content', label:'灵感内容', allowEmpty:false };
  if (element.dataset.editEventTitle) return { item:state.events.find((entry)=>entry.id===element.dataset.editEventTitle), field:'title', label:'日程名称', allowEmpty:false };
  if (element.dataset.editEventNote) return { item:state.events.find((entry)=>entry.id===element.dataset.editEventNote), field:'note', label:'日程备注', allowEmpty:true };
  return null;
}

function startInlineEdit(element) {
  if (!element || element.isContentEditable) return;
  const descriptor=inlineEditDescriptor(element);
  if (!descriptor?.item) return;
  const {item,field,label,allowEmpty}=descriptor;
  const original=String(item[field] || '');
  let finished=false;
  element.contentEditable='true';
  element.classList.add('inline-editing');
  element.setAttribute('role','textbox');
  element.setAttribute('aria-multiline',String(field!=='title'));
  element.focus();
  const range=document.createRange(); range.selectNodeContents(element); range.collapse(false);
  const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);

  const finish=(save) => {
    if (finished) return;
    finished=true;
    const value=element.innerText.trim();
    if (!save || (!value && !allowEmpty)) {
      element.textContent=original;
      element.contentEditable='false';
      element.classList.remove('inline-editing');
      if (save && !value) showToast(`${label}不能为空`,true);
      return;
    }
    if (value===original) {
      element.contentEditable='false';
      element.classList.remove('inline-editing');
      return;
    }
    item[field]=value;
    saveState();
    showToast(`${label}已更新`);
  };
  element.addEventListener('blur',()=>finish(true),{once:true});
  element.addEventListener('keydown',(event)=>{
    if (event.key==='Escape') { event.preventDefault(); finish(false); }
    if (event.key==='Enter' && (field==='title' || event.ctrlKey || event.metaKey)) { event.preventDefault(); finish(true); }
  });
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
const weekLast=new Date(now); weekLast.setDate(weekLast.getDate()+6);
$('#schedule-month').textContent=`${now.toLocaleDateString('zh-CN',{month:'long',day:'numeric'})} — ${weekLast.toLocaleDateString('zh-CN',{month:'long',day:'numeric'})}`;
render();
bootstrapCloudSync();
if ('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{}));
