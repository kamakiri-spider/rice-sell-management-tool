// 端末内暗号化ストレージ
// パスコード → PBKDF2-SHA256 → AES-GCM 256bit 鍵。データ全体を暗号化して IndexedDB に保存します。
// 鍵はメモリ上にのみ保持され、どこにも送信・保存されません。

const DB_NAME = 'rice-orders';
const STORE = 'vault';
const RECORD_ID = 'main';
const ITERATIONS = 600000;
const te = new TextEncoder();
const td = new TextDecoder();

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req && req.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

const readRecord = () => idb('readonly', (s) => s.get(RECORD_ID));
const writeRecord = (rec) => idb('readwrite', (s) => s.put(rec, RECORD_ID));
export const eraseAll = () => idb('readwrite', (s) => s.delete(RECORD_ID));

async function deriveKey(passcode, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encrypt(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))));
  return { iv, ct };
}

async function decrypt(key, iv, ct) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(td.decode(pt));
}

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class Vault {
  constructor() { this.key = null; this.salt = null; this.iterations = ITERATIONS; }

  static async exists() { return !!(await readRecord()); }

  async create(passcode, initialData) {
    this.salt = crypto.getRandomValues(new Uint8Array(16));
    this.iterations = ITERATIONS;
    this.key = await deriveKey(passcode, this.salt, this.iterations);
    await this.save(initialData);
  }

  // パスコードが違うと AES-GCM の認証で失敗し、例外になります
  async unlock(passcode) {
    const rec = await readRecord();
    if (!rec) throw new Error('データがありません');
    const key = await deriveKey(passcode, rec.salt, rec.iterations);
    const data = await decrypt(key, rec.iv, rec.ct);
    this.key = key; this.salt = rec.salt; this.iterations = rec.iterations;
    return data;
  }

  async save(data) {
    if (!this.key) throw new Error('ロック中です');
    const { iv, ct } = await encrypt(this.key, data);
    await writeRecord({ v: 1, salt: this.salt, iterations: this.iterations, iv, ct, savedAt: Date.now() });
  }

  async changePasscode(newPasscode, data) {
    this.salt = crypto.getRandomValues(new Uint8Array(16));
    this.key = await deriveKey(newPasscode, this.salt, this.iterations);
    await this.save(data);
  }

  lock() { this.key = null; }

  // バックアップ：現在のパスコードで暗号化された JSON ファイル
  async exportBackup(data) {
    const { iv, ct } = await encrypt(this.key, data);
    return JSON.stringify({
      app: 'rice-orders', v: 1, exportedAt: new Date().toISOString(),
      salt: b64(this.salt), iterations: this.iterations, iv: b64(iv), ct: b64(ct),
    });
  }

  static async decryptBackup(text, passcode) {
    const o = JSON.parse(text);
    if (o.app !== 'rice-orders') throw new Error('このアプリのバックアップではありません');
    const key = await deriveKey(passcode, unb64(o.salt), o.iterations);
    return decrypt(key, unb64(o.iv), unb64(o.ct));
  }
}
