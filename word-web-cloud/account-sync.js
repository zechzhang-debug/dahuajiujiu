(() => {
  const STORAGE_KEY = 'dahuajiujiu_state_v2';
  const API_BASE = window.DAHUA_ACCOUNT_CONFIG?.apiBase || '/api';
  const LEVELS = ['primary', 'junior', 'senior', 'ielts'];
  let account = null;
  let capabilities = { wechatEnabled: false, devEnabled: false };
  let lastSyncedState = null;
  let syncTimer = null;
  let applyingRemote = false;
  let trigger;
  let dialog;

  function emptyState() {
    return { currentLevel: 'primary', statuses: { primary: {}, junior: {}, senior: {}, ielts: {} } };
  }

  function normalizeState(value) {
    const source = value && typeof value === 'object' ? value : {};
    const result = emptyState();
    if (LEVELS.includes(source.currentLevel)) result.currentLevel = source.currentLevel;
    LEVELS.forEach((level) => {
      const map = source.statuses?.[level];
      if (!map || typeof map !== 'object') return;
      Object.entries(map).forEach(([key, status]) => {
        if (key && (status === 'mastered' || status === 'difficult')) result.statuses[level][key] = status;
      });
    });
    return result;
  }

  function readLocalState() {
    if (window.DahuaLearning?.getState) return normalizeState(window.DahuaLearning.getState());
    try { return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); }
    catch { return emptyState(); }
  }

  async function applyState(state) {
    applyingRemote = true;
    try {
      if (window.DahuaLearning?.applyState) await window.DahuaLearning.applyState(state);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeState(state)));
    } finally {
      applyingRemote = false;
    }
  }

  async function api(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP_${response.status}`);
    return data;
  }

  function stateDiff(before, after) {
    const entries = [];
    LEVELS.forEach((level) => {
      const oldMap = before?.statuses?.[level] || {};
      const nextMap = after.statuses[level] || {};
      new Set([...Object.keys(oldMap), ...Object.keys(nextMap)]).forEach((itemKey) => {
        const oldStatus = oldMap[itemKey] || '';
        const status = nextMap[itemKey] || '';
        if (oldStatus !== status) entries.push({ level, itemKey, status });
      });
    });
    return entries;
  }

  async function initialSync() {
    if (!account) return;
    setSyncLabel('正在同步');
      const result = await api('/progress');
    const remoteState = normalizeState(result.state);
    const localState = readLocalState();
    // Cloud sync owns word statuses only. The active vocabulary is a local UI choice.
    await applyState({ ...remoteState, currentLevel: localState.currentLevel });
    lastSyncedState = remoteState;
    setSyncLabel('进度已同步');
  }

  async function syncNow() {
    clearTimeout(syncTimer);
    if (!account || applyingRemote) return;
    const current = readLocalState();
    const entries = stateDiff(lastSyncedState || emptyState(), current);
    if (!entries.length) {
      setSyncLabel('进度已同步');
      return;
    }
    try {
      setSyncLabel('正在同步');
      const result = await api('/progress', {
        method: 'PATCH',
        body: JSON.stringify({ entries })
      });
      lastSyncedState = normalizeState(result.state);
      setSyncLabel('进度已同步');
    } catch {
      setSyncLabel('同步待重试');
    }
  }

  function queueSync() {
    if (!account || applyingRemote) return;
    clearTimeout(syncTimer);
    setSyncLabel('等待同步');
    syncTimer = setTimeout(syncNow, 900);
  }

  window.DahuaAccountSync = { flush: syncNow };

  function setSyncLabel(text) {
    const node = dialog?.querySelector('[data-account-sync]');
    if (node) node.textContent = text;
  }

  function ensureUi() {
    const existing = document.querySelector('.login-button');
    trigger = existing || document.createElement('button');
    if (!existing) {
      trigger.type = 'button';
      trigger.className = 'dahua-account-trigger';
      const moduleNav = document.querySelector('.module-nav');
      (moduleNav || document.body).appendChild(trigger);
    }
    trigger.setAttribute('aria-label', '学习账号');

    dialog = document.createElement('dialog');
    dialog.className = 'dahua-account-dialog';
    dialog.setAttribute('aria-labelledby', 'dahua-account-title');
    dialog.innerHTML = '<div class="dahua-account-panel"></div>';
    document.body.appendChild(dialog);

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!account && capabilities.wechatEnabled) {
        window.location.assign(`${API_BASE}/auth/wechat/start`);
        return;
      }
      renderDialog();
      dialog.showModal();
    }, true);
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  }

  function renderTrigger() {
    if (account) {
      trigger.dataset.state = 'signed-in';
      trigger.setAttribute('aria-label', `${account.displayName}的学习账号`);
      const label = trigger.querySelector('.login-label');
      if (label) label.textContent = account.displayName;
      else trigger.textContent = account.displayName;
    } else {
      trigger.dataset.state = 'guest';
      trigger.setAttribute('aria-label', capabilities.wechatEnabled ? '微信一键登录' : '学习账号');
      const label = trigger.querySelector('.login-label');
      if (label) label.textContent = capabilities.wechatEnabled ? '微信一键登录' : '微信登录';
      else trigger.textContent = '学习账号';
    }
  }

  function renderDialog(message = '') {
    const panel = dialog.querySelector('.dahua-account-panel');
    if (account) {
      panel.innerHTML = `
        <h2 id="dahua-account-title">${escapeHtml(account.displayName)}</h2>
        <p>学习阶段：${levelName(account.learningLevel)} · 身份：${roleName(account.role)}</p>
        <p class="dahua-account-sync" data-account-sync>进度已同步</p>
        <div class="dahua-account-actions">
          <button type="button" data-account-close>继续学习</button>
          <button type="button" data-account-logout>退出登录</button>
          <button type="button" class="danger" data-account-delete>注销账号</button>
        </div>
        <p class="dahua-account-note"><a href="privacy.html">隐私政策</a> · <a href="terms.html">用户协议</a></p>`;
      panel.querySelector('[data-account-close]').onclick = () => dialog.close();
      panel.querySelector('[data-account-logout]').onclick = logout;
      panel.querySelector('[data-account-delete]').onclick = deleteAccount;
      return;
    }

    const action = capabilities.wechatEnabled
      ? '<a class="primary" href="/api/auth/wechat/start">微信扫码登录</a>'
      : capabilities.devEnabled
        ? `<label class="dahua-account-code">
            <span>测试账号代码</span>
            <input type="text" value="dahua-demo" maxlength="40" autocomplete="off" data-dev-code>
          </label>
          <button class="primary" type="button" data-dev-login>登录测试账号</button>`
        : '<button class="primary" type="button" disabled>微信审核中</button>';
    panel.innerHTML = `
      <h2 id="dahua-account-title">学习账号</h2>
      <p>${message || (capabilities.wechatEnabled ? '登录后可在不同设备继续学习。' : '微信开放平台审核期间，学习进度仍会保存在当前设备。')}</p>
      <div class="dahua-account-actions">${action}<button type="button" data-account-close>关闭</button></div>
      <p class="dahua-account-note"><a href="privacy.html">隐私政策</a> · <a href="terms.html">用户协议</a></p>`;
    panel.querySelector('[data-account-close]').onclick = () => dialog.close();
    const devButton = panel.querySelector('[data-dev-login]');
    if (devButton) devButton.onclick = devLogin;
  }

  async function devLogin() {
    try {
      const accountCode = dialog.querySelector('[data-dev-code]')?.value.trim() || 'dahua-demo';
      const result = await api('/auth/dev-login', {
        method: 'POST',
        body: JSON.stringify({ displayName: '测试学习账号', accountCode })
      });
      account = result.user;
      renderTrigger();
      await initialSync();
      renderDialog();
    } catch { renderDialog('测试登录暂时不可用。'); }
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
    account = null;
    lastSyncedState = null;
    renderTrigger();
    renderDialog('已经退出登录，本机进度会继续保留。');
  }

  async function deleteAccount() {
    if (!confirm('确认注销账号并删除云端学习进度吗？本机进度不会删除。')) return;
    await api('/account', { method: 'DELETE', body: '{}' });
    account = null;
    lastSyncedState = null;
    renderTrigger();
    renderDialog('账号和云端进度已删除。');
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }

  function levelName(value) {
    return ({ primary: '小学', junior: '初中', senior: '高中', ielts: '雅思' })[value] || '小学';
  }

  function roleName(value) {
    return ({ user: '学生', vip: '会员', teacher: '教师', admin: '管理员' })[value] || '学生';
  }

  async function init() {
    ensureUi();
    renderTrigger();
    window.addEventListener('dahuajiujiu:progress-changed', queueSync);
    try {
      const result = await api('/me');
      account = result.authenticated ? result.user : null;
      capabilities = result.login || capabilities;
      renderTrigger();
      if (account) await initialSync();
    } catch {
      capabilities = { wechatEnabled: false, devEnabled: false };
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
