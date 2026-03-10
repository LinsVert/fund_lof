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

// ─── API: 场内行情 ────────────────────────────────────────────────────────

async function fetchLOFSpot() {
  const PAGE_SIZE = 100;
  const BASE = `https://push2.eastmoney.com/api/qt/clist/get?pz=${PAGE_SIZE}&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f20&fs=b:MK0404,b:MK0405,b:MK0406,b:MK0407&fields=f1,f2,f3,f12,f14,f15,f16,f17,f18,f20,f62,f124,f152`;

  // 先取第1页，同时拿到 total
  console.log('[LOF] 正在请求第1页行情…');
  const first = await fetchPage(1);
  const total = first?.data?.total ?? 0;
  const firstItems = parseDiff(first);
  console.log(`[LOF] total=${total}，第1页 ${firstItems.length} 条`);

  // 计算剩余页数并并发拉取
  const totalPages = Math.ceil(total / PAGE_SIZE);
  let allItems = [...firstItems];

  if (totalPages > 1) {
    const pageNums = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    console.log(`[LOF] 并发请求剩余 ${pageNums.length} 页（共 ${totalPages} 页，total=${total}）`);
    const results = await Promise.all(pageNums.map(pn => fetchPage(pn)));
    results.forEach((data, idx) => {
      const items = parseDiff(data);
      console.log(`[LOF] 第 ${pageNums[idx]} 页 ${items.length} 条`);
      allItems = allItems.concat(items);
    });
  }

  // 去重（同一 code 只保留第一次出现）
  const seen = new Set();
  const deduped = allItems.filter(f => {
    if (seen.has(f.code)) return false;
    seen.add(f.code);
    return true;
  });

  console.log(`[LOF] 全量行情获取完成：去重后共 ${deduped.length} 只（含价格>0的有效基金）`);
  return deduped;

  async function fetchPage(pn) {
    const url = `${BASE}&pn=${pn}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`行情接口第${pn}页响应异常，状态码：${res.status}`);
    return res.json();
  }
}

function parseDiff(data) {
  const diff = data?.data?.diff;
  if (!diff || !Array.isArray(diff)) {
    console.warn('[LOF] diff 为空或格式异常', data);
    return [];
  }
  return diff.map(item => ({
    code: item.f12,
    name: item.f14,
    price: safeNum(item.f2),
    change: safeNum(item.f3),
    high: safeNum(item.f15),
    low: safeNum(item.f16),
    open: item.f17,
    preClose: safeNum(item.f18),
    volume: safeNum(item.f20),
    priceTime: formatUnixSec(item.f124), // 场内最新成交时间
  })).filter(f => f.code && f.price > 0);
}

// ─── API: 净值（带1小时缓存，单条请求）────────────────────────────────────

async function fetchNAVSingle(code) {
  const cached = navCache.get(code);
  if (cached && Date.now() - cached.ts < NAV_CACHE_TTL) {
    const ageMin = Math.round((Date.now() - cached.ts) / 60000);
    console.log(`[NAV] ${code} 命中缓存（${ageMin} 分钟前）nav=${cached.nav}`);
    return cached.nav;
  }

  // 来源1：天天基金 fundgz JSONP
  let result = await fetchNAVJsonp(code);

  // 来源2：若 fundgz 返回空，尝试东方财富 pingzhongdata
  if (!result?.nav) {
    console.log(`[NAV] ${code} fundgz 无有效净值，尝试 pingzhong…`);
    result = await fetchNAVPingzhong(code);
  }

  if (result?.nav) {
    navCache.set(code, { nav: result.nav, navTime: result.navTime || '', ts: Date.now() });
    console.log(`[NAV] ✅ ${code} nav=${result.nav} navTime=${result.navTime}`);
  } else {
    console.warn(`[NAV] ❌ ${code} 两个接口均未返回有效净值`);
  }
  return result?.nav ?? null;
}

/**
 * 来源 1：天天基金 fundgz JSONP
 * 天天基金接口返回格式： jsonpgz({fundcode, name, dwjz, gsz, ...})
 * 商品型/QDII 基金的 gsz 可能为 "0"，但 dwjz 应有前一日净值
 */
function fetchNAVJsonp(code) {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      cleanup();
      console.warn(`[NAV:fundgz] ${code} JSONP 超时`);
      resolve(null);
    }, 8000);

    function cleanup() {
      clearTimeout(timeout);
      script.remove();
      delete window.jsonpgz;
    }

    window.jsonpgz = (data) => {
      if (!data) {
        console.warn(`[NAV:fundgz] ${code} 返回空调用 jsonpgz()，无数据`);
        cleanup(); resolve(null); return;
      }
      const gsz = parseFloat(data.gsz);
      const dwjz = parseFloat(data.dwjz);
      const nav = gsz > 0 ? gsz : dwjz > 0 ? dwjz : 0;
      // 净值时间：优先用 gztime（估算时间），其次用 jzrq（净值日期）
      const navTime = (data.gztime || data.jzrq || '').trim();
      console.log(`[NAV:fundgz] ${code} gsz=${data.gsz} dwjz=${data.dwjz} gztime=${navTime} → nav=${nav || 'null'}`);
      cleanup();
      resolve(nav > 0 ? { nav, navTime } : null);
    };

    script.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    script.onerror = () => {
      console.warn(`[NAV:fundgz] ${code} 脚本加载失败（404 或网络）`);
      cleanup(); resolve(null);
    };
    document.head.appendChild(script);
  });
}

/**
 * 来源 2：东方财富 pingzhongdata（对商品/QDII LOF 覆盖更全）
 * 脚本加载后将 Data_netWorthTrend 写入全局，取最新一条的 .y 即净值
 */
function fetchNAVPingzhong(code) {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      console.warn(`[NAV:pingzhong] ${code} 超时`);
      cleanup(); resolve(null);
    }, 8000);

    function cleanup() {
      clearTimeout(timeout);
      script.remove();
      delete window.Data_netWorthTrend;
      delete window.fS_name;
      delete window.fS_code;
    }

    script.onload = () => {
      const trend = window.Data_netWorthTrend;
      console.log(`[NAV:pingzhong] ${code} Data_netWorthTrend 最新一条:`, trend?.slice(-1));
      if (trend && trend.length > 0) {
        const latest = trend[trend.length - 1];
        const nav = parseFloat(latest.y);
        // x 是 Unix 毫秒时间戳，转为 YYYY-MM-DD
        const navTime = latest.x ? new Date(latest.x).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-') : '';
        cleanup();
        resolve(nav > 0 ? { nav, navTime } : null);
      } else {
        console.warn(`[NAV:pingzhong] ${code} Data_netWorthTrend 为空或未定义`);
        cleanup(); resolve(null);
      }
    };

    script.onerror = () => {
      console.warn(`[NAV:pingzhong] ${code} 脚本加载失败`);
      cleanup(); resolve(null);
    };

    script.src = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
    document.head.appendChild(script);
  });
}

// ─── 核心：加载场内行情（不自动获取净值）────────────────────────────────

async function loadData() {
  if (isLoading) return;
  isLoading = true;
  setStatus('loading', '正在获取行情数据…');
  refreshBtn.disabled = true;
  showLoading();

  try {
    console.group('[LOF Monitor] 开始行情加载 —', new Date().toLocaleTimeString());
    const spots = await fetchLOFSpot();
    spotFunds = spots; // 全量保存，不做截断
    console.log(`[LOF Monitor] 获取全量 LOF 共 ${spots.length} 只`);

    mergeNavAndRender(); // 用缓存中已有的净值合并，无缓存则留空

    setStatus('live', `行情更新：${now()}`);
    toast('行情已更新', 'success');
    console.groupEnd();
  } catch (e) {
    console.error('[LOF Monitor] 行情加载异常：', e);
    console.groupEnd();
    setStatus('error', '获取行情失败');
    showError(e.message);
    toast(e.message, 'error');
  } finally {
    isLoading = false;
    refreshBtn.disabled = false;
  }
}

/**
 * 将 spotFunds 与 navCache 合并，重新计算溢价率，然后渲染
 * 场内行情刷新后 / 净值获取返回后 都调用此函数
 */
function mergeNavAndRender() {
  const now_ = Date.now();
  allFunds = spotFunds.map(f => {
    const cached = navCache.get(f.code);
    const fresh = cached && now_ - cached.ts < NAV_CACHE_TTL;
    const nav = fresh ? cached.nav : null;
    const navTime = fresh ? cached.navTime : null;
    const premium = (nav && f.price > 0) ? ((f.price - nav) / nav * 100) : null;
    return { ...f, nav, navTime, premium };
  });

  const withNav = allFunds.filter(f => f.nav !== null);
  console.log(`[LOF Monitor] 合并完成：总 ${allFunds.length} 只，含净值 ${withNav.length} 只`);

  updateStats();
  applyFilters();
  updateNavCacheInfo();
}

// ─── 手动获取净值（逐条，带延迟）────────────────────────────────────────

async function fetchNavManual() {
  if (navFetching) {
    // 点击"取消"
    navFetchAbort = true;
    return;
  }
  if (spotFunds.length === 0) {
    toast('请先获取 LOF 行情数据', 'info');
    return;
  }

  // 只获取缓存过期或没有缓存的
  const toFetch = spotFunds.filter(f => {
    const c = navCache.get(f.code);
    return !c || Date.now() - c.ts >= NAV_CACHE_TTL;
  });

  const cachedCount = spotFunds.length - toFetch.length;
  console.log(`[NAV] 手动获取：需请求 ${toFetch.length} 只，已缓存 ${cachedCount} 只`);

  if (toFetch.length === 0) {
    toast(`所有净值均在1小时内已缓存（${cachedCount} 只）`, 'info');
    return;
  }

  navFetching = true;
  navFetchAbort = false;
  updateNavFetchBtn(0, toFetch.length);

  let done = 0;
  for (const fund of toFetch) {
    if (navFetchAbort) {
      console.log('[NAV] 用户取消');
      toast('已取消净值获取', 'info');
      break;
    }
    await fetchNAVSingle(fund.code);
    done++;
    updateNavFetchBtn(done, toFetch.length);

    // 每获取5条更新一次渲染，减少 DOM 操作
    if (done % 5 === 0 || done === toFetch.length) {
      mergeNavAndRender();
    }

    if (done < toFetch.length) await sleep(NAV_REQUEST_DELAY);
  }

  if (!navFetchAbort) {
    console.log(`[NAV] 完成：共缓存 ${navCache.size} 条`);
    toast(`净值获取完成 ${done}/${toFetch.length}`, 'success');
    mergeNavAndRender();
  }

  navFetching = false;
  navFetchAbort = false;
  updateNavFetchBtn();
}

function updateNavFetchBtn(done, total) {
  if (!navFetchBtn) return;
  if (navFetching && done !== undefined) {
    navFetchBtn.textContent = `⏹ 取消 (${done}/${total})`;
    if (navFetchStatus) navFetchStatus.textContent = `正在获取净值 ${done}/${total}…`;
  } else {
    const cachedCount = navCache.size;
    const expiredCount = [...navCache.values()].filter(c => Date.now() - c.ts >= NAV_CACHE_TTL).length;
    const freshCount = cachedCount - expiredCount;
    navFetchBtn.textContent = '💹 获取净值';
    if (navFetchStatus) {
      navFetchStatus.textContent = cachedCount > 0
        ? `缓存 ${freshCount} 只（有效），${expiredCount} 只已过期`
        : '净值未加载，点击手动获取';
    }
  }
}

function updateNavCacheInfo() {
  updateNavFetchBtn(); // re-use the same status update
}

// ─── Filters / Sort ──────────────────────────────────────────────────────

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

    // 调试按钮：已缓存显示「↻ 刷新」，未缓存显示「查净值」
    const cached = navCache.get(f.code);
    const isFresh = cached && Date.now() - cached.ts < NAV_CACHE_TTL;
    const btnLabel = isFresh ? '↻ 刷新' : '查净值';
    const btnTip = isFresh
      ? `缓存 ${Math.round((Date.now() - cached.ts) / 60000)} 分钟前，点击强制刷新`
      : '点击单独获取该基金净值';

    return `
    <tr data-code="${f.code}">
      <td class="code-cell">${f.code}</td>
      <td><div class="name-cell" title="${f.name}">${f.name}</div></td>
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
        <div class="state-title">正在加载行情数据…</div>
        <div class="state-desc">正在从东方财富获取 LOF 场内行情</div>
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
refreshBtn.addEventListener('click', () => { clearInterval(refreshTimer); loadData(); });
navFetchBtn.addEventListener('click', fetchNavManual);

// 行级调试按钮：事件委托，点击「查净值 / ↻ 刷新」单独获取该行净值
tableBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-row-nav');
  if (!btn) return;
  const code = btn.dataset.code;
  if (!code || btn.disabled) return;

  btn.disabled = true;
  btn.textContent = '获取中…';
  console.group(`[NAV DEBUG] 单独获取 ${code}`);

  // 强制清除缓存，确保重新请求
  navCache.delete(code);
  const nav = await fetchNAVSingle(code);

  console.log(`[NAV DEBUG] ${code} 结果: nav=${nav}`);
  console.groupEnd();

  if (nav) {
    // 找到对应 spotFund 重新计算并局部刷新该行
    const spot = spotFunds.find(f => f.code === code);
    if (spot) {
      const premium = ((spot.price - nav) / nav * 100);
      console.log(`[NAV DEBUG] ${code} price=${spot.price} nav=${nav} premium=${premium.toFixed(3)}%`);
      toast(`${code} 净值 ${nav.toFixed(4)}，溢价率 ${premium > 0 ? '+' : ''}${premium.toFixed(3)}%`, 'success');
    }
    mergeNavAndRender(); // 整表更新
  } else {
    toast(`${code} 净值获取失败`, 'error');
    btn.disabled = false;
    btn.textContent = '查净值';
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
updateNavFetchBtn();
loadData();
