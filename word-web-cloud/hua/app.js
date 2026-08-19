import { removeById, restoreAt } from './state-utils.js';

const STORAGE_KEY = 'suishouji-data-v1';
const FORCE_CLOUD = new URLSearchParams(location.search).get('cloud') === '1';
const IS_CLOUD = FORCE_CLOUD || !['localhost', '127.0.0.1'].includes(location.hostname);
const BASE_PATH = location.pathname.startsWith('/hua') || FORCE_CLOUD ? '/hua' : '';
const API_ORIGIN = location.hostname === 'dahuajiujiu.com' ? '' : (FORCE_CLOUD ? 'https://xiangxiang-private.dahuajiujiu-hua.workers.dev' : '');
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
let lastRemoteUpdate = '';
let hasUnsyncedChanges = false;

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed && Array.isArray(parsed.ideas) && Array.isArray(parsed.events)) return parsed;
  } catch {}
  return { ideas: [], events: [] };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  render();
  if (IS_CLOUD) queueCloudPush();
}

function setSyncStatus(text, error=false) {
  const el = $('#sync-status');
  if (!el) return;
  el.textContent = text;
  el.closest('.ai-status')?.classList.toggle('sync-error', error);
}

function stateHasContent(value) {
  return Boolean(value?.ideas?.length || value?.events?.length);
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

async function pushCloudState() {
  if (!IS_CLOUD) return;
  if (syncBusy) { syncDirty = true; return; }
  syncBusy = true;
  setSyncStatus('正在同步…');
  try {
    const snapshot = structuredClone(state);
    const payload = await cloudRequest('state', { method:'PUT', body:JSON.stringify({ state:snapshot }) });
    lastRemoteUpdate = String(payload.version ?? payload.updatedAt ?? lastRemoteUpdate);
    hasUnsyncedChanges = syncDirty;
    setSyncStatus('云端已同步');
  } catch (error) {
    hasUnsyncedChanges = true;
    setSyncStatus('同步失败，稍后重试', true);
  } finally {
    syncBusy = false;
    if (syncDirty) { syncDirty = false; pushCloudState(); }
  }
}

function queueCloudPush() {
  hasUnsyncedChanges = true;
  syncDirty = true;
  queueMicrotask(() => {
    if (!syncBusy && syncDirty) { syncDirty = false; pushCloudState(); }
  });
}

async function pullCloudState(initial=false) {
  if (!IS_CLOUD) return;
  if (syncBusy) return;
  try {
    const payload = await cloudRequest('state', { method:'GET' });
    const remote = payload.state;
    if (initial && !stateHasContent(remote) && stateHasContent(state)) {
      hasUnsyncedChanges = true;
      await pushCloudState();
      return;
    }
    if (hasUnsyncedChanges) {
      await pushCloudState();
      return;
    }
    const remoteVersion = String(payload.version ?? payload.updatedAt ?? '');
    if (remoteVersion && remoteVersion !== lastRemoteUpdate && remote && Array.isArray(remote.ideas) && Array.isArray(remote.events)) {
      state = remote;
      lastRemoteUpdate = remoteVersion;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      render();
    }
    setSyncStatus('云端已同步');
  } catch (error) {
    setSyncStatus(FORCE_CLOUD ? error.message : (error.message.includes('访问') ? '私人链接无效' : '云端暂时不可用'), true);
  }
}

async function bootstrapCloudSync() {
  if (!IS_CLOUD) { setSyncStatus('仅保存在此设备'); return; }
  await pullCloudState(true);
  window.setInterval(() => pullCloudState(false), 2000);
  window.addEventListener('focus', () => pullCloudState(false));
  window.addEventListener('online', () => pullCloudState(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pullCloudState(false);
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
      <p class="bubble-content">${esc(item.content || item.title)}</p>
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
        <div class="event-copy"><h3>${esc(item.title)}</h3>${item.note ? `<p>${esc(item.note)}</p>`:''}</div>
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
