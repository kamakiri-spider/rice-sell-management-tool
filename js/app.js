import {
  PREFECTURES, REGIONS, regionOf, BAG_SIZES, RICE_TYPES,
  BOXES, BOX_SIZES, DEFAULT_RATES,
} from './data.js';
import { Vault, eraseAll } from './vault.js';

// アプリの版。更新のたびに sw.js の CACHE と一緒に上げます
const APP_VERSION = '29';

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

// 総額連絡メッセージのあいさつ文（設定で書き換え可。「元の文に戻す」でこれに戻る）
// 領収書の明細表の下に入れるひと言（設定で書き換え可。「元の文に戻す」でこれに戻る）
const DEFAULT_THANKS = '応援ありがとうございます！🙇‍♂️';
const DEFAULT_GREETING = 'このたびは私の米づくりを応援いただき、誠にありがとうございます。\nご注文内容と合計金額をお知らせいたします。';
// 以前の標準文のままなら、新しい標準文に置き換える（自分で書き換えた文はそのまま）
const OLD_DEFAULT_GREETINGS = ['このたびは私たちの米づくりを応援いただき、誠にありがとうございます。\nご注文内容と合計金額をお知らせいたします。'];

function defaultData() {
  return {
    version: 1,
    customers: [],
    orders: [],
    settings: {
      issuer: { name: '', postal: '', address: '', phone: '' },
      bankInfo: '', // 旧：1つの欄（移行用に残す）
      payPayInfo: '',
      bankTransferInfo: '',
      defaultPayment: 'paypay', // 初めての方の支払い方法
      paymentSplitNotice: false,
      receiptPhoto: null, // { dataUrl, updatedAt } 領収書に入れる写真（端末内に暗号化して保存）
      receiptPhotoLayout: 'background', // 'background'＝全体にうすく / 'band'＝上部に帯
      receiptPhotoOpacity: 18, // 背景のときの濃さ（%）
      producerPhoto: null, // { original, cropped, crop: { sx, sy, z }, updatedAt } 発行者名の横に入れる生産者写真
      producerPhotoShape: 'circle', // 'circle'＝丸 / 'square'＝四角
      reportStart: '', // 入金集計の開始日（空ならその年の1月1日）
      receiptThanks: DEFAULT_THANKS,
      receiptPaper: 'a4', // 'a4'＝A4用紙にA5の大きさ（切り取り線） / 'a5'＝A5用紙
      greeting: DEFAULT_GREETING,
      prices: Object.fromEntries(BAG_SIZES.map((s) => [s, 0])), // 設定画面で入力
      rates: clone(DEFAULT_RATES),
      autoLockMin: 5,
      receiptSeq: 0,
    },
  };
}

// 以前の「お振込先」1つの欄の内容を、PayPay と銀行振込に振り分ける
function splitPaymentInfo(text) {
  const t = (text || '').trim();
  if (!t) return { paypay: '', bank: '' };
  const isBankLine = (l) => /銀行|ゆうちょ|信金|信用金庫|農協|ＪＡ|JA|支店|口座|普通|当座/.test(l);
  const hasPayPay = /paypay|ペイペイ/i.test(t);
  const lines = t.split('\n');
  const hasBank = lines.some(isBankLine);
  if (hasPayPay && !hasBank) return { paypay: t, bank: '' };
  if (!hasPayPay) return { paypay: '', bank: t };
  // 両方ある：PayPay の部分と銀行の部分の始まりで分ける（直前の【見出し】もその部分に含める）
  const isPayPayLine = (l) => /paypay|ペイペイ/i.test(l);
  const isHeader = (l) => /^\s*[【\[■◆●]/.test(l);
  const startOf = (pred) => { let i = lines.findIndex(pred); if (i > 0 && isHeader(lines[i - 1]) && !pred(lines[i - 1])) i -= 1; return i; };
  const pi = startOf(isPayPayLine), bi = startOf(isBankLine);
  const part = (from, to) => lines.slice(from, to).join('\n').trim();
  return pi < bi
    ? { paypay: part(0, bi), bank: part(bi) }
    : { bank: part(0, pi), paypay: part(pi) };
}

function migrate(d) {
  const def = defaultData();
  d.customers ||= [];
  d.orders ||= [];
  d.settings = { ...def.settings, ...(d.settings || {}) };
  d.settings.issuer = { ...def.settings.issuer, ...d.settings.issuer };
  d.settings.prices = { ...def.settings.prices, ...d.settings.prices };
  delete d.settings.boxSize;
  if (d.settings.bankInfo && !d.settings.payPayInfo && !d.settings.bankTransferInfo) {
    const sp = splitPaymentInfo(d.settings.bankInfo);
    d.settings.payPayInfo = sp.paypay;
    d.settings.bankTransferInfo = sp.bank;
    d.settings.bankInfo = '';
    d.settings.paymentSplitNotice = true;
  }
  if (OLD_DEFAULT_GREETINGS.includes(d.settings.greeting)) d.settings.greeting = DEFAULT_GREETING;
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

// 支払い方法：'paypay' / 'bank' / 'both'（受注ごと。未設定なら設定の標準）
const PAYMENTS = [['paypay', 'PayPay'], ['bank', '銀行振込'], ['both', '両方']];
const paymentOf = (o) => o.payment || data.settings.defaultPayment || 'paypay';

// 受け渡し方法：'ship'＝佐川急便で配送、'hand'＝手渡し（送料なし・住所不要）
const isHand = (o) => o.delivery === 'hand';

// 作業の段階：総額未連絡 → 未梱包（総額を連絡済み）→ 発送待ち（梱包済み）→ 発送済み
function shipStatus(o) {
  if (o.shipDate && o.shipDate <= today()) return { key: 'shipped', label: isHand(o) ? 'お渡し済み' : '発送済み' };
  if (o.packedDate) return { key: 'packed', label: isHand(o) ? 'お渡し待ち' : '発送待ち' };
  if (o.notifiedDate) return { key: 'unpacked', label: '未梱包' };
  return { key: 'new', label: '総額未連絡' };
}

// 次の作業（ボタンに出す）。なければ null
function nextStep(o) {
  const st = shipStatus(o).key;
  if (st === 'shipped') return null;
  if (!o.packedDate) return { action: 'pack', label: '📦 梱包済みにする' };
  return { action: 'ship', label: isHand(o) ? '🤝 お渡し済みにする' : '🚚 発送済みにする' };
}
const payStatus = (o) => (o.paidDate ? { key: 'paid', label: '入金済み' } : { key: 'unpaid', label: '入金待ち' });

// ---------- 画面切り替え ----------
function go(name, params = {}) {
  if (data) flushSettingsSave();
  view = { name, ...params };
  render();
  window.scrollTo(0, 0);
}

function render() {
  if (!data) return renderLock();
  document.body.classList.toggle('receipt-mode', view.name === 'receipt');
  const titles = { orders: '受注一覧', order: view.id ? '受注の編集' : '新規受注', customers: '発注者', customer: '発注者の編集', settings: '設定', receipt: '領収書', notify: '総額連絡の確認', report: '入金の集計' };
  const main = {
    orders: renderOrders, order: renderOrderForm, customers: renderCustomers,
    customer: renderCustomerForm, settings: renderSettings, receipt: renderReceipt, notify: renderNotify, report: renderReport,
  }[view.name]();
  const tab = { orders: 'orders', order: view.id ? 'orders' : 'new', customers: 'customers', customer: 'customers', settings: 'settings', receipt: 'orders', notify: 'orders', report: 'orders' }[view.name];
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

// 設定の欄は入力のたびに少し待ってから保存（iPhoneのSafariでは、ハイフンを自動で入れた欄で
// 「入力完了」の合図が来ないことがあるため、それに頼らず保存する）
let settingsTimer = null;
function scheduleSettingsSave() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => { settingsTimer = null; persist(); }, 500);
}
async function flushSettingsSave() {
  if (!settingsTimer) return saveChain;
  clearTimeout(settingsTimer); settingsTimer = null;
  return persist();
}

async function lockNow() {
  if (!data) return;
  await flushSettingsSave();
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
  else { lastActive = Math.min(lastActive, Date.now()); if (data) flushSettingsSave(); } // アプリを閉じる前に保存
});

// ---------- 受注一覧 ----------
const FILTERS = [
  ['all', 'すべて'], ['new', '総額未連絡'], ['unpacked', '未梱包'], ['packed', '発送・お渡し待ち'], ['shipped', '発送・お渡し済み'],
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
      <div><span class="label">未梱包</span><strong>${counts.unpacked}件</strong></div>
      <div><span class="label">発送待ち</span><strong>${counts.packed}件</strong></div>
    </section>
    ${renderPaidCard()}
    ${renderPreparingRice(counts.new)}
    <input class="search" type="search" placeholder="名前・住所・電話で検索" value="${esc(listSearch)}" data-input="search">
    <div class="chips">
      ${FILTERS.map(([k, l]) => `<button class="chip ${listFilter === k ? 'active' : ''}" data-action="filter" data-filter="${k}">${l} <span>${counts[k]}</span></button>`).join('')}
    </div>
    <div id="order-list">${renderOrderList()}</div>
  `;
}

// ---------- 入金の集計 ----------
// 入金確認日が期間内（開始日〜終了日、両端を含む）の受注を「確定した入金」として集計
const reportStart = () => data.settings.reportStart || `${today().slice(0, 4)}-01-01`;
const paidInRange = (from, to) => data.orders.filter((o) => o.paidDate && o.paidDate >= from && o.paidDate <= to);
const payLabel = (o) => (isHand(o) ? '現金・手渡し' : { paypay: 'PayPay', bank: '銀行振込', both: 'PayPayか銀行振込' }[paymentOf(o)]);

function renderPaidCard() {
  const from = reportStart(), to = today();
  const paid = paidInRange(from, to);
  const total = paid.reduce((a, o) => a + orderTotal(o), 0);
  const outside = data.orders.filter((o) => o.paidDate).length - paid.length;
  return `
    <button class="card paid-card" data-action="open-report">
      <div class="pc-label">確定した入金 <span>${fmtDate(from)}〜今日</span></div>
      <div class="pc-row"><strong>${yen(total)}</strong><span>${paid.length}件 ›</span></div>
      ${outside ? `<div class="pc-note">入金済みのうち${outside}件は期間外のため含みません</div>` : ''}
    </button>`;
}

function renderReport() {
  if (!view.to) view.to = today();
  return `
    <section class="panel">
      <h2>集計期間（入金確認日）</h2>
      <div class="period">
        <div><span class="muted">開始</span><strong>${fmtDateJ(reportStart())}</strong>
          <button class="link" data-action="tab" data-tab="settings">設定で変更</button></div>
        <label>終了<div class="date-row"><input type="date" data-input="reportTo" value="${esc(view.to)}">
          <button class="btn small" data-action="report-today">今日</button></div></label>
      </div>
    </section>
    <div id="report-body">${renderReportBody()}</div>`;
}

function updateReport() {
  const body = $('#report-body');
  if (body) body.innerHTML = renderReportBody();
}

function renderReportBody() {
  const from = reportStart(), to = view.to;
  const paid = paidInRange(from, to).sort((a, b) => b.paidDate.localeCompare(a.paidDate));
  const sum = (f) => paid.reduce((a, o) => a + f(o), 0);
  const total = sum(orderTotal), rice = sum((o) => num(o.riceAmount)), ship = sum((o) => num(o.shippingFee));
  const byPay = new Map();
  for (const o of paid) { const k = payLabel(o); const v = byPay.get(k) || { n: 0, amount: 0 }; v.n++; v.amount += orderTotal(o); byPay.set(k, v); }
  const kg = RICE_TYPES.map((t) => ({ name: t.name, kg: sum((o) => BAG_SIZES.reduce((a, sz) => a + sz * num(o.items?.[t.id]?.[sz]), 0)) }));
  const unpaid = data.orders.filter((o) => !o.paidDate);
  const allPaid = data.orders.filter((o) => o.paidDate);
  const before = allPaid.filter((o) => o.paidDate < from).length, after = allPaid.filter((o) => o.paidDate > to).length;
  const notes = [
    from > to ? '<p class="warn">終了日が開始日より前になっています。</p>' : '',
    before ? `<p class="warn">入金済みのうち ${before}件は、入金確認日が開始日（${fmtDateJ(from)}）より前のため含まれていません。開始日は「設定 → 入金の集計」で変えられます。</p>` : '',
    after ? `<p class="hint">入金済みのうち ${after}件は、入金確認日が終了日より後のため含まれていません。</p>` : '',
  ].join('');
  return `
    ${notes}
    <section class="panel">
      <div class="report-total"><span>確定した入金</span><strong>${yenJ(total)}</strong><span class="muted">${paid.length}件</span></div>
      <div class="tl"><span>お米代金</span><span>${yenJ(rice)}</span></div>
      <div class="tl"><span>送料</span><span>${yenJ(ship)}</span></div>
      <h2 class="sub-h">支払い方法別</h2>
      ${byPay.size ? [...byPay].map(([k, v]) => `<div class="tl"><span>${esc(k)}（${v.n}件）</span><span>${yenJ(v.amount)}</span></div>`).join('') : '<p class="muted">この期間の入金はありません</p>'}
      <h2 class="sub-h">お米の量</h2>
      ${kg.map((k) => `<div class="tl"><span>${k.name}</span><span>${k.kg.toLocaleString('ja-JP')}kg</span></div>`).join('')}
      ${unpaid.length ? `<p class="hint">参考：入金待ちが ${unpaid.length}件・${yenJ(unpaid.reduce((a, o) => a + orderTotal(o), 0))} あります（集計には含みません）。</p>` : ''}
    </section>

    ${paid.length ? `<h2 class="section-title">入金の明細</h2>
    <div class="panel report-list">
      ${paid.map((o) => {
        const c = customerById(o.customerId) || { name: '（削除された発注者）' };
        return `<button class="rl-row" data-action="open-order" data-id="${o.id}">
          <span class="rl-date">${fmtDate(o.paidDate)}</span>
          <span class="rl-name">${esc(c.name)} 様<small>${esc(payLabel(o))}</small></span>
          <span class="rl-amount">${yenJ(orderTotal(o))}</span></button>`;
      }).join('')}
    </div>` : ''}`;
}

// その受注で使う箱（佐川のサイズ → 5/10/20/30kg の箱）。送料の計算と同じ詰め方。手渡しは箱なしで null
// 都道府県が未定のときは熊本県の運賃で詰め方を決める（箱の選び方はどの地域でもほぼ同じ）
const boxKg = (size) => BOXES.find((b) => b.size === size)?.kg;
function boxesOf(o) {
  if (isHand(o)) return null;
  const c = customerById(o.customerId) || {};
  const detail = shippingDetail(o.items, regionOf(c.prefecture) ? c.prefecture : '熊本県', o.combine !== false);
  if (!detail || detail.error) return null;
  return detail.lines.map((l) => ({ kg: boxKg(l.box), count: l.count, desc: l.desc }));
}
const boxesText = (list) => list.map((b) => `${b.kg}kg箱×${b.count}`).join('・');

// 未梱包（総額を連絡済みで、まだ梱包していない）の受注に入っているお米の量を、精米・玄米ごとに集計
function renderPreparingRice(unnotifiedCount) {
  const orders = data.orders.filter((o) => shipStatus(o).key === 'unpacked');
  if (!orders.length) return '';
  const rows = RICE_TYPES.map((t) => {
    const bags = BAG_SIZES.map((sz) => [sz, orders.reduce((a, o) => a + num(o.items?.[t.id]?.[sz]), 0)]);
    const kg = bags.reduce((a, [sz, n]) => a + sz * n, 0);
    const detail = bags.filter(([, n]) => n).map(([sz, n]) => `${sz}kg×${n}袋`).join('・');
    return { name: t.name, kg, detail };
  });
  const totalKg = rows.reduce((a, r) => a + r.kg, 0);
  const boxCount = new Map();
  let handN = 0;
  for (const o of orders) {
    const list = boxesOf(o);
    if (!list) { if (isHand(o)) handN++; continue; }
    for (const b of list) boxCount.set(b.kg, (boxCount.get(b.kg) || 0) + b.count);
  }
  const boxes = [...boxCount].sort((a, b) => a[0] - b[0]).map(([kg, n]) => ({ kg, count: n }));
  const boxTotal = boxes.reduce((a, b) => a + b.count, 0);
  return `
    <button class="card rice-stock" data-action="filter" data-filter="unpacked">
      <div class="rs-head"><span>梱包するお米（未梱包 ${orders.length}件）</span><strong>合計 ${totalKg.toLocaleString('ja-JP')}kg</strong></div>
      ${rows.map((r) => `
        <div class="rs-row">
          <span class="rs-type">${r.name}</span>
          <span class="rs-kg">${r.kg.toLocaleString('ja-JP')}kg</span>
          <span class="rs-detail">${r.detail || '—'}</span>
        </div>`).join('')}
      ${boxTotal ? `<div class="rs-row rs-boxes"><span class="rs-type">未購入の箱</span><span class="rs-kg">${boxTotal}個</span><span class="rs-detail">${boxesText(boxes)}</span></div>` : ''}
      ${handN ? `<div class="rs-note">手渡しの${handN}件は箱なしで数えています</div>` : ''}
      ${unnotifiedCount ? `<div class="rs-note">総額未連絡の${unnotifiedCount}件は含みません</div>` : ''}
    </button>`;
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
  const verb = isHand(o) ? 'お渡し' : '発送';
  const shipNote = o.shipDate && o.shipDate > today() ? `${verb}予定 ${fmtDate(o.shipDate)}` : o.shipDate ? `${verb} ${fmtDate(o.shipDate)}` : '';
  const step = nextStep(o);
  return `
    <div class="card order-card">
    <button class="card-main" data-action="open-order" data-id="${o.id}">
      <div class="row1"><span class="name">${esc(c.name)} 様</span><span class="amount">${yen(orderTotal(o))}${o.shippingPending ? '<small>＋送料</small>' : ''}</span></div>
      <div class="row2">${[c.prefecture, `受注 ${fmtDate(o.orderDate)}`, shipNote].filter(Boolean).map(esc).join('　')}</div>
      <div class="row3">${esc(itemsSummary(o.items))}</div>
      ${ss.key === 'unpacked' && boxesOf(o) ? `<div class="row-box">📦 ${esc(boxesOf(o).map((b) => `${b.kg}kg箱×${b.count}（${b.desc}）`).join('・'))}</div>` : ''}
      <div class="badges"><span class="badge s-${ss.key}">${ss.label}</span><span class="badge s-${ps.key}">${ps.label}</span>${isHand(o) ? '<span class="badge s-hand">手渡し</span>' : !addressReady(c) ? '<span class="badge s-noaddr">住所未登録</span>' : ''}${!o.notifiedDate && ss.key === 'packed' ? '<span class="badge s-new">総額未連絡</span>' : ''}</div>
    </button>
    ${step ? `<div class="card-actions"><button class="btn small step-btn step-${step.action}" data-action="quick-step" data-id="${o.id}">${step.label}</button></div>` : ''}
    </div>`;
}

// ---------- 受注フォーム ----------
function newDraft(id) {
  if (id) {
    const o = clone(orderById(id));
    const c = customerById(o.customerId) || {};
    return { ...o, custMode: c.id ? c.id : '__new', cust: { name: c.name || '', prefecture: c.prefecture || '', postal: c.postal || '', address: c.address || '', phone: c.phone || '' } };
  }
  return {
    id: null, orderDate: today(), notifiedDate: '', packedDate: '', shipDate: '', paidDate: '',
    items: emptyItems(), prices: { ...data.settings.prices }, delivery: 'ship', payment: data.settings.defaultPayment || 'paypay', shippingAuto: true, combine: true, shippingFee: 0, note: '',
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

// 選んだ支払い方法の支払い先が設定に書かれていないときの注意
function paymentWarning(pay) {
  const st = data.settings;
  const miss = [];
  if (pay !== 'bank' && !st.payPayInfo.trim()) miss.push('PayPay');
  if (pay !== 'paypay' && !st.bankTransferInfo.trim()) miss.push('銀行振込');
  return miss.length ? `<p class="warn">設定に${miss.join('・')}の支払い先が書かれていません（「設定 → お支払い先」）。</p>` : '';
}

function prefOptions(selected) {
  return `<option value="">選択してください</option>` + PREFECTURES.map((p) => `<option ${p === selected ? 'selected' : ''}>${p}</option>`).join('');
}

function renderOrderForm() {
  if (!view.draft) { view.draft = newDraft(view.id); view.draftSaved = view.id ? draftKey(view.draft) : draftKey(newDraft(null)); }
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
        ${isHand(d) ? '<p class="hint">手渡しの場合、住所は空のままで大丈夫です。</p>' : ''}
        ${d.custMode !== '__new' ? '<p class="hint">ここで変えた住所・連絡先は発注者情報にも反映されます。</p>' : ''}
      ` : ''}
    </section>

    <section class="panel">
      <h2>受け渡し方法</h2>
      <div class="segmented" role="radiogroup">
        <label><input type="radio" name="delivery" data-input="delivery" value="ship" ${!isHand(d) ? 'checked' : ''}><span>🚚 配送（佐川急便）</span></label>
        <label><input type="radio" name="delivery" data-input="delivery" value="hand" ${isHand(d) ? 'checked' : ''}><span>🤝 手渡し</span></label>
      </div>
      ${isHand(d) ? '<p class="hint">手渡しは送料なし・住所の入力は不要です。代金は現金の想定で、総額連絡に支払い先は載せません。</p>' : `
      <h2 class="sub-h">お支払い方法</h2>
      <div class="segmented three" role="radiogroup">
        ${PAYMENTS.map(([v, l]) => `<label><input type="radio" name="payment" data-input="payment" value="${v}" ${paymentOf(d) === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </div>
      ${paymentWarning(paymentOf(d))}`}
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
      ${isHand(d) ? '' : `
      <label class="check"><input type="checkbox" data-input="shippingAuto" ${d.shippingAuto ? 'checked' : ''}> 送料を自動計算（佐川急便・熊本発）</label>
      ${d.shippingAuto ? `<label class="check"><input type="checkbox" data-input="combine" ${d.combine !== false ? 'checked' : ''}> 袋をまとめて梱包する（一番安い箱の組み合わせ）</label>` : ''}
      ${d.shippingAuto ? '' : `<label>送料（手入力）<input data-input="shippingFee" value="${num(d.shippingFee)}" inputmode="numeric"></label>`}`}
    </section>

    <section class="panel">
      <h2>日付・ステータス</h2>
      <div class="status-line" id="status-line"></div>
      ${dateField('orderDate', '受注日')}
      <div id="step-actions"></div>
      ${dateField('notifiedDate', '総額連絡日', '先方に総額をお知らせした日 → 未梱包')}
      ${dateField('packedDate', '梱包日', `梱包が終わった日 → ${isHand(d) ? 'お渡し待ち' : '発送待ち'}`)}
      ${isHand(d) ? dateField('shipDate', 'お渡し日', 'お渡し日を過ぎると → お渡し済み') : dateField('shipDate', '発送日', '発送日を過ぎると → 発送済み')}
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
    <div class="date-field" data-field="${key}">
      <label>${label}${hint ? `<small>${hint}</small>` : ''}</label>
      <div class="date-row">
        <input type="date" data-input="${key}" value="${esc(v)}">
        <button class="btn small" data-action="date-today" data-key="${key}">今日</button>
        <button class="btn small ghost" data-action="date-clear" data-key="${key}" aria-label="消去" ${v ? '' : 'hidden'}>✕</button>
      </div>
      <p class="lock-note warn"></p>
    </div>`;
}

function computeDraft() {
  const d = view.draft;
  d.riceAmount = riceAmount(d.items, d.prices);
  if (isHand(d)) { d.shippingFee = 0; d.shippingPending = false; return null; }
  const detail = shippingDetail(d.items, d.cust.prefecture, d.combine !== false);
  if (d.shippingAuto) d.shippingFee = detail && !detail.error ? detail.total : 0;
  d.shippingPending = !!shippingPendingReason(d);
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
      ${!isHand(d) && d.shippingAuto ? shippingLinesHtml(detail, d.cust.prefecture) : ''}
      <div class="tl sum"><span>送料</span><span>${isHand(d) ? 'なし（手渡し）' : d.shippingPending ? '未定' : yenJ(d.shippingFee)}</span></div>
      <div class="tl grand"><span>合計</span><span>${yenJ(d.riceAmount + num(d.shippingFee))}${d.shippingPending ? '<small>＋送料</small>' : ''}</span></div>`;
  }
  // 住所が入るまでは発送日、送料が決まるまでは総額連絡日を入れられない
  // 日付の✕ボタンは、日付が入っているときだけ見せる
  for (const k of ['orderDate', 'notifiedDate', 'packedDate', 'shipDate', 'paidDate']) {
    const x = $(`[data-action="date-clear"][data-key="${k}"]`);
    if (x) x.hidden = !d[k];
  }
  const lockField = (key, locked, note) => {
    const box = $(`[data-field="${key}"]`);
    if (!box) return;
    const hasValue = !!d[key];
    box.querySelectorAll('input, button').forEach((b) => { b.disabled = locked && !hasValue; });
    box.querySelector('.lock-note').textContent = locked ? note : '';
  };
  lockField('shipDate', !isHand(d) && !addressReady(d.cust), '都道府県とご住所を入れると、発送日を入力できます');
  lockField('notifiedDate', d.shippingPending, '送料が決まると、総額連絡日を入力できます');
  const sl = $('#status-line');
  if (sl) {
    const ss = shipStatus(d), ps = payStatus(d);
    sl.innerHTML = `<span class="badge s-${ss.key}">${ss.label}</span><span class="badge s-${ps.key}">${ps.label}</span>`;
  }
  const sa = $('#step-actions');
  if (sa) {
    const step = nextStep(d);
    const blocked = step?.action === 'ship' && !isHand(d) && !addressReady(d.cust);
    sa.innerHTML = step ? `<button class="btn block step-btn step-${step.action}" data-action="step-${step.action}" ${blocked ? 'disabled' : ''}>${step.label}</button>
      ${blocked ? '<p class="warn">都道府県とご住所を入れると、発送済みにできます。</p>' : ''}` : '';
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
  if (!totalBags(d.items)) return '袋数を1つ以上入力してください';
  if (!d.orderDate) return '受注日を入力してください';
  const noPrice = BAG_SIZES.find((s) => !num(d.prices[s]) && RICE_TYPES.some((t) => num(d.items[t.id][s])));
  if (noPrice) return `${noPrice}kgの価格が未設定です。設定で入力してください`;
  computeDraft();
  if (!isHand(d) && d.shipDate && !addressReady(d.cust)) return '発送日を入れるには、都道府県とご住所を入力してください';
  if (d.notifiedDate && d.shippingPending) return '総額連絡日を入れるには、送料が決まっている必要があります（都道府県を入力するか、送料を手入力）';
  return null;
}

// 住所（都道府県とご住所）がそろっているか
const addressReady = (c) => !!(c && c.prefecture && (c.address || '').trim());

// 送料が決まっていない理由（決まっていれば空）
function shippingPendingReason(d) {
  if (isHand(d) || !d.shippingAuto) return '';
  if (!d.cust.prefecture) return '都道府県を入力すると送料を計算します';
  const detail = shippingDetail(d.items, d.cust.prefecture, d.combine !== false);
  if (!detail) return `${d.cust.prefecture}は送料の自動計算の対象外です。送料を手入力してください`;
  if (detail.error) return detail.error;
  return '';
}

// 発注者の住所が入ったら、その方の「送料未定」の受注の送料を計算し直す
function recalcPendingShipping(customer) {
  if (!customer?.prefecture) return 0;
  let n = 0;
  for (const o of data.orders) {
    if (o.customerId !== customer.id || isHand(o) || !o.shippingPending || !o.shippingAuto) continue;
    const detail = shippingDetail(o.items, customer.prefecture, o.combine !== false);
    if (!detail || detail.error) continue;
    o.shippingFee = detail.total;
    o.shippingPending = false;
    n++;
  }
  return n;
}

// 画面に表示されている日付・メモを下書きに読み直す（合図の取りこぼし対策）
function syncDraftFromScreen() {
  const d = view.draft;
  if (!d || view.name !== 'order') return;
  for (const k of ['orderDate', 'notifiedDate', 'packedDate', 'shipDate', 'paidDate']) { const el = $(`[data-input="${k}"]`); if (el) d[k] = el.value; }
  const note = $('[data-input="note"]'); if (note) d.note = note.value;
}

// 保存していない変更があるか（受注画面）
const draftKey = (d) => JSON.stringify([d.custMode, d.cust, d.items, d.orderDate, d.notifiedDate, d.packedDate || '', d.shipDate, d.paidDate,
  d.delivery, d.payment, d.shippingAuto, d.combine, d.shippingAuto ? 0 : d.shippingFee, d.note]);
function isDraftDirty() {
  if (view.name !== 'order' || !view.draft) return false;
  syncDraftFromScreen();
  return draftKey(view.draft) !== view.draftSaved;
}

async function saveDraft({ silent = false } = {}) {
  syncDraftFromScreen();
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
    Object.assign(customer, { ...d.cust, name, delivery: d.delivery || 'ship', ...(isHand(d) ? {} : { payment: paymentOf(d) }) });
  } else {
    customer = customerById(d.custMode);
    Object.assign(customer, { prefecture: d.cust.prefecture, postal: d.cust.postal, address: d.cust.address, phone: d.cust.phone, delivery: d.delivery || 'ship', ...(isHand(d) ? {} : { payment: paymentOf(d) }) });
  }
  recalcPendingShipping(customer);
  const { custMode, cust, ...fields } = d;
  const order = { ...fields, customerId: customer.id, updatedAt: Date.now() };
  if (!order.id) { order.id = uid(); order.createdAt = Date.now(); data.orders.push(order); }
  else Object.assign(orderById(order.id), order);
  await persist();
  view.draft = newDraft(order.id);
  view.id = order.id;
  view.draftSaved = draftKey(view.draft);
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
    (st.greeting || '').trim() || DEFAULT_GREETING,
    '',
    ...lines.map((l) => `・${l.type} ${l.size}kg × ${l.count}袋　${yenJ(l.amount)}`),
    ...(isHand(d) ? [] : [`・送料（佐川急便）　${yenJ(d.shippingFee)}`]),
    '',
    `合計金額：${yenJ(d.riceAmount + num(d.shippingFee))}`,
    // 手渡しのときは支払い先を載せない
    ...(isHand(d) ? [] : paymentLines(paymentOf(d))),
    '',
    isHand(d) ? 'お渡しの日時は、改めてご相談させてください。どうぞよろしくお願いいたします。' : '準備ができ次第、発送いたします。どうぞよろしくお願いいたします。',
    ...(st.issuer.name ? ['', st.issuer.name] : []),
  ].join('\n');
}

// 「総額を連絡する」：まず受注を保存し、送る前に文面を確認・修正する画面へ
// 総額連絡メッセージに入れる支払い先（見出しが書かれていなければ付ける）
function paymentLines(pay) {
  const st = data.settings;
  const block = (title, text) => {
    const t = (text || '').trim();
    if (!t) return [];
    return ['', ...(/^\s*[【\[■◆●]/.test(t) ? [] : [title]), t];
  };
  const pp = pay !== 'bank' ? block('【お支払い（PayPay）】', st.payPayInfo) : [];
  const bk = pay !== 'paypay' ? block('【お振込先】', st.bankTransferInfo) : [];
  if (pp.length && bk.length) return ['', 'お支払いは、PayPayか銀行振込のどちらかでお願いいたします。', ...pp, ...bk];
  return [...pp, ...bk];
}

async function doNotify() {
  const err = validateDraft();
  if (err) return toast(err);
  const why = shippingPendingReason(view.draft);
  if (why) return toast('送料が未定のため、総額を連絡できません。' + why);
  const text = notifyText();
  if (!(await saveDraft({ silent: true }))) return;
  go('notify', { id: view.id, text });
}

const NOTIFY_SUBJECT = 'お米のご注文について（合計金額のお知らせ）';
const mailtoHref = (text) => `mailto:?subject=${encodeURIComponent(NOTIFY_SUBJECT)}&body=${encodeURIComponent(text)}`;

function renderNotify() {
  const o = orderById(view.id);
  if (!o) return '<div class="empty">受注が見つかりません</div>';
  const c = customerById(o.customerId) || {};
  return `
    <section class="panel">
      <div class="notify-to">
        <div><span class="muted">宛先</span> <strong>${esc(c.name)} 様</strong></div>
        <div class="muted">${[isHand(o) ? '手渡し' : c.prefecture, c.phone ? '☎ ' + c.phone : ''].filter(Boolean).map(esc).join('　')}</div>
        <div class="notify-total">合計 ${yenJ(orderTotal(o))}</div>
      </div>
      <label>送る文面（ここで直せます）
        <textarea data-n="text" rows="16">${esc(view.text)}</textarea>
      </label>
      <p class="hint">ここでの修正は今回だけです。いつも使うあいさつ文は「設定 → 総額連絡のあいさつ文」で変えられます。</p>
      <button class="btn small ghost" data-action="notify-reset">文面を作り直す</button>
    </section>
    <div class="actions">
      <button class="btn primary block" data-action="notify-share">📤 LINE・メッセージなどで送る</button>
      <button class="btn block" data-action="notify-copy">📋 コピーする（LINEなどに貼り付け）</button>
      <a class="btn block" id="notify-mail" href="${esc(mailtoHref(view.text))}" data-action="notify-mail">✉️ メールで送る</a>
      <button class="btn block ghost" data-action="back-order">送らずに受注に戻る</button>
    </div>`;
}

// 送ったあと：総額連絡日がまだなら今日にするか確認
async function afterNotified() {
  const o = orderById(view.id);
  if (!o || o.notifiedDate) return;
  if (!confirm('総額連絡日を今日にして「未梱包」にしますか？')) return;
  o.notifiedDate = today();
  o.updatedAt = Date.now();
  await persist();
  toast('総額連絡日を今日にしました');
}

async function notifyShare() {
  const text = view.text;
  if (!navigator.share) return notifyCopy();
  try { await navigator.share({ text }); } catch (e) { if (e.name !== 'AbortError') toast('共有できませんでした。コピーをお使いください'); return; }
  await afterNotified();
}

async function notifyCopy() {
  try { await navigator.clipboard.writeText(view.text); }
  catch {
    // クリップボードが使えないときは文面を選択状態にする
    const ta = $('[data-n="text"]'); ta.focus(); ta.select();
    return toast('文面を選択しました。「コピー」を押してください');
  }
  toast('コピーしました。LINEなどに貼り付けてください');
  setTimeout(afterNotified, 600);
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
  if (!view.r) view.r = { photo: true, pphoto: true, thanks: true, ...receiptDefaults(o), ...(o.receipt || {}) };
  const r = view.r;
  const st = data.settings;
  const photo = st.receiptPhoto && r.photo !== false ? st.receiptPhoto : null;
  const paper = st.receiptPaper === 'a5' ? 'a5' : 'a4';
  const layout = st.receiptPhotoLayout === 'band' ? 'band' : 'background';
  const lines = itemLines(o.items, o.prices);
  const iss = st.issuer;
  return `
    <section class="panel no-print">
      <p class="hint">内容を確認・修正して「印刷 / PDF保存」を押してください。印刷画面で2本指で拡大するとPDFとして共有・保存できます。</p>
      <label>宛名<input data-r="to" value="${esc(r.to)}"></label>
      <label>発行日<input type="date" data-r="date" value="${esc(r.date)}"></label>
      <label>但し書き<textarea data-r="note" rows="2">${esc(r.note)}</textarea></label>
      ${st.receiptPhoto ? `<label class="check"><input type="checkbox" data-r-photo ${r.photo !== false ? 'checked' : ''}> 写真を入れる</label>`
        : '<p class="hint">「設定 → 領収書の写真」で、稲穂などの写真を入れられます。</p>'}
      ${st.producerPhoto ? `<label class="check"><input type="checkbox" data-r-pphoto ${r.pphoto !== false ? 'checked' : ''}> 生産者写真を入れる</label>` : ''}
      ${(st.receiptThanks || '').trim() ? `<label class="check"><input type="checkbox" data-r-thanks ${r.thanks !== false ? 'checked' : ''}> ひと言（${esc(st.receiptThanks.trim().split('\n')[0])}）を入れる</label>` : ''}
      <h2 class="sub-h">用紙</h2>
      <div class="segmented" role="radiogroup">
        <label><input type="radio" name="paper" data-input="paper" value="a4" ${paper === 'a4' ? 'checked' : ''}><span>A4（切り取り線）</span></label>
        <label><input type="radio" name="paper" data-input="paper" value="a5" ${paper === 'a5' ? 'checked' : ''}><span>A5</span></label>
      </div>
      <p class="hint">${paper === 'a4' ? 'A4用紙の上にA5の大きさで印刷します。点線で切り取ってください。' : 'プリンターがA5用紙に対応しているときに選んでください。'}</p>
      ${!iss.name ? '<p class="warn">発行者情報が未入力です。「設定」から入力してください。</p>' : ''}
      ${!o.paidDate ? '<p class="warn">この受注はまだ入金確認日が入力されていません。</p>' : ''}
      ${o.shippingPending ? '<p class="warn">送料が未定です（発注者の住所が未登録）。金額に送料が含まれていません。</p>' : ''}
      <div class="actions">
        ${view.img ? `
          <div class="img-preview">
            <p class="hint">この画像を送ります。内容を確認してください。</p>
            <img src="${view.img.url}" alt="領収書の画像">
            <button class="btn primary block" data-action="image-share">📤 LINEなどで送る</button>
            <button class="btn block ghost" data-action="image-close">閉じる</button>
          </div>` : ''}
        <button class="btn primary block" data-action="print">🖨 印刷 / PDF保存</button>
        <button class="btn block" data-action="image-make">🖼 画像にしてLINEなどで送る</button>
        <button class="btn block" data-action="back-order">受注に戻る</button>
      </div>
    </section>
    <div class="receipt-print paper-${paper}">
    <div class="receipt-sheet ${photo ? 'has-photo photo-' + layout : ''}">
      ${photo ? `<img class="rc-photo op-${[10, 18, 28].includes(num(st.receiptPhotoOpacity)) ? num(st.receiptPhotoOpacity) : 18}" src="${photo.dataUrl}" alt="">` : ''}
      <div class="rc-body">
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
      ${r.thanks !== false && (st.receiptThanks || '').trim() ? `<p class="rc-thanks">${esc(st.receiptThanks.trim()).replace(/\n/g, '<br>')}</p>` : ''}
      <div class="rc-issuer">
        <div class="rc-issuer-text">
          <div class="name">${esc(iss.name)}</div>
          ${iss.postal ? `<div>〒${esc(iss.postal)}</div>` : ''}
          <div>${esc(iss.address).replace(/\n/g, '<br>')}</div>
          ${iss.phone ? `<div>TEL ${esc(iss.phone)}</div>` : ''}
        </div>
        ${st.producerPhoto && r.pphoto !== false ? `<img class="rc-pphoto shape-${st.producerPhotoShape === 'square' ? 'square' : 'circle'}" src="${st.producerPhoto.cropped}" alt="">` : ''}
      </div>
      </div>
    </div>
    </div>`;
}

// 発行するとき（印刷・画像）に領収書番号を付け、内容を記録する
async function issueReceipt() {
  const o = orderById(view.id);
  if (!o.receiptNo) {
    data.settings.receiptSeq = num(data.settings.receiptSeq) + 1;
    o.receiptNo = `${view.r.date.slice(0, 4)}-${String(data.settings.receiptSeq).padStart(4, '0')}`;
  }
  o.receipt = { ...view.r };
  await persist();
  return o;
}

async function doPrint() {
  await issueReceipt();
  render();
  setTimeout(() => window.print(), 50);
}

// ---------- 領収書を画像にする ----------
// html2canvas（MIT、js/vendor に同梱）を必要なときだけ読み込む
let h2cLoading = null;
function loadHtml2canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  h2cLoading ||= new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'js/vendor/html2canvas.min.js';
    sc.onload = () => resolve(window.html2canvas);
    sc.onerror = () => { h2cLoading = null; reject(new Error('画像を作る部品を読み込めませんでした')); };
    document.head.appendChild(sc);
  });
  return h2cLoading;
}

async function makeReceiptImage() {
  const o = await issueReceipt();
  if (view.img) URL.revokeObjectURL(view.img.url);
  view.img = null;
  render();
  toast('画像を作っています…');
  try {
    const h2c = await loadHtml2canvas();
    const sheet = $('.receipt-sheet');
    const canvas = await h2c(sheet, {
      scale: 3, backgroundColor: '#ffffff', logging: false,
      // html2canvas は object-fit に対応していないので、写真は背景画像（cover）に置き換えて描く
      onclone: (doc) => {
        doc.querySelectorAll('.rc-photo').forEach((img) => {
          const div = doc.createElement('div');
          div.className = img.className;
          div.style.backgroundImage = `url("${img.getAttribute('src')}")`;
          div.style.backgroundSize = 'cover';
          div.style.backgroundPosition = 'center';
          img.replaceWith(div);
        });
      },
    });
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('画像を作れませんでした');
    const name = `領収書_${o.receiptNo}.png`;
    view.img = { url: URL.createObjectURL(blob), file: new File([blob], name, { type: 'image/png' }), name };
    render();
    $('.img-preview')?.scrollIntoView({ block: 'start' });
  } catch (err) {
    toast(err.message || '画像を作れませんでした');
  }
}

// 共有メニューはタップ直後に開く必要があるので、作った画像をすぐ渡す
async function shareReceiptImage() {
  const img = view.img;
  if (!img) return;
  try {
    if (navigator.canShare?.({ files: [img.file] })) { await navigator.share({ files: [img.file] }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  // 共有できない環境では画像を保存
  const a = document.createElement('a');
  a.href = img.url; a.download = img.name; a.click();
  toast('画像を保存しました');
}

// 写真を長い辺 1600px の JPEG に縮小して data URL にする（データは外部に送らない）
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('この写真は読み込めませんでした')); img.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.82);
  } finally { URL.revokeObjectURL(url); }
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
      <h2>生産者写真（領収書の発行者名の横）</h2>
      ${view.crop ? `
        <p class="hint">枠の中に見えている部分が領収書に入ります。指でずらして位置を、2本指で広げる・下のつまみで大きさを調整してください。</p>
        <div class="crop-view shape-${st.producerPhotoShape === 'square' ? 'square' : 'circle'}" id="crop-view"><img id="crop-img" src="${view.crop.src}" alt="" draggable="false"></div>
        <label class="inline">大きさ<input type="range" id="crop-zoom" min="1" max="5" step="0.01" value="${view.crop.z}"></label>
        <div class="crop-actions">
          <button class="btn" data-action="crop-cancel">やめる</button>
          <button class="btn primary" data-action="crop-save">この範囲で決定</button>
        </div>
      ` : st.producerPhoto ? `
        <div class="pphoto-row">
          <img class="pphoto-preview shape-${st.producerPhotoShape === 'square' ? 'square' : 'circle'}" src="${st.producerPhoto.cropped}" alt="生産者写真">
          <div class="hint">${esc(fmtDateJ(st.producerPhoto.updatedAt))}に設定</div>
        </div>
        <label class="inline">枠の形<select data-s="producerPhotoShape">
          <option value="circle" ${st.producerPhotoShape !== 'square' ? 'selected' : ''}>丸</option>
          <option value="square" ${st.producerPhotoShape === 'square' ? 'selected' : ''}>四角</option>
        </select></label>
        <button class="btn block" data-action="crop-edit">位置・大きさを調整</button>
        <button class="btn block" data-action="pphoto-pick">写真を差し替える</button>
        <button class="btn small ghost" data-action="pphoto-remove">写真を外す</button>
      ` : `
        <p class="hint">顔写真や作業風景など、生産者の写真を発行者名の横に入れられます。写真はこのiPhoneの中にだけ、暗号化して保存されます。</p>
        <button class="btn block" data-action="pphoto-pick">📷 写真を選ぶ</button>
      `}
      <input type="file" id="pphoto-file" accept="image/*" hidden>
    </section>

    <section class="panel">
      <h2>領収書の写真</h2>
      ${st.receiptPhoto ? `
        <img class="photo-preview" src="${st.receiptPhoto.dataUrl}" alt="領収書の写真">
        <p class="hint">${esc(fmtDateJ(st.receiptPhoto.updatedAt))}に設定。毎年、新しい写真に差し替えられます。</p>
        <label class="inline">入れ方<select data-s="receiptPhotoLayout">
          <option value="background" ${st.receiptPhotoLayout !== 'band' ? 'selected' : ''}>背景全体にうすく</option>
          <option value="band" ${st.receiptPhotoLayout === 'band' ? 'selected' : ''}>上部に帯</option>
        </select></label>
        ${st.receiptPhotoLayout !== 'band' ? `<label class="inline">濃さ<select data-s="receiptPhotoOpacity" data-num>
          ${[[10, 'うすい'], [18, 'ふつう'], [28, 'こい']].map(([v, l]) => `<option value="${v}" ${num(st.receiptPhotoOpacity) === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>` : ''}
        <button class="btn block" data-action="photo-pick">写真を差し替える</button>
        <button class="btn small ghost" data-action="photo-remove">写真を外す</button>
      ` : `
        <p class="hint">稲穂や田んぼの写真を領収書に入れられます。写真はこのiPhoneの中にだけ、暗号化して保存されます。</p>
        <button class="btn block" data-action="photo-pick">📷 写真を選ぶ</button>
      `}
      <input type="file" id="photo-file" accept="image/*" hidden>
    </section>

    <section class="panel">
      <h2>領収書のひと言（明細表の下）</h2>
      <textarea data-s="receiptThanks" rows="2">${esc(st.receiptThanks)}</textarea>
      <p class="hint">空にすると入りません。領収書ごとに外すこともできます。</p>
      <button class="btn small" data-action="reset-thanks" ${st.receiptThanks === DEFAULT_THANKS ? 'disabled' : ''}>元の文に戻す</button>
    </section>

    <section class="panel">
      <h2>総額連絡のあいさつ文</h2>
      <textarea data-s="greeting" rows="3">${esc(st.greeting)}</textarea>
      <p class="hint">「〇〇 様」の次に入る文です。書き換えると記憶されます。</p>
      <button class="btn small" data-action="reset-greeting" ${st.greeting === DEFAULT_GREETING ? 'disabled' : ''}>元の文に戻す</button>
    </section>

    <section class="panel">
      <h2>入金の集計</h2>
      <label>集計の開始日<small>この日以降の入金確認日を集計します。空のときはその年の1月1日です。</small>
        <div class="date-row"><input type="date" data-s="reportStart" value="${esc(st.reportStart)}">
          <button class="btn small" data-action="reset-report-start">1月1日に戻す</button></div></label>
      <p class="hint" id="report-start-hint">いま：${fmtDateJ(reportStart())}〜（終了日は集計画面で選べます。初めは今日）</p>
    </section>

    <section class="panel">
      <h2>お支払い先（総額連絡に記載・手渡しのときは載せません）</h2>
      ${st.paymentSplitNotice ? `<div class="warn box">以前の「お振込先」の内容を、PayPayと銀行振込の欄に自動で分けました。内容を確認してください。
        <button class="btn small" data-action="dismiss-split">確認しました</button></div>` : ''}
      <label>PayPay<textarea data-s="payPayInfo" rows="3" placeholder="例：PayPayのリンクやID">${esc(st.payPayInfo)}</textarea></label>
      <label>銀行振込<textarea data-s="bankTransferInfo" rows="3" placeholder="例：〇〇銀行 〇〇支店 普通 1234567 ヤマダタロウ">${esc(st.bankTransferInfo)}</textarea></label>
      <p class="hint">受注ごとに「PayPay／銀行振込／両方」を選べます。発注者ごとに前回の選び方を覚えます。</p>
      <label class="inline">初めての方の標準<select data-s="defaultPayment">
        ${PAYMENTS.map(([v, l]) => `<option value="${v}" ${st.defaultPayment === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
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
      ${view.backup ? `
        <div class="backup-ready" id="backup-ready">
          <p>✅ バックアップを作りました（${esc(view.backup.name)}・${Math.max(1, Math.round(view.backup.size / 1024)).toLocaleString('ja-JP')}KB）</p>
          <button class="btn primary block" data-action="backup-share">📤 「ファイル」に保存・送る</button>
          <p class="hint">共有メニューで「"ファイル"に保存」を選ぶと、iPhoneの「ファイル」アプリに残せます。</p>
        </div>` : ''}
      <button class="btn block" data-action="export">${view.backup ? 'バックアップを作り直す' : 'バックアップを書き出す'}</button>
      <button class="btn block" data-action="import">バックアップから復元</button>
      <input type="file" id="import-file" accept=".json,application/json" hidden>
    </section>

    <section class="panel">
      <button class="btn danger block" data-action="erase">すべてのデータを消去</button>
    </section>

    <section class="panel">
      <h2>アプリの版</h2>
      <p>版 ${APP_VERSION}</p>
      <button class="btn small" data-action="check-update">最新の版を確認</button>
    </section>`;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let o = obj;
  for (const k of keys) o = o[k];
  o[last] = value;
}

// バックアップ：①ファイルを作る → ②タップで保存・共有（共有メニューはタップ直後でないと開けないため2段階）
async function doExport() {
  try {
    await flushSettingsSave();
    await saveChain;
    toast('バックアップを作っています…');
    const text = await vault.exportBackup(data);
    const name = `rice-orders-backup-${today()}.json`;
    const file = new File([text], name, { type: 'application/json' });
    if (view.backup) URL.revokeObjectURL(view.backup.url);
    view.backup = { file, name, url: URL.createObjectURL(file), size: file.size };
    render();
    $('#backup-ready')?.scrollIntoView({ block: 'center' });
  } catch (err) {
    console.error(err);
    toast('バックアップを作れませんでした：' + (err.message || err));
  }
}

async function shareBackup() {
  const b = view.backup;
  if (!b) return;
  try {
    if (navigator.canShare?.({ files: [b.file] })) { await navigator.share({ files: [b.file] }); toast('バックアップを渡しました'); return; }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  // 共有できない環境ではダウンロード
  const a = document.createElement('a');
  a.href = b.url; a.download = b.name; a.click();
  toast('バックアップを保存しました');
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
function setPaperCss() {
  const link = $('#paper-css');
  const href = `css/paper-${data?.settings.receiptPaper === 'a5' ? 'a5' : 'a4'}.css`;
  if (link && link.getAttribute('href') !== href) link.setAttribute('href', href);
}

function afterRender() {
  setPaperCss();
  if (view.name === 'order') updateTotals();
  if (view.name === 'settings' && view.crop) setupCropper();
}

// 枠（正方形）の中で写真を動かす・拡大する
// view.crop = { src, sx, sy, z }：sx, sy は枠の左上が写真のどこか（写真の幅・高さに対する割合）、z は拡大率（1＝枠いっぱい）
function setupCropper() {
  const box = $('#crop-view'), img = $('#crop-img'), zoom = $('#crop-zoom');
  if (!box || !img) return;
  const c = view.crop;
  let V, w, h, s0, ox = 0, oy = 0;
  const scale = () => s0 * c.z;
  const apply = () => {
    const s = scale();
    ox = Math.min(0, Math.max(V - w * s, ox));
    oy = Math.min(0, Math.max(V - h * s, oy));
    img.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
    c.sx = -ox / s / w; c.sy = -oy / s / h;
  };
  // 枠の中のある点（px）を固定したまま拡大率を変える
  const setZoom = (z, px = V / 2, py = V / 2) => {
    const s = scale();
    const ix = (px - ox) / s, iy = (py - oy) / s;
    c.z = Math.min(5, Math.max(1, z));
    ox = px - ix * scale(); oy = py - iy * scale();
    apply();
    if (zoom) zoom.value = c.z;
  };
  const start = () => {
    V = box.clientWidth; w = img.naturalWidth; h = img.naturalHeight;
    s0 = Math.max(V / w, V / h);
    img.style.width = w + 'px'; img.style.height = h + 'px';
    const s = scale();
    if (c.sx == null) { ox = (V - w * s) / 2; oy = (V - h * s) / 2; } // 初めは中央
    else { ox = -c.sx * w * s; oy = -c.sy * h * s; }
    apply();
  };
  if (img.complete && img.naturalWidth) start(); else img.onload = start;

  const pts = new Map();
  let last = null; // { x, y, dist }
  const center = () => { const a = [...pts.values()]; return { x: a.reduce((t, p) => t + p.x, 0) / a.length, y: a.reduce((t, p) => t + p.y, 0) / a.length }; };
  const dist = () => { const [a, b] = [...pts.values()]; return b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
  const local = (e) => { const r = box.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  box.addEventListener('pointerdown', (e) => { try { box.setPointerCapture(e.pointerId); } catch { /* 取れなくても動かせる */ } pts.set(e.pointerId, local(e)); last = { ...center(), dist: dist() }; e.preventDefault(); });
  box.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, local(e));
    const cpos = center(), d = dist();
    ox += cpos.x - last.x; oy += cpos.y - last.y;
    if (d && last.dist) setZoom(c.z * d / last.dist, cpos.x, cpos.y); else apply();
    last = { ...cpos, dist: d };
    e.preventDefault();
  });
  const end = (e) => { pts.delete(e.pointerId); last = pts.size ? { ...center(), dist: dist() } : null; };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  // パソコンのホイールでも拡大縮小
  box.addEventListener('wheel', (e) => { e.preventDefault(); const p = local(e); setZoom(c.z * (e.deltaY < 0 ? 1.08 : 1 / 1.08), p.x, p.y); }, { passive: false });
  zoom?.addEventListener('input', () => setZoom(parseFloat(zoom.value)));
}

// 枠の中の部分を 480px 四方の画像にして保存
async function saveCrop() {
  const c = view.crop;
  const img = $('#crop-img');
  if (!img || !img.naturalWidth || c.sx == null) return;
  const w = img.naturalWidth, h = img.naturalHeight;
  const side = Math.min(w, h) / c.z; // 枠に入っている部分の一辺（写真のpx）
  const cv = document.createElement('canvas');
  cv.width = cv.height = 480;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 480, 480);
  ctx.drawImage(img, c.sx * w, c.sy * h, side, side, 0, 0, 480, 480);
  const prev = data.settings.producerPhoto;
  data.settings.producerPhoto = {
    original: c.src,
    cropped: cv.toDataURL('image/jpeg', 0.85),
    crop: { sx: c.sx, sy: c.sy, z: c.z },
    updatedAt: c.isNew || !prev ? today() : prev.updatedAt,
  };
  view.crop = null;
  await persist(); render(); toast('生産者写真を設定しました');
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
      if (isDraftDirty()) {
        if (confirm('この受注に保存していない変更があります。\n保存してから移動しますか？\n（「キャンセル」で変更を捨てて移動）')) {
          if (!(await saveDraft())) return; // 保存できなければ移動しない（理由はお知らせに表示）
        }
      }
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
    case 'step-pack':
    case 'step-ship': {
      const key = a === 'step-pack' ? 'packedDate' : 'shipDate';
      d[key] = today();
      const inp = $(`[data-input="${key}"]`); if (inp) inp.value = d[key]; // 保存前に画面の日付を読み直すので、画面にも入れる
      if (await saveDraft({ silent: true })) { render(); toast(`「${shipStatus(view.draft).label}」にしました`); }
      else d[key] = '';
      return;
    }
    case 'quick-step': {
      // 一覧から、その受注の次の作業を済ませる
      const o = orderById(el.dataset.id);
      const step = o && nextStep(o);
      if (!step) return;
      const c = customerById(o.customerId);
      if (step.action === 'ship' && !isHand(o) && !addressReady(c)) return toast('住所が未登録です。受注を開いて都道府県とご住所を入れてください');
      o[step.action === 'pack' ? 'packedDate' : 'shipDate'] = today();
      o.updatedAt = Date.now();
      await persist();
      render();
      toast(`${c?.name || ''} 様を「${shipStatus(o).label}」にしました`);
      return;
    }
    case 'date-clear': d[el.dataset.key] = ''; return render();
    case 'save-order': if (await saveDraft()) render(); return;
    case 'notify': return doNotify();
    case 'notify-share': return notifyShare();
    case 'notify-copy': return notifyCopy();
    case 'notify-mail': setTimeout(afterNotified, 1500); return; // リンク先（メール）はそのまま開く
    case 'notify-reset': {
      if (!confirm('直した内容を消して、文面を作り直しますか？')) return;
      view.draft = newDraft(view.id);
      view.text = notifyText();
      view.draft = null;
      return render();
    }
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
    case 'image-make': return makeReceiptImage();
    case 'image-share': return shareReceiptImage();
    case 'image-close': URL.revokeObjectURL(view.img?.url); view.img = null; return render();
    case 'back-order': return go('order', { id: view.id });
    case 'new-customer': return go('customer', { id: null });
    case 'open-customer': return go('customer', { id: el.dataset.id });
    case 'order-for': {
      go('order', { id: null });
      const c = customerById(el.dataset.id);
      Object.assign(view.draft, { custMode: c.id, delivery: c.delivery || 'ship', payment: c.payment || data.settings.defaultPayment || 'paypay', cust: { name: c.name, prefecture: c.prefecture || '', postal: c.postal || '', address: c.address || '', phone: c.phone || '' } });
      return render();
    }
    case 'save-customer': {
      if (!d.name.trim()) return toast('発注者名を入力してください');
      d.name = d.name.trim();
      if (data.customers.some((c) => c.name === d.name && c.id !== d.id) && !confirm('同じ名前の発注者がいます。保存しますか？')) return;
      if (d.id) Object.assign(customerById(d.id), d);
      else { d.id = uid(); d.createdAt = Date.now(); data.customers.push(clone(d)); }
      const n = recalcPendingShipping(customerById(d.id));
      await persist(); toast(n ? `保存しました（送料未定だった受注${n}件の送料を計算しました）` : '保存しました'); return go('customers');
    }
    case 'delete-customer':
      if (confirm('この発注者を削除しますか？')) {
        data.customers = data.customers.filter((c) => c.id !== d.id);
        await persist(); toast('削除しました'); go('customers');
      }
      return;
    case 'open-report': return go('report');
    case 'reset-report-start':
      data.settings.reportStart = '';
      await persist(); render(); toast(`集計の開始日を${today().slice(0, 4)}年1月1日に戻しました`);
      return;
    case 'report-today': { view.to = today(); const i = $('[data-input="reportTo"]'); if (i) i.value = view.to; return updateReport(); }
    case 'photo-pick': return $('#photo-file').click();
    case 'pphoto-pick': return $('#pphoto-file').click();
    case 'pphoto-remove':
      if (!confirm('生産者写真を外しますか？')) return;
      data.settings.producerPhoto = null;
      await persist(); render(); toast('写真を外しました');
      return;
    case 'crop-edit': {
      const pp = data.settings.producerPhoto;
      view.crop = { src: pp.original, ...pp.crop, isNew: false };
      return render();
    }
    case 'crop-cancel': view.crop = null; return render();
    case 'crop-save': return saveCrop();
    case 'photo-remove':
      if (!confirm('領収書の写真を外しますか？')) return;
      data.settings.receiptPhoto = null;
      await persist(); render(); toast('写真を外しました');
      return;
    case 'dismiss-split':
      data.settings.paymentSplitNotice = false;
      await persist(); return render();
    case 'reset-thanks':
      data.settings.receiptThanks = DEFAULT_THANKS;
      await persist(); render(); toast('ひと言を元に戻しました');
      return;
    case 'reset-greeting':
      data.settings.greeting = DEFAULT_GREETING;
      await persist(); render(); toast('あいさつ文を元に戻しました');
      return;
    case 'reset-rates':
      if (confirm('送料表を初期値に戻しますか？')) {
        data.settings.rates = clone(DEFAULT_RATES);
        await persist(); render(); toast('初期値に戻しました');
      }
      return;
    case 'change-pass': return doChangePass();
    case 'export': return doExport();
    case 'backup-share': return shareBackup();
    case 'import': return $('#import-file').click();
    case 'erase': return doErase();
    case 'check-update': return checkUpdate(true);
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
  if (['orderDate', 'notifiedDate', 'packedDate', 'shipDate', 'paidDate'].includes(el.dataset.input) && d) { d[el.dataset.input] = el.value; return updateTotals(); }
  if (el.dataset.input === 'reportTo') { view.to = el.value || today(); return updateReport(); }
  if (el.dataset.input === 'shippingFee') { d.shippingFee = num(el.value); return updateTotals(); }
  if (el.dataset.c) { d[el.dataset.c] = el.value; return; }
  if (el.dataset.r) { view.r[el.dataset.r] = el.value; return; }
  if (el.dataset.n === 'text') { view.text = el.value; const m = $('#notify-mail'); if (m) m.href = mailtoHref(el.value); return; }
  if (el.dataset.s && data) {
    setPath(data.settings, el.dataset.s, 'num' in el.dataset ? num(el.value) : el.value);
    scheduleSettingsSave();
    if (el.dataset.s === 'receiptThanks') { const btn = $('[data-action="reset-thanks"]'); if (btn) btn.disabled = el.value === DEFAULT_THANKS; }
    if (el.dataset.s === 'greeting') { const btn = $('[data-action="reset-greeting"]'); if (btn) btn.disabled = el.value === DEFAULT_GREETING; }
    if (el.dataset.s === 'reportStart') { const h = $('#report-start-hint'); if (h) h.textContent = `いま：${fmtDateJ(reportStart())}〜（終了日は集計画面で選べます。初めは今日）`; }
    return;
  }
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
  if (el.id === 'pphoto-file') {
    const file = el.files[0]; el.value = '';
    if (!file) return;
    try {
      toast('写真を取り込んでいます…');
      view.crop = { src: await shrinkPhoto(file), z: 1, isNew: true }; // 位置は中央から
      render();
    } catch (err) { toast(err.message || '写真を読み込めませんでした'); }
    return;
  }
  if (el.id === 'photo-file') {
    const file = el.files[0]; el.value = '';
    if (!file) return;
    try {
      toast('写真を取り込んでいます…');
      data.settings.receiptPhoto = { dataUrl: await shrinkPhoto(file), updatedAt: today() };
      await persist(); render(); toast('写真を設定しました。領収書の画面で確認できます');
    } catch (err) { toast(err.message || '写真を読み込めませんでした'); }
    return;
  }
  if (el.dataset.input === 'custMode') {
    d.custMode = el.value;
    const c = customerById(el.value);
    d.cust = c ? { name: c.name, prefecture: c.prefecture || '', postal: c.postal || '', address: c.address || '', phone: c.phone || '' }
      : { name: '', prefecture: '', postal: '', address: '', phone: '' };
    if (!d.id && c?.delivery) d.delivery = c.delivery; // 新規受注では前回の受け渡し方法を初期値に
    if (!d.id) d.payment = c?.payment || data.settings.defaultPayment || 'paypay'; // 支払い方法も同様
    return render();
  }
  if (el.dataset.input === 'reportTo') { view.to = el.value || today(); return updateReport(); }
  if (el.dataset.input === 'delivery') { d.delivery = el.value; return render(); }
  if (el.dataset.input === 'payment') { d.payment = el.value; return render(); }
  if (el.dataset.input === 'shippingAuto') { d.shippingAuto = el.checked; return render(); }
  if (el.dataset.input === 'combine') { d.combine = el.checked; return updateTotals(); }
  if (['orderDate', 'notifiedDate', 'packedDate', 'shipDate', 'paidDate'].includes(el.dataset.input)) { d[el.dataset.input] = el.value; return updateTotals(); }
  if (el.dataset.r) { view.r[el.dataset.r] = el.value; view.img = null; return render(); }
  if ('rPhoto' in el.dataset) { view.img = null; view.r.photo = el.checked; return render(); }
  if ('rPphoto' in el.dataset) { view.img = null; view.r.pphoto = el.checked; return render(); }
  if ('rThanks' in el.dataset) { view.img = null; view.r.thanks = el.checked; return render(); }
  if (el.dataset.input === 'paper') { data.settings.receiptPaper = el.value; await persist(); return render(); }
  if (el.dataset.s) {
    setPath(data.settings, el.dataset.s, 'num' in el.dataset ? num(el.value) : el.value);
    if (['receiptPhotoLayout', 'producerPhotoShape'].includes(el.dataset.s)) render();
    if (el.dataset.s === 'greeting') { const btn = $('[data-action="reset-greeting"]'); if (btn) btn.disabled = el.value === DEFAULT_GREETING; }
    await persist();
    toast('保存しました');
  }
});

// ---------- 起動 ----------
// ---------- 更新 ----------
// 新しい版が公開されたら、次に開いたとき（または画面に戻ったとき）に取り込みます。
// 入力途中の内容を消さないよう、自動で再読み込みはせず「タップで更新」を表示します。
let swReg = null;
// 最初のインストールで制御が始まったときは案内を出さない
let firstControl = !navigator.serviceWorker?.controller;

function showUpdateBanner() {
  if ($('#update-banner')) return;
  const el = document.createElement('button');
  el.id = 'update-banner';
  el.className = 'update-banner no-print';
  el.textContent = '新しい版があります。タップして更新';
  el.onclick = async () => { await saveChain; location.reload(); };
  document.body.appendChild(el);
}

async function checkUpdate(manual = false) {
  if (!swReg) { if (manual) toast('この画面では更新を確認できません'); return; }
  try {
    await swReg.update();
    if (swReg.installing || swReg.waiting) { if (manual) toast('新しい版を取り込んでいます…'); return; }
    // 版の番号をサーバーの app.js と比べる
    const res = await fetch('js/app.js', { cache: 'no-store' });
    const latest = (await res.text()).match(/APP_VERSION = '([^']+)'/)?.[1];
    if (latest && latest !== APP_VERSION) showUpdateBanner();
    else if (manual) toast(`最新の版です（版 ${APP_VERSION}）`);
  } catch { if (manual) toast('圏外のため確認できませんでした'); }
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => { swReg = reg; checkUpdate(); }).catch(() => {});
  // 新しい版の取り込みが終わったら案内を出す（初回インストール時は出さない）
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (firstControl) { firstControl = false; return; } showUpdateBanner(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
}
render();
