/**
 * LOF 基金溢价监控工具
 * 数据来源：东方财富 / 天天基金 非官方公开接口
 * 溢价率 = (场内价格 - 单位净值) / 单位净值 × 100%
 */

// ─── Constants ───────────────────────────────────────────────────────────
const NAV_CACHE_TTL = 60 * 60 * 1000; // 净值缓存有效期：1 小时
const NAV_REQUEST_DELAY = 400;            // 每次净值请求间隔（ms），防止被 ban


// ─── State ───────────────────────────────────────────────────────────────
let spotFunds = [];   // 原始场内行情（不含净值）
let allFunds = [];   // 合并净值后的完整数据
let filteredFunds = [];
let sortKey = 'premium';
let sortDir = 'desc';
let isLoading = false;

// 净值缓存：code → { nav, ts }
const navCache = new Map();
let navFetching = false;     // 是否正在手动获取净值
let navFetchAbort = false;   // 用户取消标志

// ─── DOM refs ─────────────────────────────────────────────────────────────
const tableBody = document.getElementById('table-body');
const searchInput = document.getElementById('search-input');
const filterSelect = document.getElementById('filter-select');
const refreshBtn = document.getElementById('refresh-btn');
const navFetchBtn = document.getElementById('nav-fetch-btn');
const navFetchStatus = document.getElementById('nav-fetch-status');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const totalEl = document.getElementById('stat-total');
const premiumEl = document.getElementById('stat-premium');
const discountEl = document.getElementById('stat-discount');
const topEl = document.getElementById('stat-top');
const tableCountEl = document.getElementById('table-count');
const toastContainer = document.getElementById('toast-container');

// ─── API ────────────────────────────────────────────────────────

// 后端 API 基础路径
const API_BASE = '/api';

/**
 * 从后端拉取所有数据
 */
async function fetchFundsFromBackend() {
  const res = await fetch(`${API_BASE}/funds`);
  if (!res.ok) throw new Error(`后端接口异常，状态码：${res.status}`);
  return await res.json();
}

/**
 * 触发后端全量刷新场内行情
 */
async function triggerBackendSpotFetch() {
  const res = await fetch(`${API_BASE}/fetch/spot`, { method: 'POST' });
  if (!res.ok) throw new Error('触发刷新行情失败');
}

/**
 * 触发后端刷新单条净值
 */
async function triggerBackendNavFetch(code) {
  const res = await fetch(`${API_BASE}/fetch/nav/${code}`, { method: 'POST' });
  if (!res.ok) throw new Error('触发净值刷新失败');
}

// ─── 核心：加载数据 ────────────────────────────────────────────────────────

async function loadData() {
  if (isLoading) return;
  isLoading = true;
  setStatus('loading', '正在从数据库同步数据…');
  refreshBtn.disabled = true;
  if (allFunds.length === 0) showLoading(); // 只在初始加载时霸屏动画

  try {
    allFunds = await fetchFundsFromBackend();
    console.log(`[LOF Monitor] 加载完成，共 ${allFunds.length} 只`);

    updateStats();
    applyFilters();
    updateNavFetchBtn();

    setStatus('live', `最新同步：${now()}`);
  } catch (e) {
    console.error('[LOF Monitor] 数据加载异常：', e);
    setStatus('error', '连接后端失败');
    if (allFunds.length === 0) showError(e.message);
    toast(e.message, 'error');
  } finally {
    isLoading = false;
    refreshBtn.disabled = false;
  }
}

async function triggerSpotRefresh() {
  if (isLoading) return;
  isLoading = true;
  setStatus('loading', '正在触发后端行情更新…');
  refreshBtn.disabled = true;

  try {
    await triggerBackendSpotFetch();
    toast('已通知后端更新行情，数据稍后就绪', 'success');
    // 设置一个定时器，等待后端抓取完毕后拉取最新列表
    setTimeout(() => {
      isLoading = false;
      loadData();
    }, 2000);
  } catch (e) {
    toast(e.message, 'error');
    isLoading = false;
    refreshBtn.disabled = false;
  }
}

async function fetchNavManual() {
  // 当前为了简化，"获取净值" 按钮不再需要在前端执行 for 循环。
  // 可以设计为一个简单的提示：净值由后端定时任务自动获取，或引导用户点击具体单行
  toast('正在后台批量更新暂缺净值的基金，请稍后刷新查看', 'info');
  // 可选：实现一个后端批量刷新接口，这里先不做复杂的前端控制队列
}

function updateNavFetchBtn() {
  if (!navFetchBtn) return;
  const noNavCount = allFunds.filter(f => f.nav == null).length;
  navFetchBtn.textContent = '🔄 净值自动同步中';
  if (navFetchStatus) {
    navFetchStatus.textContent = noNavCount > 0
      ? `目前有 ${noNavCount} 支基金等待后端获取净值`
      : '所有基金已具有净值数据（后端调度中）';
  }
}

function applyFilters() {
  const q = searchInput.value.trim().toLowerCase();
  const filter = filterSelect.value;

  filteredFunds = allFunds.filter(f => {
    if (q && !f.code.includes(q) && !f.name.toLowerCase().includes(q)) return false;
    if (filter === 'premium' && (f.premium == null || f.premium <= 0)) return false;
    if (filter === 'discount' && (f.premium == null || f.premium >= 0)) return false;
    if (filter === 'high' && (f.premium == null || Math.abs(f.premium) < 1)) return false;
    if (filter === 'nonav' && f.nav !== null) return false;
    return true;
  });

  sortFunds();
  renderTable();
}

function sortFunds() {
  filteredFunds.sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (av == null) av = sortDir === 'asc' ? Infinity : -Infinity;
    if (bv == null) bv = sortDir === 'asc' ? Infinity : -Infinity;
    return sortDir === 'asc' ? av - bv : bv - av;
  });
}

function updateStats() {
  const withNav = allFunds.filter(f => f.premium !== null);
  totalEl.textContent = allFunds.length;
  premiumEl.textContent = withNav.filter(f => f.premium > 0).length;
  discountEl.textContent = withNav.filter(f => f.premium < 0).length;

  const top = withNav.reduce((best, f) =>
    f.premium > (best?.premium ?? -Infinity) ? f : best, null);
  topEl.textContent = top
    ? `${top.name.slice(0, 6)} +${top.premium.toFixed(2)}%`
    : withNav.length === 0 ? '净值未加载' : '—';
}

// ─── Render ───────────────────────────────────────────────────────────────

function renderBuyStatus(status, limit) {
  if (!status) return '';
  if (status === '暂停申购') {
    return '<span style="font-size:10px;margin-left:6px;padding:2px 4px;border-radius:4px;color:#fff;background:var(--premium-high);font-weight:600;">暂停申购</span>';
  }

  if (status === '限制大额申购' && limit != null) {
    return `<span style="font-size:10px;margin-left:6px;padding:2px 4px;border-radius:4px;color:#000;background:var(--warning);font-weight:600;">限购 ${limit}</span>`;
  }

  return '<span style="font-size:10px;margin-left:6px;padding:2px 4px;border-radius:4px;color:#fff;background:var(--premium-low);font-weight:600;">无限制</span>';
}

function renderTable() {
  tableCountEl.textContent = `共 ${filteredFunds.length} 只`;

  if (filteredFunds.length === 0) {
    tableBody.innerHTML = `
      <tr><td colspan="9">
        <div class="state-overlay">
          <div class="state-icon">🔍</div>
          <div class="state-title">无匹配结果</div>
          <div class="state-desc">请调整搜索条件或筛选项</div>
        </div>
      </td></tr>`;
    return;
  }

  const rows = filteredFunds.map(f => {
    // 溢价率显示
    let premHtml;
    if (f.premium !== null) {
      const premCls = f.premium > 1 ? 'premium-high' : f.premium < -1 ? 'premium-low' : 'premium-mid';
      const premSign = f.premium > 0 ? '+' : '';
      premHtml = `<span class="premium-badge ${premCls}">${premSign}${f.premium.toFixed(3)}%</span>`;
    } else {
      premHtml = `<span class="premium-badge premium-mid" style="opacity:.45">净值未加载</span>`;
    }

    const chgColor = f.change > 0 ? 'var(--premium-high)' : f.change < 0 ? 'var(--premium-low)' : 'var(--text-secondary)';
    const chgSign = f.change > 0 ? '+' : '';
    const vol = formatVolume(f.volume);

    // Backend handles the freshness, we just allow manual updates.
    const btnLabel = '更新净值';
    const btnTip = f.updatedAt ? `最后数据库更新: ${new Date(f.updatedAt).toLocaleTimeString()}` : '请求后端更新';

    return `
    <tr data-code="${f.code}">
      <td class="code-cell">${f.code}</td>
      <td>
        <div class="name-cell" title="${f.name}" style="display:flex;align-items:center;">
          ${f.name}
          ${renderBuyStatus(f.buyStatus, f.buyLimit)}
          ${f.tractorAccounts > 1 ? `<span class="tractor-badge" style="font-size:10px;margin-left:6px;padding:2px 4px;border-radius:4px;color:#fff;background:var(--accent-blue);font-weight:600;" title="单日申购支持的最大子账户数量">一拖${f.tractorAccounts}</span>` : ''}
        </div>
      </td>
      <td class="price-cell">
        ${f.price.toFixed(3)}
        ${f.priceTime ? `<div class="time-sub">${f.priceTime}</div>` : ''}
      </td>
      <td class="nav-cell">
        ${f.nav ? f.nav.toFixed(4) : '<span style="opacity:.35">—</span>'}
        ${f.navTime ? `<div class="time-sub">${f.navTime}</div>` : ''}
      </td>
      <td>${premHtml}</td>
      <td class="change-cell" style="color:${chgColor}">${chgSign}${f.change.toFixed(2)}%</td>
      <td class="price-cell" style="font-size:12px;color:var(--text-secondary)">${f.high.toFixed(3)}</td>
      <td class="volume-cell">${vol}</td>
      <td style="text-align:center">
        <button class="btn-row-nav" data-code="${f.code}" title="${btnTip}">${btnLabel}</button>
      </td>
    </tr>`;
  });

  tableBody.innerHTML = rows.join('');
}

function showLoading() {
  tableBody.innerHTML = `
    <tr><td colspan="9">
      <div class="state-overlay">
        <div class="spinner"></div>
        <div class="state-title">正在加载数据…</div>
        <div class="state-desc">正在拉取同步数据</div>
      </div>
    </td></tr>`;
}

function showError(msg) {
  tableBody.innerHTML = `
    <tr><td colspan="9">
      <div class="state-overlay">
        <div class="state-icon">⚠️</div>
        <div class="state-title">数据加载失败</div>
        <div class="state-desc">${msg}</div>
      </div>
    </td></tr>`;
}

// ─── Sort ─────────────────────────────────────────────────────────────────

document.querySelectorAll('thead th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    sortDir = sortKey === key ? (sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
    sortKey = key;
    document.querySelectorAll('thead th').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
    th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    sortFunds();
    renderTable();
  });
});

// ─── Events ───────────────────────────────────────────────────────────────

searchInput.addEventListener('input', applyFilters);
filterSelect.addEventListener('change', applyFilters);
refreshBtn.addEventListener('click', () => { triggerSpotRefresh(); });
navFetchBtn.addEventListener('click', fetchNavManual);

// 行级更新按钮：通知后端去抓取最新净值
tableBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-row-nav');
  if (!btn) return;
  const code = btn.dataset.code;
  if (!code || btn.disabled) return;

  btn.disabled = true;
  btn.textContent = '请求后端…';

  try {
    await triggerBackendNavFetch(code);
    toast(`已提交 ${code} 的净值更新请求`, 'info');

    // 延迟 1.5s 后重新拉取全表数据以体现最新净值
    setTimeout(() => {
      loadData().then(() => {
        toast(`${code} 净值已同步至界面`, 'success');
      });
    }, 1500);

  } catch (error) {
    toast(`${code} 请求失败`, 'error');
    btn.disabled = false;
    btn.textContent = '更新失败';
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function safeNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

/** 将东方财富 f124 字段（Unix 秒）转为 HH:mm 字符串，非交易时段返回 '' */
function formatUnixSec(sec) {
  const n = parseInt(sec, 10);
  if (!n || n <= 0) return '';
  const d = new Date(n * 1000);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function formatVolume(v) {
  if (!v) return '—';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (v >= 1e4) return (v / 1e4).toFixed(2) + ' 万';
  return v.toFixed(0);
}

function setStatus(type, text) {
  statusDot.className = 'status-dot ' + type;
  statusText.textContent = text;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  el.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ─── Init ─────────────────────────────────────────────────────────────────

// 设置定时刷新页面数据 (每 15 秒同步一次后端，确保看见最新)
setInterval(() => {
  if (!document.hidden && !isLoading) {
    loadData();
  }
}, 15000);

loadData();
