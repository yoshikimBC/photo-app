'use strict';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'photoapp.settings';
const SENT_KEY = 'photoapp.sent';
const SUBJECTS_KEY = 'photoapp.subjects';
const RETRY_MS = 30000;
const UPLOAD_TIMEOUT_MS = 180000;
const CHECK_START_MS = 15000;
const CHECK_EVERY_MS = 15000;
const CHECK_TIMEOUT_MS = 30000;
const DB_TIMEOUT_MS = 30000;
const REDUCED_LONG_SIDE = 2560;

const defaults = {
  useDate: true, useTime: true, useSubject: true, subject: '',
  folderMode: 'none', sizeMode: 'original', endpoint: '', token: ''
};

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch (e) {
    return fallback;
  }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 容量不足時は保持しない */ }
}

const settings = Object.assign({}, defaults, load(SETTINGS_KEY, {}));

// IndexedDB: 一覧表示で写真本体を読まないよう、情報と本体を別ストアに置く
let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('photoapp', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('queue', { keyPath: 'id' });
        req.result.createObjectStore('bodies');
      };
      req.onsuccess = () => {
        req.result.onclose = () => { dbPromise = null; };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
function tx(stores, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    // 接続が応答しなくなっても待ち続けず、次回は接続を作り直す
    const timer = setTimeout(() => {
      dbPromise = null;
      d.close();
      reject(new Error('端末内のデータが応答しません'));
    }, DB_TIMEOUT_MS);
    const fail = (err) => {
      clearTimeout(timer);
      reject(err);
    };
    try {
      const t = d.transaction(stores, mode);
      let result;
      fn(t, (v) => { result = v; });
      t.oncomplete = () => {
        clearTimeout(timer);
        resolve(result);
      };
      t.onerror = () => fail(t.error);
      t.onabort = () => fail(t.error);
    } catch (e) {
      dbPromise = null;
      fail(e);
    }
  }));
}
const enqueue = (meta, buffer) => tx(['queue', 'bodies'], 'readwrite', (t) => {
  t.objectStore('queue').put(meta);
  t.objectStore('bodies').put(buffer, meta.id);
});
const dequeue = (id) => tx(['queue', 'bodies'], 'readwrite', (t) => {
  t.objectStore('queue').delete(id);
  t.objectStore('bodies').delete(id);
});
const listQueue = () => tx(['queue'], 'readonly', (t, done) => {
  const r = t.objectStore('queue').getAll();
  r.onsuccess = () => done(r.result.sort((a, b) => a.createdAt - b.createdAt));
});
const readBody = (id) => tx(['bodies'], 'readonly', (t, done) => {
  const r = t.objectStore('bodies').get(id);
  r.onsuccess = () => done(r.result);
});

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d, sep) => [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join(sep);
const hms = (d) => pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
const clean = (s) => s.replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();

function buildName(s, date, ext, id) {
  const parts = [];
  if (s.useDate) parts.push(ymd(date, ''));
  if (s.useTime) parts.push(hms(date));
  const subject = clean(s.subject);
  if (s.useSubject && subject) parts.push(subject);
  if (!parts.length) parts.push('photo_' + id.slice(0, 8));
  return parts.join('_') + '.' + ext;
}

function buildSubfolder(s, date) {
  switch (s.folderMode) {
    case 'month': return ymd(date, '-').slice(0, 7);
    case 'day': return ymd(date, '-');
    case 'subject': return clean(s.subject);
    default: return '';
  }
}

function extOf(mime) {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp' }[mime] || 'jpg';
}

function reduce(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, REDUCED_LONG_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('縮小に失敗しました'))), 'image/jpeg', 0.88);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした'));
    };
    img.src = url;
  });
}

let lastUrl = null;
let lastId = null;
async function onCapture(file) {
  const date = new Date();
  // 縮小や保存の途中で画面の設定が変わっても、撮影時点の内容で名前を付ける
  const s = Object.assign({}, settings);
  const id = crypto.randomUUID ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  let blob = file;
  if (s.sizeMode === 'reduced') {
    try {
      blob = await reduce(file);
    } catch (e) {
      blob = file; // 縮小できない形式は写真を失わないよう元のまま残す
    }
  }
  const mime = blob.type || 'image/jpeg';
  const meta = {
    id, mime, createdAt: date.getTime(),
    name: buildName(s, date, extOf(mime), id),
    subfolder: buildSubfolder(s, date)
  };
  // 端末のファイル参照は後で無効になることがあるため、中身を複製して保存する
  await enqueue(meta, await blob.arrayBuffer());
  rememberSubject(s.subject);

  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(blob);
  $('last-img').src = lastUrl;
  $('last-name').textContent = meta.name;
  $('last').hidden = false;
  lastId = id;
  await render();
  flush();
}

function rememberSubject(subject) {
  const s = subject.trim();
  if (!s) return;
  const list = load(SUBJECTS_KEY, []).filter((x) => x !== s);
  list.unshift(s);
  save(SUBJECTS_KEY, list.slice(0, 20));
  renderSubjects();
}

function toBase64(buffer) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(new Blob([buffer]));
  });
}

async function post(payload, timeoutMs = CHECK_TIMEOUT_MS, ctrl = new AbortController()) {
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // text/plain にしないと Apps Script が受け付けない事前確認(CORS)が発生する
    const res = await fetch(settings.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || '保存に失敗しました');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function findSaved(item) {
  try {
    const r = await post({
      token: settings.token, check: true, id: item.id, name: item.name, subfolder: item.subfolder
    });
    return r.saved === true ? r : null;
  } catch (e) {
    return null;
  }
}

// 応答を受け取れない場合も、サーバーに保存の有無を問い合わせて結果を確定する
async function sendItem(item) {
  const startedAt = Date.now();
  progress = { id: item.id, startedAt, phase: 'upload' };
  render();
  const ctrl = new AbortController();
  let watchdog;
  try {
    if (attempted.has(item.id)) {
      const saved = await findSaved(item);
      if (saved) return saved;
    }
    attempted.add(item.id);
    const upload = post({
      token: settings.token, id: item.id, name: item.name,
      mime: item.mime, subfolder: item.subfolder, data: await toBase64(await readBody(item.id))
    }, UPLOAD_TIMEOUT_MS, ctrl);
    const confirmed = new Promise((resolve) => {
      let nextCheck = Date.now() + CHECK_START_MS;
      let checking = false;
      watchdog = setInterval(async () => {
        // 画面を閉じている間はタイマーが止まるため、実時間でも期限を判定する
        if (Date.now() - startedAt > UPLOAD_TIMEOUT_MS) ctrl.abort();
        renderStatus();
        if (checking || Date.now() < nextCheck) return;
        checking = true;
        const saved = await findSaved(item);
        checking = false;
        nextCheck = Date.now() + CHECK_EVERY_MS;
        if (saved) resolve(saved);
      }, 1000);
    });
    return await Promise.race([upload, confirmed]);
  } catch (e) {
    if (e.message === 'unauthorized') throw e;
    progress.phase = 'confirm';
    render();
    const saved = await findSaved(item);
    if (saved) return saved;
    throw e;
  } finally {
    clearInterval(watchdog);
    ctrl.abort();
    progress = null;
  }
}

function describeError(e) {
  if (e.message === 'unauthorized') return '合言葉が違います。設定を確認してください。';
  if (e.name === 'SyntaxError') return '送信先から想定外の応答がありました。保存は確認できていません。送信先URLを確認してください。';
  if (e.name === 'TypeError' || e.name === 'AbortError') {
    return navigator.onLine === false ? ''
      : '応答がなく、保存も確認できませんでした。自動で再送します(保存済みなら二重には保存しません)。';
  }
  return '送信エラー: ' + e.message;
}

let sending = false;
let progress = null;
let lastError = '';
const attempted = new Set();
async function flush() {
  if (sending) return;
  if (!settings.endpoint || !settings.token) {
    render();
    return;
  }
  sending = true;
  lastError = '';
  render();
  try {
    for (const item of await listQueue()) {
      const result = await sendItem(item);
      // サーバーの保存完了を確認してから端末側を消す
      await dequeue(item.id);
      addSent(result.name || item.name);
      await render();
    }
  } catch (e) {
    lastError = describeError(e);
  } finally {
    sending = false;
    render();
  }
}

function addSent(name) {
  const list = load(SENT_KEY, []);
  list.unshift({ name, at: Date.now() });
  save(SENT_KEY, list.slice(0, 20));
}

function fillList(ul, names, emptyText) {
  ul.replaceChildren();
  if (!names.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    ul.append(li);
    return;
  }
  for (const n of names) {
    const li = document.createElement('li');
    li.textContent = n;
    ul.append(li);
  }
}

function setState(el, text, cls) {
  el.textContent = text;
  el.classList.remove('ok', 'warn', 'error');
  if (cls) el.classList.add(cls);
}

const stamp = (at) => {
  const d = new Date(at);
  return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
};

let queueIds = [];
function renderStatus() {
  const n = queueIds.length;
  const el = $('status');
  if (!n) setState(el, '全て送信済み', 'ok');
  else if (progress && progress.phase === 'confirm') setState(el, '保存を確認中 残り' + n + '件');
  else if (progress) setState(el, '送信中 残り' + n + '件(' + Math.floor((Date.now() - progress.startedAt) / 1000) + '秒)');
  else if (sending) setState(el, '送信中 残り' + n + '件');
  else if (!settings.endpoint || !settings.token) setState(el, '未送信 ' + n + '件(未設定)', 'warn');
  else if (navigator.onLine === false) setState(el, '未送信 ' + n + '件(圏外)', 'warn');
  else if (lastError) setState(el, '送信失敗 ' + n + '件', 'error');
  else setState(el, '未送信 ' + n + '件(再送待ち)', 'warn');

  if (!lastId) return;
  const state = $('last-state');
  if (!queueIds.includes(lastId)) setState(state, '送信完了(Driveへの保存を確認済み)', 'ok');
  else if (progress && progress.id === lastId) setState(state, progress.phase === 'confirm' ? '保存を確認中' : '送信中');
  else setState(state, '未送信', lastError ? 'error' : 'warn');
}

let renderSeq = 0;
async function render() {
  // 古い描画が新しい描画を上書きしないようにする
  const seq = ++renderSeq;
  let queue;
  try {
    queue = await listQueue();
  } catch (e) {
    if (seq === renderSeq) setState($('status'), '状態を確認できません', 'error');
    return;
  }
  if (seq !== renderSeq) return;
  queueIds = queue.map((q) => q.id);
  fillList($('queue'), queue.map((q) => q.name), 'ありません');
  fillList($('sent'), load(SENT_KEY, []).map((s) => stamp(s.at) + ' ' + s.name), 'ありません');
  $('retry').hidden = !queue.length;
  $('retry').disabled = sending;

  const configured = settings.endpoint && settings.token;
  let notice = '';
  if (!configured) notice = '送信先URLと合言葉が未設定です。撮影した写真は端末に保存され、設定後に送信します。';
  else if (lastError) notice = lastError;
  $('notice').textContent = notice;
  $('notice').hidden = !notice;

  renderStatus();

  $('name-preview').textContent = buildName(settings, new Date(), 'jpg', 'xxxxxxxx');
}

function renderSubjects() {
  const dl = $('subject-history');
  dl.replaceChildren();
  for (const s of load(SUBJECTS_KEY, [])) {
    const o = document.createElement('option');
    o.value = s;
    dl.append(o);
  }
}

function bind(id, key, prop, event) {
  const el = $(id);
  el[prop] = settings[key];
  el.addEventListener(event, () => {
    settings[key] = el[prop];
    save(SETTINGS_KEY, settings);
    render();
  });
}

bind('subject', 'subject', 'value', 'input');
bind('use-date', 'useDate', 'checked', 'change');
bind('use-time', 'useTime', 'checked', 'change');
bind('use-subject', 'useSubject', 'checked', 'change');
bind('folder-mode', 'folderMode', 'value', 'change');
bind('size-mode', 'sizeMode', 'value', 'change');
bind('endpoint', 'endpoint', 'value', 'input');
bind('token', 'token', 'value', 'input');

$('camera').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    await onCapture(file);
  } catch (e) {
    alert('写真を端末に保存できませんでした: ' + e.message);
  } finally {
    ev.target.value = '';
  }
});

$('retry').addEventListener('click', flush);

$('ping').addEventListener('click', async () => {
  const out = $('ping-result');
  out.textContent = '確認中...';
  try {
    await post({ token: settings.token, ping: true });
    out.textContent = '接続できました。';
    flush();
  } catch (e) {
    out.textContent = e.message === 'unauthorized' ? '合言葉が違います。' : '接続できませんでした: ' + e.message;
  }
});

window.addEventListener('online', flush);
window.addEventListener('offline', render);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) flush();
});
setInterval(flush, RETRY_MS);

if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

renderSubjects();
render().then(flush);
