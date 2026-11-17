import {
  PREFECTURES, REGIONS, regionOf, BAG_SIZES, RICE_TYPES,
  BOXES, BOX_SIZES, DEFAULT_RATES,
} from './data.js';
import { Vault, eraseAll } from './vault.js';

// ---------- ユーティリティ ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const app = $('#app');
const vault = new Vault();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
const yen = (n) => '¥' + Math.round(n || 0).toLocaleString('ja-JP');
const yenJ = (n) => Math.round(n || 0).toLocaleString('ja-JP') + '円';
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtDate = (s) => (s ? s.replace(/^(\d+)-(\d+)-(\d+)$/, (_, y, m, d) => `${y}/${+m}/${+d}`) : '');
const fmtDateJ = (s) => (s ? s.replace(/^(\d+)-(\d+)-(\d+)$/, (_, y, m, d) => `${y}年${+m}月${+d}日`) : '');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const clone = (o) => JSON.parse(JSON.stringify(o));
const emptyItems = () => Object.fromEntries(RICE_TYPES.map((t) => [t.id, Object.fromEntries(BAG_SIZES.map((s) => [s, 0]))]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- データ ----------
let data = null;
let view = { name: 'orders' };
let listFilter = 'all';
let listSearch = '';

function defaultData() {
  return {
    version: 1,
    customers: [],
    orders: [],
    settings: {
      issuer: { name: '', postal: '', address: '', phone: '' },
      bankInfo: '',
      prices: Object.fromEntries(BAG_SIZES.map((s) => [s, 0])), // 設定画面で入力
      rates: clone(DEFAULT_RATES),
      autoLockMin: 5,
      receiptSeq: 0,
    },
  };
}

function migrate(d) {
  const def = defaultData();
  d.customers ||= [];
  d.orders ||= [];
  d.settings = { ...def.settings, ...(d.settings || {}) };
  d.settings.issuer = { ...def.settings.issuer, ...d.settings.issuer };
  d.settings.prices = { ...def.settings.prices, ...d.settings.prices };
  delete d.settings.boxSize;
  for (const r of REGIONS) d.settings.rates[r.id] = { ...def.settings.rates[r.id], ...(d.settings.rates[r.id] || {}) };
  // 以前に保存した郵便番号・電話番号にもハイフンを付ける
  for (const o of [d.settings.issuer, ...d.customers]) {
    if (o.postal) o.postal = formatPostal(o.postal);
    if (o.phone) o.phone = formatPhone(o.phone);
  }
  return d;
}

let saveChain = Promise.resolve();
function persist() {
  const snapshot = clone(data);
  saveChain = saveChain
    .then(() => vault.save(snapshot))
    .catch((e) => { console.error(e); toast('保存に失敗しました: ' + e.message); });
  return saveChain;
}

const customerById = (id) => data.customers.find((c) => c.id === id);
const orderById = (id) => data.orders.find((o) => o.id === id);

// ---------- 計算 ----------
function bagsBySize(items) {
  const r = Object.fromEntries(BAG_SIZES.map((s) => [s, 0]));
  for (const t of RICE_TYPES) for (const s of BAG_SIZES) r[s] += num(items?.[t.id]?.[s]);
  return r;
}
const totalBags = (items) => Object.values(bagsBySize(items)).reduce((a, b) => a + b, 0);

function riceAmount(items, prices) {
  let sum = 0;
  for (const t of RICE_TYPES) for (const s of BAG_SIZES) sum += num(items?.[t.id]?.[s]) * num(prices[s]);
  return sum;
}

// 送料計算。combine=true なら袋をまとめて詰め、送料が一番安くなる箱の組み合わせを求めます
// （箱ごとの重さ上限：80=5kg・100=10kg・140=20kg・160=30kg）。false なら1袋＝1個口。
function shippingDetail(items, pref, combine = true) {
  const region = regionOf(pref);
  if (!region) return null;
  const rates = data.settings.rates[region.id];
  const boxes = BOXES.filter((b) => num(rates[b.size]) > 0).map((b) => ({ ...b, rate: num(rates[b.size]) }));
  // 中身の重さに対して一番安い箱
  const boxFor = (kg) => boxes.filter((b) => b.kg >= kg).sort((x, y) => x.rate - y.rate)[0] || null;
  const bags = bagsBySize(items);
  const counts = BAG_SIZES.map((s) => bags[s]);
  const maxKg = Math.max(0, ...boxes.map((b) => b.kg));

  // 1箱に入れられる中身の候補（各サイズの袋数の組）
  const contents = [];
  if (combine) {
    const rec = (i, cur, kg) => {
      if (i === BAG_SIZES.length) { if (kg > 0) contents.push({ cur: [...cur], kg }); return; }
      for (let n = 0; kg + n * BAG_SIZES[i] <= maxKg; n++) { cur[i] = n; rec(i + 1, cur, kg + n * BAG_SIZES[i]); }
      cur[i] = 0;
    };
    rec(0, BAG_SIZES.map(() => 0), 0);
  } else {
    BAG_SIZES.forEach((s, i) => { const cur = BAG_SIZES.map(() => 0); cur[i] = 1; contents.push({ cur, kg: s }); });
  }
  for (const c of contents) c.box = boxFor(c.kg);
  const usable = contents.filter((c) => c.box);

  // 残りの袋数 → 最安の詰め方（メモ化）
  const memo = new Map();
  const solve = (left) => {
    if (left.every((n) => n === 0)) return { cost: 0, picks: [] };
    const key = left.join(',');
    if (memo.has(key)) return memo.get(key);
    // 先頭の残っている袋を必ず含む中身だけを試す（重複探索を避ける）
    const first = left.findIndex((n) => n > 0);
    let best = { cost: Infinity, picks: [] };
    for (const c of usable) {
      if (!c.cur[first] || c.cur.some((n, i) => n > left[i])) continue;
      const sub = solve(left.map((n, i) => n - c.cur[i]));
      if (sub.cost + c.box.rate < best.cost) best = { cost: sub.cost + c.box.rate, picks: [c, ...sub.picks] };
    }
    memo.set(key, best);
    return best;
  };
  const result = solve(counts);
  if (!Number.isFinite(result.cost)) return { region, lines: [], total: 0, error: '入る箱がありません（送料表を確認してください）' };

  // 同じ箱・同じ中身をまとめて表示用に
  const grouped = new Map();
  for (const c of result.picks) {
    const desc = c.cur.map((n, i) => (n ? `${BAG_SIZES[i]}kg×${n}` : '')).filter(Boolean).join('＋');
    const key = c.box.size + '|' + desc;
    const g = grouped.get(key) || { box: c.box.size, desc, kg: c.kg, rate: c.box.rate, count: 0 };
    g.count++;
    grouped.set(key, g);
  }
  const lines = [...grouped.values()].map((g) => ({ ...g, amount: g.rate * g.count }));
  return { region, lines, total: result.cost };
}

function itemLines(items, prices) {
  const lines = [];
  for (const t of RICE_TYPES) for (const s of BAG_SIZES) {
    const c = num(items?.[t.id]?.[s]);
    if (c) lines.push({ type: t.name, size: s, count: c, price: num(prices[s]), amount: c * num(prices[s]) });
  }
  return lines;
}
const itemsSummary = (items) => itemLines(items, data.settings.prices).map((l) => `${l.type}${l.size}kg×${l.count}`).join('・');
const orderTotal = (o) => num(o.riceAmount) + num(o.shippingFee);

function shipStatus(o) {
  if (o.shipDate && o.shipDate <= today()) return { key: 'shipped', label: '発送済み' };
  if (o.notifiedDate) return { key: 'preparing', label: '出荷準備中' };
  return { key: 'new', label: '総額未連絡' };
}
const payStatus = (o) => (o.paidDate ? { key: 'paid', label: '入金済み' } : { key: 'unpaid', label: '入金待ち' });

// ---------- 画面切り替え ----------
function go(name, params = {}) {
  view = { name, ...params };
  render();
  window.scrollTo(0, 0);
}

function render() {
  if (!data) return renderLock();
  document.body.classList.toggle('receipt-mode', view.name === 'receipt');
  const titles = { orders: '受注一覧', order: view.id ? '受注の編集' : '新規受注', customers: '発注者', customer: '発注者の編集', settings: '設定', receipt: '領収書' };
  const main = {
    orders: renderOrders, order: renderOrderForm, customers: renderCustomers,
    customer: renderCustomerForm, settings: renderSettings, receipt: renderReceipt,
  }[view.name]();
  const tab = { orders: 'orders', order: view.id ? 'orders' : 'new', customers: 'customers', customer: 'customers', settings: 'settings', receipt: 'orders' }[view.name];
  app.innerHTML = `
    <header class="topbar no-print">
      <h1>${esc(titles[view.name])}</h1>
      <button class="lock-btn" data-action="lock">🔒 ロック</button>
    </header>
    <main class="content">${main}</main>
    <nav class="tabbar no-print">
      ${[['orders', '📋', '受注一覧'], ['new', '＋', '新規受注'], ['customers', '👤', '発注者'], ['settings', '⚙️', '設定']]
        .map(([k, i, l]) => `<button class="${tab === k ? 'active' : ''}" data-action="tab" data-tab="${k}"><span class="ti">${i}</span><span>${l}</span></button>`).join('')}
    </nav>`;
  afterRender();
}

// ---------- ロック画面 ----------
let lockMode = null; // 'setup' | 'unlock'
let failCount = 0;

// iPhoneのパスワード保存（キーチェーン）が正しく働くよう、ユーザー名欄つきのフォームにしています
const KEYCHAIN_USER = 'お米受注管理';
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
// 全角で入力されても同じパスコードとして扱う（例：１２３ → 123）
const normPass = (s) => s.normalize('NFKC');

async function renderLock() {
  document.body.classList.remove('receipt-mode');
  lockMode = (await Vault.exists()) ? 'unlock' : 'setup';
  const safariNote = isIOS && !isStandalone ? `
    <p class="warn box">いまSafariの中で開いています。<b>ホーム画面に追加したアイコンから開いてください。</b><br>
    Safariとホーム画面のアプリでは、データ（とパスコード）が別々に保存されます。</p>` : '';
  app.innerHTML = `
    <div class="lock">
      <form class="lock-card" id="lock-form" autocomplete="on" action="#">
        <div class="logo">🌾</div>
        <h1>お米受注管理</h1>
        ${safariNote}
        <input class="vh" type="text" name="username" autocomplete="username" value="${KEYCHAIN_USER}" readonly tabindex="-1" aria-hidden="true">
        ${lockMode === 'setup' ? `
          <p class="muted">はじめにパスコードを決めてください。データはこのiPhoneの中だけに、このパスコードで暗号化して保存されます。</p>
          <p class="warn">パスコードを忘れるとデータは復元できません。iPhoneに保存する場合も、紙などに控えておくと安心です。</p>
          <input id="pc1" name="new-password" type="password" autocomplete="new-password" placeholder="パスコード（6文字以上）">
          <input id="pc2" name="confirm-password" type="password" autocomplete="new-password" placeholder="もう一度入力">
        ` : `
          <p class="muted">パスコードを入力してください</p>
          <input id="pc1" name="password" type="password" autocomplete="current-password" placeholder="パスコード">
        `}
        <label class="check show-pass"><input type="checkbox" id="show-pass"> パスコードを表示</label>
        <button class="btn primary block" type="submit" id="lock-submit">${lockMode === 'setup' ? 'はじめる' : 'ロック解除'}</button>
        ${lockMode === 'unlock' ? '<button class="link" type="button" data-action="forgot">パスコードを忘れた場合</button>' : ''}
        <p id="lock-msg" class="error"></p>
      </form>
    </div>`;
  $('#lock-form').addEventListener('submit', (e) => { e.preventDefault(); lockMode === 'setup' ? doSetup() : doUnlock(); });
  $('#show-pass').addEventListener('change', (e) => { $$('#pc1, #pc2').forEach((i) => { i.type = e.target.checked ? 'text' : 'password'; }); });
  if (!isIOS) $('#pc1')?.focus();
}

async function doSetup() {
  const a = normPass($('#pc1').value), b = normPass($('#pc2').value);
  if (a.length < 6) return ($('#lock-msg').textContent = '6文字以上にしてください');
  if (a !== b) return ($('#lock-msg').textContent = '2回の入力が一致しません');
  $('#lock-msg').textContent = '準備中…';
  data = defaultData();
  await vault.create(a, data);
  requestPersistence();
  go('settings');
  toast('まずお米の価格と発行者情報を入力してください');
}

async function doUnlock() {
  const msg = $('#lock-msg');
  const btn = $('#lock-submit');
  const raw = $('#pc1').value;
  if (!raw) return (msg.textContent = 'パスコードを入力してください');
  btn.disabled = true;
  msg.textContent = '確認中…';
  // 以前のバージョンで全角のまま作ったデータも開けるよう、半角化したものと入力そのものの両方を試す
  const candidates = [...new Set([normPass(raw), raw])];
  for (const pass of candidates) {
    try {
      data = migrate(await vault.unlock(pass));
      failCount = 0;
      requestPersistence();
      lastActive = Date.now();
      return go('orders');
    } catch { /* 次の候補へ */ }
  }
  failCount++;
  const wait = failCount >= 3 ? Math.min(30, 2 ** (failCount - 2)) : 0;
  msg.innerHTML = `パスコードが違います（入力された文字数：${raw.length}文字）` + (wait ? `<br>${wait}秒お待ちください` : '') +
    '<br><small>「パスコードを表示」にチェックすると、入っている文字を確認できます。</small>';
  setTimeout(() => { btn.disabled = false; }, wait * 1000);
}

async function lockNow() {
  if (!data) return;
  await saveChain;
  vault.lock();
  data = null;
  view = { name: 'orders' };
  render();
}

function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}

// 自動ロック
let lastActive = Date.now();
['pointerdown', 'keydown', 'input'].forEach((ev) => document.addEventListener(ev, () => { lastActive = Date.now(); }, true));
function checkAutoLock() {
  if (!data) return;
  const min = num(data.settings.autoLockMin);
  if (min > 0 && Date.now() - lastActive > min * 60000) lockNow();
}
setInterval(checkAutoLock, 15000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkAutoLock();
  else lastActive = Math.min(lastActive, Date.now());
});

// ---------- 受注一覧 ----------
const FILTERS = [
  ['all', 'すべて'], ['new', '総額未連絡'], ['preparing', '出荷準備中'], ['shipped', '発送済み'],
  ['unpaid', '入金待ち'], ['paid', '入金済み'],
];

function matchesFilter(o) {
  if (listFilter === 'all') return true;
  if (listFilter === 'unpaid' || listFilter === 'paid') return payStatus(o).key === listFilter;
  return shipStatus(o).key === listFilter;
}

function renderOrders() {
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, 0]));
  for (const o of data.orders) { counts.all++; counts[shipStatus(o).key]++; counts[payStatus(o).key]++; }
  const unpaidAmount = data.orders.filter((o) => !o.paidDate).reduce((a, o) => a + orderTotal(o), 0);
  return `
    <section class="summary">
      <div><span class="label">入金待ち</span><strong>${counts.unpaid}件</strong><span class="sub">${yen(unpaidAmount)}</span></div>
      <div><span class="label">出荷準備中</span><strong>${counts.preparing}件</strong></div>
      <div><span class="label">総額未連絡</span><strong>${counts.new}件</strong></div>
    </section>
    <input class="search" type="search" placeholder="名前・住所・電話で検索" value="${esc(listSearch)}" data-input="search">
    <div class="chips">
      ${FILTERS.map(([k, l]) => `<button class="chip ${listFilter === k ? 'active' : ''}" data-action="filter" data-filter="${k}">${l} <span>${counts[k]}</span></button>`).join('')}
    </div>
    <div id="order-list">${renderOrderList()}</div>
  `;
}

function renderOrderList() {
  const q = listSearch.trim();
  const list = data.orders
    .filter(matchesFilter)
    .filter((o) => {
      if (!q) return true;
      const c = customerById(o.customerId) || {};
      return [c.name, c.prefecture, c.address, c.phone, o.note].some((v) => (v || '').includes(q));
    })
    .sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || '') || (b.createdAt || 0) - (a.createdAt || 0));
  if (list.length) return list.map(orderCard).join('');
  return `<div class="empty">${data.orders.length ? '該当する受注はありません' : 'まだ受注がありません。<br>下の「＋新規受注」から登録してください。'}</div>`;
}

function orderCard(o) {
  const c = customerById(o.customerId) || { name: '（削除された発注者）' };
  const ss = shipStatus(o), ps = payStatus(o);
  const shipNote = o.shipDate && o.shipDate > today() ? `発送予定 ${fmtDate(o.shipDate)}` : o.shipDate ? `発送 ${fmtDate(o.shipDate)}` : '';
  return `
    <button class="card order-card" data-action="open-order" data-id="${o.id}">
      <div class="row1"><span class="name">${esc(c.name)} 様</span><span class="amount">${yen(orderTotal(o))}</span></div>
      <div class="row2">${esc(c.prefecture || '')}　受注 ${fmtDate(o.orderDate)}${shipNote ? '　' + shipNote : ''}</div>
      <div class="row3">${esc(itemsSummary(o.items))}</div>
      <div class="badges"><span class="badge s-${ss.key}">${ss.label}</span><span class="badge s-${ps.key}">${ps.label}</span></div>
    </button>`;
}

// ---------- 受注フォーム ----------
function newDraft(id) {
  if (id) {
    const o = clone(orderById(id));
    const c = customerById(o.customerId) || {};
    return { ...o, custMode: c.id ? c.id : '__new', cust: { name: c.name || '', prefecture: c.prefecture || '', postal: c.postal || '', address: c.address || '', phone: c.phone || '' } };
  }
  return {
    id: null, orderDate: today(), notifiedDate: '', shipDate: '', paidDate: '',
    items: emptyItems(), prices: { ...data.settings.prices }, shippingAuto: true, combine: true, shippingFee: 0, note: '',
    custMode: data.customers.length ? '' : '__new',
    cust: { name: '', prefecture: '', postal: '', address: '', phone: '' },
  };
}

// ---------- 郵便番号・電話番号 ----------
function postalField(attr, value) {
  return `
    <label>郵便番号<small>7桁を入れると住所が自動で入ります</small>
      <div class="with-key">
        <input ${attr} data-postal value="${esc(value)}" inputmode="numeric" autocomplete="off" placeholder="例：860-0000">
        <button type="button" class="key" data-key="-" aria-label="ハイフン">－</button>
      </div>
    </label>
    <div class="postal-msg hint"></div>`;
}

function phoneField(attr, value) {
  return `
    <label>電話番号
      <div class="with-key">
        <input ${attr} data-phone value="${esc(value)}" type="tel" autocomplete="off" placeholder="例：090-1234-5678">
        <button type="button" class="key" data-key="-" aria-label="ハイフン">－</button>
      </div>
    </label>`;
}

// 全角→半角、いろいろな横棒→「-」
const normDigits = (v) => v.normalize('NFKC').replace(/[‐－―ー−–—]/g, '-');

function formatPostal(v) {
  const t = normDigits(v);
  const digits = t.replace(/\D/g, '');
  if (digits.length === 7 && !t.includes('-')) return digits.slice(0, 3) + '-' + digits.slice(3);
  return t;
}

// 携帯・IP電話・フリーダイヤルなど、区切り方が決まっている番号だけ自動でハイフンを入れる
// （固定電話は市外局番の長さが地域で違うため、「－」キーで入れてください）
function formatPhone(v) {
  const t = normDigits(v);
  if (t.includes('-')) return t;
  const d = t.replace(/\D/g, '');
  if (/^0[5789]0\d{8}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (/^(0120|0800)\d{6}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  if (/^0570\d{6}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
  return t;
}

// 郵便番号データ（日本郵便のデータ）を上3桁ごとのファイルで、アプリと同じ場所から読み込みます
const zipCache = new Map();
async function lookupPostal(code) {
  const prefix = code.slice(0, 3);
  if (!zipCache.has(prefix)) {
    zipCache.set(prefix, fetch(`zip/${prefix}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => null));
  }
  const table = await zipCache.get(prefix);
  if (table === null) { zipCache.delete(prefix); throw new Error('offline'); }
  const hit = table[code];
  if (!hit) return null;
  const [prefNo, city, town, extra = ''] = hit;
  return { prefecture: PREFECTURES[prefNo - 1], address: city + town + extra };
}

async function onPostalInput(el) {
  const code = normDigits(el.value).replace(/\D/g, '');
  const box = el.closest('label').nextElementSibling;
  const msg = box?.classList.contains('postal-msg') ? box : null;
  if (msg) msg.innerHTML = '';
  if (code.length !== 7) return;
  let hit;
  try { hit = await lookupPostal(code); } catch {
    if (msg) msg.textContent = '圏外のため住所を検索できませんでした。住所は手で入力してください。';
    return;
  }
  if (normDigits(el.value).replace(/\D/g, '') !== code) return; // 検索中に書き換えられた
  if (!hit) { if (msg) msg.textContent = 'この郵便番号は見つかりませんでした。'; return; }

  const form = el.closest('.panel');
  const prefSel = form.querySelector('[data-cust="prefecture"], [data-c="prefecture"]');
  const addr = form.querySelector('[data-cust="address"], [data-c="address"], [data-s="issuer.address"]');
  // 発行者の住所欄には都道府県の欄がないので、住所の先頭に都道府県を付ける
  const text = prefSel ? hit.address : hit.prefecture + hit.address;
  if (prefSel && prefSel.value !== hit.prefecture) {
    prefSel.value = hit.prefecture;
    prefSel.dispatchEvent(new Event('input', { bubbles: true }));
    prefSel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (!addr) return;
  const current = addr.value.trim();
  const fill = () => {
    addr.value = text;
    addr.dispatchEvent(new Event('input', { bubbles: true }));
    addr.dispatchEvent(new Event('change', { bubbles: true }));
    if (msg) msg.textContent = '住所を入れました。続けて番地・建物名を入力してください。';
  };
  if (!current || text.startsWith(current) || current === text) return fill();
  if (current.startsWith(text)) return; // すでに番地まで入っている
  if (msg) {
    msg.innerHTML = `<button type="button" class="btn small" data-action="postal-fill">住所を「${esc(text)}」に置き換える</button>`;
    msg.querySelector('button').onclick = fill;
  }
}

function prefOptions(selected) {
  return `<option value="">選択してください</option>` + PREFECTURES.map((p) => `<option ${p === selected ? 'selected' : ''}>${p}</option>`).join('');
}

function renderOrderForm() {
  if (!view.draft) view.draft = newDraft(view.id);
  const d = view.draft;
  const sorted = [...data.customers].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const showFields = d.custMode !== '';
  const unpriced = BAG_SIZES.filter((s) => !num(d.prices[s]));
  return `
    ${unpriced.length ? `<section class="panel notice"><p class="warn">お米の価格（${unpriced.map((s) => s + 'kg').join('・')}）が未設定です。</p><button class="btn small" data-action="tab" data-tab="settings">設定で価格を入力</button></section>` : ''}
    <section class="panel">
      <h2>発注者</h2>
      ${data.customers.length ? `
        <label>発注者名
          <select data-input="custMode">
            <option value="" ${d.custMode === '' ? 'selected' : ''}>選択してください</option>
            ${sorted.map((c) => `<option value="${c.id}" ${d.custMode === c.id ? 'selected' : ''}>${esc(c.name)}（${esc(c.prefecture || '県未設定')}）</option>`).join('')}
            <option value="__new" ${d.custMode === '__new' ? 'selected' : ''}>＋ 新しい発注者を入力</option>
          </select>
        </label>` : ''}
      ${d.custMode === '__new' ? `<label>発注者名（新規）<input data-cust="name" value="${esc(d.cust.name)}" placeholder="例：山田 太郎" autocomplete="off"></label>` : ''}
      ${showFields ? `
        ${postalField('data-cust="postal"', d.cust.postal)}
        <label>都道府県<select data-cust="prefecture">${prefOptions(d.cust.prefecture)}</select></label>
        <label>ご住所<textarea data-cust="address" rows="2" placeholder="市区町村・番地・建物名">${esc(d.cust.address)}</textarea></label>
        ${phoneField('data-cust="phone"', d.cust.phone)}
        ${d.custMode !== '__new' ? '<p class="hint">ここで変えた住所・連絡先は発注者情報にも反映されます。</p>' : ''}
      ` : ''}
    </section>

    <section class="panel">
      <h2>ご注文内容</h2>
      <table class="items">
        <thead><tr><th></th>${RICE_TYPES.map((t) => `<th>${t.name}</th>`).join('')}</tr></thead>
        <tbody>
          ${BAG_SIZES.map((s) => `
            <tr>
              <th>${s}kg<small>${num(d.prices[s]) ? yenJ(d.prices[s]) : '価格未設定'}</small></th>
              ${RICE_TYPES.map((t) => `
                <td><div class="stepper">
                  <button data-action="step" data-type="${t.id}" data-size="${s}" data-delta="-1" aria-label="減らす">−</button>
                  <input data-item="${t.id}:${s}" value="${num(d.items[t.id][s])}" inputmode="numeric">
                  <button data-action="step" data-type="${t.id}" data-size="${s}" data-delta="1" aria-label="増やす">＋</button>
                </div></td>`).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
    </section>

    <section class="panel">
      <h2>料金</h2>
      <div id="totals"></div>
      <label class="check"><input type="checkbox" data-input="shippingAuto" ${d.shippingAuto ? 'checked' : ''}> 送料を自動計算（佐川急便・熊本発）</label>
      ${d.shippingAuto ? `<label class="check"><input type="checkbox" data-input="combine" ${d.combine !== false ? 'checked' : ''}> 袋をまとめて梱包する（一番安い箱の組み合わせ）</label>` : ''}
      ${d.shippingAuto ? '' : `<label>送料（手入力）<input data-input="shippingFee" value="${num(d.shippingFee)}" inputmode="numeric"></label>`}
    </section>

    <section class="panel">
      <h2>日付・ステータス</h2>
      <div class="status-line" id="status-line"></div>
      ${dateField('orderDate', '受注日')}
      ${dateField('notifiedDate', '総額連絡日', '先方に総額をお知らせした日 → 出荷準備中')}
      ${dateField('shipDate', '発送日', '発送日を過ぎると → 発送済み')}
      ${dateField('paidDate', '入金確認日', '入力すると → 入金済み（それまでは入金待ち）')}
    </section>

    <section class="panel">
      <h2>メモ</h2>
      <textarea data-input="note" rows="2" placeholder="配達希望日時など">${esc(d.note)}</textarea>
    </section>

    <div class="actions">
      <button class="btn primary block" data-action="save-order">保存する</button>
      <button class="btn block" data-action="notify">💬 総額を連絡する（メッセージ作成）</button>
      ${d.id ? `<button class="btn block" data-action="receipt">🧾 領収書を発行</button>` : ''}
      ${d.id ? `<button class="btn danger block" data-action="delete-order">この受注を削除</button>` : ''}
    </div>`;
}

function dateField(key, label, hint = '') {
  const v = view.draft[key] || '';
  return `
    <div class="date-field">
      <label>${label}${hint ? `<small>${hint}</small>` : ''}</label>
      <div class="date-row">
        <input type="date" data-input="${key}" value="${esc(v)}">
        <button class="btn small" data-action="date-today" data-key="${key}">今日</button>
        ${v ? `<button class="btn small ghost" data-action="date-clear" data-key="${key}" aria-label="消去">✕</button>` : ''}
      </div>
    </div>`;
}

function computeDraft() {
  const d = view.draft;
  d.riceAmount = riceAmount(d.items, d.prices);
  const detail = shippingDetail(d.items, d.cust.prefecture, d.combine !== false);
  if (d.shippingAuto) d.shippingFee = detail ? detail.total : 0;
  return detail;
}

function updateTotals() {
  const d = view.draft;
  const detail = computeDraft();
  const el = $('#totals');
  if (el) {
    const lines = itemLines(d.items, d.prices);
    el.innerHTML = `
      ${lines.length ? lines.map((l) => `<div class="tl"><span>${l.type} ${l.size}kg × ${l.count}袋</span><span>${yenJ(l.amount)}</span></div>`).join('') : '<div class="tl muted"><span>袋数を選んでください</span></div>'}
      <div class="tl sum"><span>お米代金</span><span>${yenJ(d.riceAmount)}</span></div>
      ${d.shippingAuto ? shippingLinesHtml(detail, d.cust.prefecture) : ''}
      <div class="tl sum"><span>送料</span><span>${yenJ(d.shippingFee)}</span></div>
      <div class="tl grand"><span>合計</span><span>${yenJ(d.riceAmount + num(d.shippingFee))}</span></div>`;
  }
  const sl = $('#status-line');
  if (sl) {
    const ss = shipStatus(d), ps = payStatus(d);
    sl.innerHTML = `<span class="badge s-${ss.key}">${ss.label}</span><span class="badge s-${ps.key}">${ps.label}</span>`;
  }
}

function shippingLinesHtml(detail, pref) {
  if (!pref) return '<div class="tl sub warn"><span>都道府県を選ぶと送料を計算します</span></div>';
  if (!detail) return `<div class="tl sub warn"><span>${esc(pref)}は送料の自動計算の対象外です。下のチェックを外して送料を手入力してください</span></div>`;
  if (detail.error) return `<div class="tl sub warn"><span>${detail.error}</span></div>`;
  return detail.lines.map((l) => `<div class="tl sub"><span>送料 ${detail.region.name}・${l.box}サイズ（${l.desc}）${yenJ(l.rate)} × ${l.count}個</span><span>${yenJ(l.amount)}</span></div>`).join('');
}

function validateDraft() {
  const d = view.draft;
  if (d.custMode === '') return '発注者を選んでください';
  if (d.custMode === '__new' && !d.cust.name.trim()) return '発注者名を入力してください';
  if (!d.cust.prefecture) return '都道府県を選んでください';
  if (!totalBags(d.items)) return '袋数を1つ以上入力してください';
  if (!d.orderDate) return '受注日を入力してください';
  const noPrice = BAG_SIZES.find((s) => !num(d.prices[s]) && RICE_TYPES.some((t) => num(d.items[t.id][s])));
  if (noPrice) return `${noPrice}kgの価格が未設定です。設定で入力してください`;
  if (d.shippingAuto) {
    const detail = shippingDetail(d.items, d.cust.prefecture, d.combine !== false);
    if (!detail || detail.error) return '送料を自動計算できません。送料を手入力してください';
  }
  return null;
}

async function saveDraft({ silent = false } = {}) {
  const err = validateDraft();
  if (err) { toast(err); return false; }
  const d = view.draft;
  computeDraft();
  let customer;
  if (d.custMode === '__new') {
    const name = d.cust.name.trim();
    customer = data.customers.find((c) => c.name === name);
    if (customer && !confirm(`「${name}」さんは登録済みです。同じ方として登録しますか？`)) return false;
    if (!customer) { customer = { id: uid(), createdAt: Date.now() }; data.customers.push(customer); }
    Object.assign(customer, { ...d.cust, name });
  } else {
    customer = customerById(d.custMode);
    Object.assign(customer, { prefecture: d.cust.prefecture, postal: d.cust.postal, address: d.cust.address, phone: d.cust.phone });
  }
  const { custMode, cust, ...fields } = d;
  const order = { ...fields, customerId: customer.id, updatedAt: Date.now() };
  if (!order.id) { order.id = uid(); order.createdAt = Date.now(); data.orders.push(order); }
  else Object.assign(orderById(order.id), order);
  await persist();
  view.draft = newDraft(order.id);
  view.id = order.id;
  if (!silent) toast('保存しました');
  return true;
}

function notifyText() {
  const d = view.draft;
  computeDraft();
  const st = data.settings;
  const lines = itemLines(d.items, d.prices);
  const name = d.custMode === '__new' ? d.cust.name.trim() : (customerById(d.custMode)?.name || '');
  return [
    `${name} 様`,
    '',
    'このたびはお米のご注文をいただき、誠にありがとうございます。',
    'ご注文内容と合計金額をお知らせいたします。',
    '',
    ...lines.map((l) => `・${l.type} ${l.size}kg × ${l.count}袋　${yenJ(l.amount)}`),
    `・送料（佐川急便）　${yenJ(d.shippingFee)}`,
    '',
    `合計金額：${yenJ(d.riceAmount + num(d.shippingFee))}`,
    ...(st.bankInfo.trim() ? ['', '【お振込先】', st.bankInfo.trim()] : []),
    '',
    '準備ができ次第、発送いたします。どうぞよろしくお願いいたします。',
    ...(st.issuer.name ? ['', st.issuer.name] : []),
  ].join('\n');
}

async function doNotify() {
  const err = validateDraft();
  if (err) return toast(err);
  const text = notifyText(); // 共有シートはタップ直後に開く必要があるため保存より先に
  let shared = false;
  try {
    if (navigator.share) { await navigator.share({ text }); shared = true; }
    else { await navigator.clipboard.writeText(text); toast('メッセージをコピーしました'); shared = true; }
  } catch (e) {
    if (e.name === 'AbortError') return;
    try { await navigator.clipboard.writeText(text); toast('メッセージをコピーしました'); shared = true; } catch { alert(text); shared = true; }
  }
  if (shared && !view.draft.notifiedDate && confirm('総額連絡日を今日にして「出荷準備中」にしますか？')) {
    view.draft.notifiedDate = today();
  }
  if (await saveDraft({ silent: true })) render();
}

// ---------- 領収書 ----------
function receiptDefaults(o) {
  const c = customerById(o.customerId) || {};
  const lines = itemLines(o.items, o.prices);
  const detail = lines.map((l) => `${l.type}${l.size}kg×${l.count}袋`).join('、');
  return {
    to: c.name || '',
    date: o.paidDate || today(),
    note: `お米代として（${detail}${num(o.shippingFee) ? '、送料込み' : ''}）`,
  };
}

function renderReceipt() {
  const o = orderById(view.id);
  if (!o) return '<div class="empty">受注が見つかりません</div>';
  if (!view.r) view.r = { ...receiptDefaults(o), ...(o.receipt || {}) };
  const r = view.r;
  const st = data.settings;
  const lines = itemLines(o.items, o.prices);
  const iss = st.issuer;
  return `
    <section class="panel no-print">
      <p class="hint">内容を確認・修正して「印刷 / PDF保存」を押してください。印刷画面で2本指で拡大するとPDFとして共有・保存できます。</p>
      <label>宛名<input data-r="to" value="${esc(r.to)}"></label>
      <label>発行日<input type="date" data-r="date" value="${esc(r.date)}"></label>
      <label>但し書き<textarea data-r="note" rows="2">${esc(r.note)}</textarea></label>
      ${!iss.name ? '<p class="warn">発行者情報が未入力です。「設定」から入力してください。</p>' : ''}
      ${!o.paidDate ? '<p class="warn">この受注はまだ入金確認日が入力されていません。</p>' : ''}
      <div class="actions">
        <button class="btn primary block" data-action="print">🖨 印刷 / PDF保存</button>
        <button class="btn block" data-action="back-order">受注に戻る</button>
      </div>
    </section>
    <div class="receipt-sheet">
      <div class="rc-head">
        <h1>領　収　書</h1>
        <div class="rc-meta">No. ${esc(o.receiptNo || '（発行時に採番）')}<br>${esc(fmtDateJ(r.date))}</div>
      </div>
      <div class="rc-to"><span>${esc(r.to)}</span> 様</div>
      <div class="rc-amount"><span>金額</span><strong>${esc(yen(orderTotal(o)))}-</strong></div>
      <div class="rc-note">但し　${esc(r.note)}</div>
      <p class="rc-received">上記の金額、正に領収いたしました。</p>
      <table class="rc-detail">
        <thead><tr><th>品目</th><th>数量</th><th>単価</th><th>金額</th></tr></thead>
        <tbody>
          ${lines.map((l) => `<tr><td>${l.type} ${l.size}kg</td><td>${l.count}袋</td><td>${yenJ(l.price)}</td><td>${yenJ(l.amount)}</td></tr>`).join('')}
          ${num(o.shippingFee) ? `<tr><td>送料（佐川急便）</td><td></td><td></td><td>${yenJ(o.shippingFee)}</td></tr>` : ''}
        </tbody>
        <tfoot><tr><th colspan="3">合計</th><th>${yenJ(orderTotal(o))}</th></tr></tfoot>
      </table>
      <div class="rc-issuer">
        <div class="name">${esc(iss.name)}</div>
        ${iss.postal ? `<div>〒${esc(iss.postal)}</div>` : ''}
        <div>${esc(iss.address).replace(/\n/g, '<br>')}</div>
        ${iss.phone ? `<div>TEL ${esc(iss.phone)}</div>` : ''}
      </div>
    </div>`;
}

async function doPrint() {
  const o = orderById(view.id);
  if (!o.receiptNo) {
    data.settings.receiptSeq = num(data.settings.receiptSeq) + 1;
    o.receiptNo = `${view.r.date.slice(0, 4)}-${String(data.settings.receiptSeq).padStart(4, '0')}`;
  }
  o.receipt = { ...view.r };
  await persist();
  render();
  setTimeout(() => window.print(), 50);
}

// ---------- 発注者 ----------
function renderCustomers() {
  const sorted = [...data.customers].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return `
    <button class="btn primary block" data-action="new-customer">＋ 発注者を追加</button>
    ${sorted.length ? sorted.map((c) => {
      const orders = data.orders.filter((o) => o.customerId === c.id);
      return `
        <button class="card" data-action="open-customer" data-id="${c.id}">
          <div class="row1"><span class="name">${esc(c.name)} 様</span><span class="muted">${orders.length}件</span></div>
          <div class="row2">${esc(c.prefecture || '県未設定')} ${esc(c.address || '')}</div>
          ${c.phone ? `<div class="row3">☎ ${esc(c.phone)}</div>` : ''}
        </button>`;
    }).join('') : '<div class="empty">発注者はまだいません。<br>最初の受注で入力した方が自動で登録されます。</div>'}`;
}

function renderCustomerForm() {
  if (!view.draft) view.draft = clone(customerById(view.id) || { id: null, name: '', prefecture: '', postal: '', address: '', phone: '' });
  const c = view.draft;
  const orders = c.id ? data.orders.filter((o) => o.customerId === c.id).sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || '')) : [];
  return `
    <section class="panel">
      <label>発注者名<input data-c="name" value="${esc(c.name)}"></label>
      ${postalField('data-c="postal"', c.postal)}
      <label>都道府県<select data-c="prefecture">${prefOptions(c.prefecture)}</select></label>
      <label>ご住所<textarea data-c="address" rows="2">${esc(c.address)}</textarea></label>
      ${phoneField('data-c="phone"', c.phone)}
      ${c.phone ? `<a class="btn block" href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">☎ 電話をかける</a>` : ''}
    </section>
    <div class="actions">
      <button class="btn primary block" data-action="save-customer">保存する</button>
      ${c.id ? `<button class="btn block" data-action="order-for" data-id="${c.id}">＋ この方の受注を登録</button>` : ''}
      ${c.id && !orders.length ? '<button class="btn danger block" data-action="delete-customer">この発注者を削除</button>' : ''}
    </div>
    ${orders.length ? `<h2 class="section-title">受注履歴</h2>${orders.map(orderCard).join('')}` : ''}`;
}

// ---------- 設定 ----------
function renderSettings() {
  const st = data.settings;
  return `
    <section class="panel">
      <h2>発行者情報（領収書に記載）</h2>
      <label>発行者名<input data-s="issuer.name" value="${esc(st.issuer.name)}" placeholder="例：〇〇農園 山田太郎"></label>
      ${postalField('data-s="issuer.postal"', st.issuer.postal)}
      <label>住所<textarea data-s="issuer.address" rows="2">${esc(st.issuer.address)}</textarea></label>
      ${phoneField('data-s="issuer.phone"', st.issuer.phone)}
    </section>

    <section class="panel">
      <h2>お振込先（総額連絡メッセージに記載）</h2>
      <textarea data-s="bankInfo" rows="3" placeholder="例：〇〇銀行 〇〇支店 普通 1234567 ヤマダタロウ">${esc(st.bankInfo)}</textarea>
    </section>

    <section class="panel">
      <h2>お米の価格（1袋）</h2>
      ${BAG_SIZES.map((s) => `<label class="inline">${s}kg<input data-s="prices.${s}" data-num value="${num(st.prices[s]) || ''}" placeholder="未設定" inputmode="numeric"><span>円</span></label>`).join('')}
      <p class="hint">価格を変えても、登録済みの受注の金額は変わりません。</p>
    </section>

    <section class="panel">
      <h2>送料（佐川急便 飛脚宅配便・熊本県発）</h2>
      <p class="hint">箱の重さの上限は ${BOXES.map((b) => `${b.size}サイズ＝${b.kg}kg`).join('・')}。受注ごとに「まとめて梱包」を選ぶと、送料が一番安くなる箱の組み合わせを自動で選びます（例：5kg＋10kg＝15kg → 140サイズ1個）。</p>
      <div class="rate-table-wrap">
        <table class="rate-table">
          <thead><tr><th>届け先</th>${BOXES.map((b) => `<th>${b.size}<small>${b.kg}kg</small></th>`).join('')}</tr></thead>
          <tbody>
            ${REGIONS.map((r) => `<tr><th title="${r.prefs.join('・')}">${r.name}</th>${BOX_SIZES.map((b) => `<td><input data-s="rates.${r.id}.${b}" data-num value="${num(st.rates[r.id][b])}" inputmode="numeric"></td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="hint">税込・通常配達の参考運賃です。佐川急便の運賃改定があればここで修正してください。沖縄県は自動計算の対象外です（受注ごとに手入力）。</p>
      <button class="btn small" data-action="reset-rates">送料表を初期値に戻す</button>
    </section>

    <section class="panel">
      <h2>セキュリティ</h2>
      <label class="inline">自動ロック<select data-s="autoLockMin" data-num>
        ${[[1, '1分'], [5, '5分'], [15, '15分'], [60, '60分'], [0, 'しない']].map(([v, l]) => `<option value="${v}" ${num(st.autoLockMin) === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
      <button class="btn block" data-action="change-pass">パスコードを変更</button>
      <p class="hint">データはこのiPhone内だけに AES-256 で暗号化して保存され、外部には送信されません。</p>
    </section>

    <section class="panel">
      <h2>バックアップ</h2>
      <p class="hint">機種変更や万一に備えて、ときどき書き出してください（ファイルも暗号化されています。読み込みには書き出し時のパスコードが必要です）。</p>
      <button class="btn block" data-action="export">バックアップを書き出す</button>
      <button class="btn block" data-action="import">バックアップから復元</button>
      <input type="file" id="import-file" accept=".json,application/json" hidden>
    </section>

    <section class="panel">
      <button class="btn danger block" data-action="erase">すべてのデータを消去</button>
    </section>`;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let o = obj;
  for (const k of keys) o = o[k];
  o[last] = value;
}

async function doExport() {
  await saveChain;
  const text = await vault.exportBackup(data);
  const name = `rice-orders-backup-${today()}.json`;
  const file = new File([text], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function doImport(file) {
  const text = await file.text();
  const pass = prompt('バックアップを書き出した時のパスコードを入力してください');
  if (pass == null) return;
  let imported;
  try { imported = migrate(await Vault.decryptBackup(text, pass)); }
  catch (e) { return alert('復元できませんでした（パスコードが違うか、ファイルが壊れています）'); }
  if (!confirm(`受注${imported.orders.length}件・発注者${imported.customers.length}名を復元します。現在のデータは置き換えられます。よろしいですか？`)) return;
  data = imported;
  await persist();
  toast('復元しました');
  go('orders');
}

async function doChangePass() {
  const cur = prompt('現在のパスコード');
  if (cur == null) return;
  let ok = false;
  for (const c of new Set([normPass(cur), cur])) { try { await new Vault().unlock(c); ok = true; break; } catch { /* 次へ */ } }
  if (!ok) return alert('現在のパスコードが違います');
  const a0 = prompt('新しいパスコード（6文字以上）');
  if (a0 == null) return;
  const a = normPass(a0);
  if (a.length < 6) return alert('6文字以上にしてください');
  if (normPass(prompt('新しいパスコードをもう一度') || '') !== a) return alert('一致しません');
  await saveChain;
  await vault.changePasscode(a, data);
  toast('パスコードを変更しました');
}

async function doErase() {
  if (!confirm('すべての受注・発注者・設定を消去します。元に戻せません。よろしいですか？')) return;
  if (prompt('確認のため「消去」と入力してください') !== '消去') return;
  await saveChain;
  await eraseAll();
  vault.lock();
  data = null;
  render();
}

// ---------- イベント ----------
function afterRender() {
  if (view.name === 'order') updateTotals();
}

app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const d = view.draft;
  switch (a) {
    case 'forgot':
      if (confirm('パスコードが分からない場合、データを消去して最初からやり直すしかありません。\nバックアップがあれば、やり直した後に「設定 → バックアップから復元」で戻せます（書き出し時のパスコードが必要）。\n\n消去しますか？')) {
        if (prompt('確認のため「消去」と入力してください') === '消去') { await eraseAll(); render(); }
      }
      return;
    case 'lock': return lockNow();
    case 'tab': {
      const t = el.dataset.tab;
      return t === 'new' ? go('order', { id: null }) : go(t);
    }
    case 'filter': listFilter = el.dataset.filter; return render();
    case 'open-order': return go('order', { id: el.dataset.id });
    case 'step': {
      const { type, size, delta } = el.dataset;
      d.items[type][size] = Math.max(0, num(d.items[type][size]) + num(delta));
      $(`[data-item="${type}:${size}"]`).value = d.items[type][size];
      return updateTotals();
    }
    case 'date-today': d[el.dataset.key] = today(); return render();
    case 'date-clear': d[el.dataset.key] = ''; return render();
    case 'save-order': if (await saveDraft()) render(); return;
    case 'notify': return doNotify();
    case 'receipt':
      if (await saveDraft({ silent: true })) go('receipt', { id: view.id });
      return;
    case 'delete-order':
      if (confirm('この受注を削除しますか？')) {
        data.orders = data.orders.filter((o) => o.id !== d.id);
        await persist(); toast('削除しました'); go('orders');
      }
      return;
    case 'print': return doPrint();
    case 'back-order': return go('order', { id: view.id });
    case 'new-customer': return go('customer', { id: null });
    case 'open-customer': return go('customer', { id: el.dataset.id });
    case 'order-for': {
      go('order', { id: null });
      const c = customerById(el.dataset.id);
      Object.assign(view.draft, { custMode: c.id, cust: { name: c.name, prefecture: c.prefecture || '', postal: c.postal || '', address: c.address || '', phone: c.phone || '' } });
      return render();
    }
    case 'save-customer': {
      if (!d.name.trim()) return toast('発注者名を入力してください');
      d.name = d.name.trim();
      if (data.customers.some((c) => c.name === d.name && c.id !== d.id) && !confirm('同じ名前の発注者がいます。保存しますか？')) return;
      if (d.id) Object.assign(customerById(d.id), d);
      else { d.id = uid(); d.createdAt = Date.now(); data.customers.push(clone(d)); }
      await persist(); toast('保存しました'); return go('customers');
    }
    case 'delete-customer':
      if (confirm('この発注者を削除しますか？')) {
        data.customers = data.customers.filter((c) => c.id !== d.id);
        await persist(); toast('削除しました'); go('customers');
      }
      return;
    case 'reset-rates':
      if (confirm('送料表を初期値に戻しますか？')) {
        data.settings.rates = clone(DEFAULT_RATES);
        await persist(); render(); toast('初期値に戻しました');
      }
      return;
    case 'change-pass': return doChangePass();
    case 'export': return doExport();
    case 'import': return $('#import-file').click();
    case 'erase': return doErase();
  }
});

app.addEventListener('input', (e) => {
  const el = e.target;
  const d = view.draft;
  if ('postal' in el.dataset || 'phone' in el.dataset) {
    const f = 'postal' in el.dataset ? formatPostal(el.value) : formatPhone(el.value);
    if (f !== el.value) el.value = f;
    if ('postal' in el.dataset) onPostalInput(el);
  }
  if (el.dataset.input === 'search') {
    listSearch = el.value;
    $('#order-list').innerHTML = renderOrderList();
    return;
  }
  if (el.dataset.cust) { d.cust[el.dataset.cust] = el.value; return updateTotals(); }
  if (el.dataset.item) {
    const [type, size] = el.dataset.item.split(':');
    d.items[type][size] = Math.max(0, num(el.value));
    return updateTotals();
  }
  if (el.dataset.input === 'note') { d.note = el.value; return; }
  if (el.dataset.input === 'shippingFee') { d.shippingFee = num(el.value); return updateTotals(); }
  if (el.dataset.c) { d[el.dataset.c] = el.value; return; }
  if (el.dataset.r) { view.r[el.dataset.r] = el.value; return; }
});

// 入力済みの郵便番号の欄をタップしたときも住所を調べる（空なら入れる・違えば置き換えボタンを出す）
app.addEventListener('focusin', (e) => {
  if ('postal' in (e.target.dataset || {})) onPostalInput(e.target);
});

// 「－」キー：キーボードを閉じずにカーソル位置へハイフンを入れる
app.addEventListener('pointerdown', (e) => {
  const key = e.target.closest('.key');
  if (!key) return;
  e.preventDefault();
  const input = key.previousElementSibling;
  input.focus();
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + key.dataset.key + input.value.slice(end);
  try { input.setSelectionRange(start + 1, start + 1); } catch { /* type=tel でも通常は可 */ }
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

app.addEventListener('change', async (e) => {
  const el = e.target;
  const d = view.draft;
  if (el.id === 'import-file') { if (el.files[0]) await doImport(el.files[0]); el.value = ''; return; }
  if (el.dataset.input === 'custMode') {
    d.custMode = el.value;
    const c = customerById(el.value);
    d.cust = c ? { name: c.name, prefecture: c.prefecture || '', postal: c.postal || '', address: c.address || '', phone: c.phone || '' }
      : { name: '', prefecture: '', postal: '', address: '', phone: '' };
    return render();
  }
  if (el.dataset.input === 'shippingAuto') { d.shippingAuto = el.checked; return render(); }
  if (el.dataset.input === 'combine') { d.combine = el.checked; return updateTotals(); }
  if (['orderDate', 'notifiedDate', 'shipDate', 'paidDate'].includes(el.dataset.input)) { d[el.dataset.input] = el.value; return render(); }
  if (el.dataset.r) { view.r[el.dataset.r] = el.value; return render(); }
  if (el.dataset.s) {
    setPath(data.settings, el.dataset.s, 'num' in el.dataset ? num(el.value) : el.value);
    await persist();
    toast('保存しました');
  }
});

// ---------- 起動 ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
render();
