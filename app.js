'use strict';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'photoapp.settings';
const SENT_KEY = 'photoapp.sent';
const RETRY_MS = 30000;
const UPLOAD_TIMEOUT_MS = 180000;
const CHECK_START_MS = 15000;
const CHECK_EVERY_MS = 15000;
const CHECK_TIMEOUT_MS = 30000;
const DB_TIMEOUT_MS = 30000;
const REDUCED_LONG_SIDE = 2560;

const defaults = {
  useDate: true, useTime: true,
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
// 件名別フォルダは件名の廃止で選べなくなった
if (settings.folderMode === 'subject') settings.folderMode = 'none';

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
const updateMeta = (meta) => tx(['queue'], 'readwrite', (t) => {
  t.objectStore('queue').put(meta);
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

// 送信ボタンが押された写真だけを送る。ready が無いのは自動送信だった旧版の未送信分
const isReady = (item) => item.ready !== false;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d, sep) => [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join(sep);
const hms = (d) => pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
const clean = (s) => s.replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();

function buildStem(s, date, id) {
  const parts = [];
  if (s.useDate) parts.push(ymd(date, ''));
  if (s.useTime) parts.push(hms(date));
  if (!parts.length) parts.push('photo_' + id.slice(0, 8));
  return parts.join('_');
}

function buildSubfolder(s, date) {
  switch (s.folderMode) {
    case 'month': return ymd(date, '-').slice(0, 7);
    case 'day': return ymd(date, '-');
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
  const stem = buildStem(s, date, id);
  const meta = {
    id, mime, createdAt: date.getTime(), ready: false,
    stem, defaultStem: stem, ext: extOf(mime),
    name: stem + '.' + extOf(mime),
    subfolder: buildSubfolder(s, date)
  };
  // 端末のファイル参照は後で無効になることがあるため、中身を複製して保存する
  await enqueue(meta, await blob.arrayBuffer());
  await render();
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
    // 送信中に押された分も続けて送るため、1枚ごとに読み直す
    for (;;) {
      const item = (await listQueue()).find(isReady);
      if (!item) break;
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

// 未送信の写真のファイル名を確定して、送信の対象にする
async function sendAll() {
  for (const item of await listQueue()) {
    if (isReady(item)) continue;
    const card = cards.get(item.id);
    const stem = (card && clean(card.input.value)) || clean(item.stem) || item.defaultStem;
    await updateMeta(Object.assign({}, item, { ready: true, stem, name: stem + '.' + item.ext }));
    if (card) card.input.value = stem;
  }
  await flush();
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

// 入力中のファイル名が消えないよう、カードは作り直さず写真ごとに使い回す
const cards = new Map();
function createCard(item) {
  const li = document.createElement('li');
  li.className = 'card';
  const img = document.createElement('img');
  img.alt = '撮影した写真';
  const body = document.createElement('div');
  body.className = 'card-body';
  const field = document.createElement('label');
  field.className = 'name-field';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 100;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'ファイル名');
  input.value = item.stem || item.name.replace(/\.[^.]*$/, '');
  const ext = document.createElement('span');
  ext.textContent = '.' + (item.ext || item.name.split('.').pop());
  field.append(input, ext);
  const state = document.createElement('div');
  state.className = 'state';
  body.append(field, state);
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'secondary';
  del.textContent = '削除';
  li.append(img, body, del);

  input.addEventListener('input', async () => {
    const stem = clean(input.value);
    if (!stem) return;
    const current = (await listQueue()).find((q) => q.id === item.id);
    if (current && !isReady(current)) await updateMeta(Object.assign({}, current, { stem, name: stem + '.' + current.ext }));
  });
  del.addEventListener('click', async () => {
    if (!confirm('この写真を端末から削除します。よろしいですか。')) return;
    await dequeue(item.id);
    lastError = '';
    render();
  });

  const card = { li, input, state, del, url: null };
  readBody(item.id).then((buffer) => {
    if (!buffer || !cards.has(item.id)) return;
    card.url = URL.createObjectURL(new Blob([buffer], { type: item.mime }));
    img.src = card.url;
  }).catch(() => { /* 縮小表示なしでも送信はできる */ });
  return card;
}

function renderCards(queue) {
  const ul = $('photos');
  const ids = new Set(queue.map((q) => q.id));
  for (const [id, card] of cards) {
    if (ids.has(id)) continue;
    if (card.url) URL.revokeObjectURL(card.url);
    card.li.remove();
    cards.delete(id);
  }
  for (const item of queue) {
    let card = cards.get(item.id);
    if (!card) {
      card = createCard(item);
      cards.set(item.id, card);
      ul.append(card.li);
    }
    const current = progress && progress.id === item.id;
    card.input.disabled = isReady(item);
    card.del.disabled = !!current;
    if (current) setState(card.state, progress.phase === 'confirm' ? '保存を確認中' : '送信中');
    else if (!isReady(item)) setState(card.state, '未送信');
    else if (lastError) setState(card.state, '送信失敗', 'error');
    else setState(card.state, '送信待ち', 'warn');
  }
}

let readyCount = 0;
let draftCount = 0;
function renderStatus() {
  const el = $('status');
  const n = readyCount;
  if (!n && !draftCount) setState(el, '全て送信済み', 'ok');
  else if (!n) setState(el, '未送信 ' + draftCount + '件', 'warn');
  else if (progress && progress.phase === 'confirm') setState(el, '保存を確認中 残り' + n + '件');
  else if (progress) setState(el, '送信中 残り' + n + '件(' + Math.floor((Date.now() - progress.startedAt) / 1000) + '秒)');
  else if (sending) setState(el, '送信中 残り' + n + '件');
  else if (!settings.endpoint || !settings.token) setState(el, '送信待ち ' + n + '件(未設定)', 'warn');
  else if (navigator.onLine === false) setState(el, '送信待ち ' + n + '件(圏外)', 'warn');
  else if (lastError) setState(el, '送信失敗 ' + n + '件', 'error');
  else setState(el, '送信待ち ' + n + '件', 'warn');
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
  readyCount = queue.filter(isReady).length;
  draftCount = queue.length - readyCount;
  renderCards(queue);
  fillList($('sent'), load(SENT_KEY, []).map((s) => stamp(s.at) + ' ' + s.name), 'ありません');

  const send = $('send');
  send.hidden = !queue.length;
  send.textContent = '送信する(' + queue.length + '件)';
  send.disabled = sending && !draftCount;

  const configured = settings.endpoint && settings.token;
  let notice = '';
  if (!configured) notice = '送信先URLと合言葉が未設定です。設定後に送信できます。';
  else if (lastError) notice = lastError;
  $('notice').textContent = notice;
  $('notice').hidden = !notice;

  renderStatus();

  $('name-preview').textContent = buildStem(settings, new Date(), 'xxxxxxxx') + '.jpg';
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

bind('use-date', 'useDate', 'checked', 'change');
bind('use-time', 'useTime', 'checked', 'change');
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

$('send').addEventListener('click', () => {
  sendAll().catch((e) => {
    lastError = describeError(e);
    render();
  });
});

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

render().then(flush);
