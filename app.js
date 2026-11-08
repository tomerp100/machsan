'use strict';
/* ================= Storage (IndexedDB, one record) ================= */
const DB_NAME = 'machsan', STORE = 'kv', KEY = 'state';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function loadState() {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const t = db.transaction(STORE).objectStore(STORE).get(KEY);
      t.onsuccess = () => res(t.result || null);
      t.onerror = () => rej(t.error);
    });
  } catch (e) { console.warn(e); return null; }
}
async function saveState() {
  try {
    const db = await idb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(S, KEY);
  } catch (e) { console.warn(e); toast('שגיאה בשמירה'); }
}

const DEFAULT_STATE = () => ({
  products: [],      // {id,name,barcode,category,unit,pack,perPack,min,qty}
  moves: [],         // {id,pid,type:'in'|'out'|'count'|'edit',delta,after,ts,note}
  counts: [],        // {id,ts,lines:[{pid,name,expected,counted}]}
  countDraft: null,  // {startedAt, lines:{pid:{packs,units}}}
  settings: { apiKey: '' },
});
let S = DEFAULT_STATE();

/* ================= Helpers ================= */
const $ = (s, el = document) => el.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
const byId = (id) => S.products.find(p => p.id === id);
const byBarcode = (code) => S.products.find(p => p.barcode && p.barcode === String(code).trim());
const isLow = (p) => p.min > 0 && p.qty <= p.min;
// keep +/- signs on the correct side inside Hebrew text
const signed = (n) => '⁦' + (n > 0 ? '+' : '') + n + '⁩';
const fmtDate = (ts) => new Date(ts).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function fmtQty(p, n = p.qty) {
  const per = p.perPack > 1 ? p.perPack : 0;
  if (!per) return `${n} ${p.unit}`;
  const packs = Math.floor(n / per), units = n - packs * per;
  const parts = [];
  if (packs) parts.push(`${packs} ${p.pack}`);
  if (units || !packs) parts.push(`${units} ${p.unit}`);
  return parts.join(' + ');
}

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

/* ================= Mutations ================= */
function addMove(p, type, delta, note = '') {
  p.qty = Math.max(0, p.qty + delta);
  S.moves.push({ id: uid(), pid: p.id, type, delta, after: p.qty, ts: Date.now(), note });
  saveState(); updateBadge();
}

/* ================= Sheet (bottom modal) ================= */
let onSheetClose = null;
function openSheet(html, onClose) {
  // fresh element each time so listeners from the previous sheet don't pile up
  const old = $('#sheet'), sh = old.cloneNode(false);
  old.replaceWith(sh);
  sh.innerHTML = `<div class="grip"></div>${html}`;
  sh.hidden = false; $('#backdrop').hidden = false;
  onSheetClose = onClose || null;
  sh.scrollTop = 0;
  return sh;
}
function closeSheet() {
  $('#sheet').hidden = true; $('#backdrop').hidden = true; $('#sheet').innerHTML = '';
  const cb = onSheetClose; onSheetClose = null; cb?.();
}
$('#backdrop').addEventListener('click', closeSheet);

/* ================= Navigation ================= */
let tab = 'inventory';
const TITLES = { inventory: 'מלאי', scan: 'צילום מחסן', count: 'ספירת מלאי', low: 'חסרים במלאי', settings: 'הגדרות' };
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab);
});
function go(t) {
  tab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  $('#title').textContent = TITLES[t];
  $('#topActions').innerHTML = '';
  render();
  window.scrollTo(0, 0);
}
function render() {
  ({ inventory: renderInventory, scan: renderScan, count: renderCount, low: renderLow, settings: renderSettings })[tab]();
}
function updateBadge() {
  const n = S.products.filter(isLow).length, b = $('#lowBadge');
  b.hidden = !n; b.textContent = n;
}

/* ================= Inventory ================= */
let invSearch = '', invCat = '';
function categories() { return [...new Set(S.products.map(p => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he')); }

function renderInventory() {
  $('#topActions').innerHTML = `<button class="btn small primary" id="addBtn">+ מוצר</button>`;
  $('#addBtn').onclick = () => productForm();
  const v = $('#view');
  if (!S.products.length) {
    v.innerHTML = `<div class="empty"><div class="big">📦</div><p>עדיין אין מוצרים.</p>
      <div class="stack"><button class="btn primary block" id="e1">הוסף מוצר ראשון</button>
      <button class="btn block" id="e2">📷 צלם מדף, והמוצרים יתווספו לבד</button>
      <button class="btn block" id="e3">טען מוצרים לדוגמה (מסעדה)</button></div></div>`;
    $('#e1').onclick = () => productForm();
    $('#e2').onclick = () => go('scan');
    $('#e3').onclick = loadDemo;
    return;
  }
  const cats = categories();
  v.innerHTML = `
    <input type="search" id="q" placeholder="חיפוש מוצר או ברקוד…" value="${esc(invSearch)}">
    <div class="chips" id="cats">
      <button class="chip ${!invCat ? 'active' : ''}" data-c="">הכל (${S.products.length})</button>
      ${cats.map(c => `<button class="chip ${invCat === c ? 'active' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>
    <div class="list" id="plist"></div>`;
  $('#q').oninput = (e) => { invSearch = e.target.value; drawList(); };
  $('#cats').onclick = (e) => { const c = e.target.closest('[data-c]'); if (!c) return; invCat = c.dataset.c; renderInventory(); };
  drawList();
}
function drawList() {
  const q = invSearch.trim().toLowerCase();
  const items = S.products
    .filter(p => !invCat || p.category === invCat)
    .filter(p => !q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q))
    .sort((a, b) => (isLow(b) - isLow(a)) || a.name.localeCompare(b.name, 'he'));
  const el = $('#plist');
  el.innerHTML = items.length ? items.map(itemHtml).join('') : `<p class="muted center">לא נמצאו מוצרים</p>`;
  el.onclick = (e) => { const it = e.target.closest('[data-id]'); if (it) productSheet(it.dataset.id); };
}
function itemHtml(p) {
  return `<button class="item ${isLow(p) ? 'low' : ''}" data-id="${p.id}">
    <div class="main"><div class="name">${esc(p.name)} ${isLow(p) ? '<span class="tag">נמוך</span>' : ''}</div>
      <div class="sub">${esc(p.category || 'ללא קטגוריה')}${p.min ? ` · מינימום ${p.min}` : ''}</div></div>
    <div class="qty">${esc(fmtQty(p))}${p.perPack > 1 ? `<small>סה״כ ${p.qty} ${esc(p.unit)}</small>` : ''}</div>
  </button>`;
}

function productSheet(id) {
  const p = byId(id); if (!p) return;
  const moves = S.moves.filter(m => m.pid === id).slice(-8).reverse();
  const TYPE = { in: 'קליטה', out: 'הוצאה', count: 'ספירה', edit: 'עדכון' };
  const sh = openSheet(`
    <h2>${esc(p.name)}</h2>
    <div class="card stack">
      <div class="row"><span class="grow muted">במלאי</span><b style="font-size:20px">${esc(fmtQty(p))}</b></div>
      ${p.perPack > 1 ? `<div class="row small"><span class="grow muted">סה״כ יחידות</span><span>${p.qty} ${esc(p.unit)}</span></div>
      <div class="row small"><span class="grow muted">אריזה</span><span>${esc(p.pack)} = ${p.perPack} ${esc(p.unit)}</span></div>` : ''}
      <div class="row small"><span class="grow muted">מינימום</span><span>${p.min || '—'}</span></div>
    </div>
    <div class="grid2" style="margin-top:12px">
      <button class="btn in" id="bIn">＋ קליטה</button>
      <button class="btn out" id="bOut">－ הוצאה</button>
    </div>
    <div class="grid2" style="margin-top:8px">
      <button class="btn" id="bEdit">✏️ עריכה</button>
      <button class="btn danger" id="bDel">🗑️ מחיקה</button>
    </div>
    <h3>תנועות אחרונות</h3>
    <div class="moves">${moves.length ? moves.map(m => `<div><span>${TYPE[m.type] || m.type} ${signed(m.delta)}</span><span class="muted">${fmtDate(m.ts)}</span></div>`).join('') : '<p class="muted">אין תנועות</p>'}</div>
  `);
  $('#bIn', sh).onclick = () => qtySheet(p, 'in');
  $('#bOut', sh).onclick = () => qtySheet(p, 'out');
  $('#bEdit', sh).onclick = () => productForm(p);
  $('#bDel', sh).onclick = () => {
    if (!confirm(`למחוק את "${p.name}"?`)) return;
    S.products = S.products.filter(x => x.id !== p.id);
    if (S.countDraft) delete S.countDraft.lines[p.id];
    saveState(); updateBadge(); closeSheet(); render();
  };
}

/* ---- quantity sheet: in / out / count ---- */
function qtySheet(p, mode, onDone) {
  const per = p.perPack > 1 ? p.perPack : 0;
  const draft = mode === 'count' && S.countDraft?.lines[p.id];
  const LABEL = { in: 'קליטת סחורה', out: 'הוצאת סחורה', count: 'ספירה' };
  const stepper = (key, label, val) => `
    <label class="field"><span>${label}</span>
      <div class="stepper"><button type="button" data-step="${key}" data-d="-1">−</button>
      <input type="number" inputmode="numeric" min="0" id="${key}" value="${val}">
      <button type="button" data-step="${key}" data-d="1">+</button></div></label>`;
  const sh = openSheet(`
    <h2>${LABEL[mode]}: ${esc(p.name)}</h2>
    <p class="muted small">במלאי כרגע: ${esc(fmtQty(p))}${per ? ` (${p.qty} ${esc(p.unit)})` : ''}</p>
    <div class="stack">
      ${per ? stepper('qPacks', `${p.pack} סגור (${per} ${p.unit})`, draft ? draft.packs : (mode === 'count' ? 0 : 1)) : ''}
      ${stepper('qUnits', per ? `${p.unit} בודדים` : p.unit, draft ? draft.units : (per || mode === 'count' ? 0 : 1))}
      ${mode === 'count' ? `<button class="btn block" id="bPhoto">📷 ספור מתמונה (AI)</button>` : ''}
      <div class="notice" id="qSum"></div>
      <button class="btn block ${mode === 'out' ? 'out' : mode === 'in' ? 'in' : 'primary'}" id="qOk">אישור</button>
    </div>`, onDone);
  const total = () => (per ? num($('#qPacks', sh).value) * per : 0) + num($('#qUnits', sh).value);
  const sum = () => {
    const t = total();
    $('#qSum', sh).textContent = mode === 'count'
      ? `נספר: ${t} ${p.unit} · הפרש ממלאי: ${signed(t - p.qty)}`
      : `${mode === 'in' ? 'יתווספו' : 'יורדו'} ${t} ${p.unit} → אחרי: ${Math.max(0, p.qty + (mode === 'in' ? t : -t))}`;
  };
  sh.addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]'); if (!b) return;
    const inp = $('#' + b.dataset.step, sh); inp.value = Math.max(0, num(inp.value) + +b.dataset.d); sum();
  });
  sh.addEventListener('input', sum);
  sum();
  if (mode === 'count') $('#bPhoto', sh).onclick = () => photoCount(p, (r) => {
    if (per) $('#qPacks', sh).value = r.packs;
    $('#qUnits', sh).value = r.units; sum();
  });
  $('#qOk', sh).onclick = () => {
    const t = total();
    if (mode === 'count') {
      startCountIfNeeded();
      S.countDraft.lines[p.id] = { packs: per ? num($('#qPacks', sh).value) : 0, units: num($('#qUnits', sh).value) };
      saveState(); toast(`נרשם בספירה: ${p.name} = ${t}`);
    } else {
      if (!t) return toast('הכנס כמות');
      if (mode === 'out' && t > p.qty && !confirm(`במלאי רשומים רק ${p.qty}. להוריד בכל זאת? (המלאי יתאפס)`)) return;
      addMove(p, mode, mode === 'in' ? t : -t);
      toast(`${mode === 'in' ? 'נקלטו' : 'הוצאו'} ${t} ${p.unit} · ${p.name}`);
    }
    closeSheet(); if (tab !== 'scan') render();
  };
}

/* ---- product create / edit ---- */
function productForm(p = null, presetBarcode = '', onDone) {
  const isNew = !p;
  p = p || { name: '', barcode: presetBarcode, category: invCat || '', unit: 'יחידה', pack: 'ארגז', perPack: 1, min: 0, qty: 0 };
  const cats = categories();
  const sh = openSheet(`
    <h2>${isNew ? 'מוצר חדש' : 'עריכת מוצר'}</h2>
    <form id="pf" class="stack">
      <label class="field"><span>שם המוצר *</span><input type="text" name="name" required value="${esc(p.name)}" placeholder="לדוגמה: קולה זכוכית 330"></label>
      <label class="field"><span>קטגוריה</span><input type="text" name="category" list="catlist" value="${esc(p.category)}" placeholder="שתייה / חד״פ / ניקיון…">
        <datalist id="catlist">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <div class="grid2">
        <label class="field"><span>שם יחידה</span><input type="text" name="unit" value="${esc(p.unit)}" placeholder="בקבוק / חבילה"></label>
        <label class="field"><span>שם אריזה</span><input type="text" name="pack" value="${esc(p.pack)}" placeholder="ארגז / קרטון"></label>
      </div>
      <div class="grid2">
        <label class="field"><span>יחידות באריזה</span><input type="number" inputmode="numeric" min="1" name="perPack" value="${p.perPack}"></label>
        <label class="field"><span>מינימום להתראה</span><input type="number" inputmode="numeric" min="0" name="min" value="${p.min}"></label>
      </div>
      ${isNew ? `<label class="field"><span>כמות התחלתית (ביחידות)</span><input type="number" inputmode="numeric" min="0" name="qty" value="0"></label>` : ''}
      <p class="muted small">טיפ: אם בארגז סגור יש 24 בקבוקים, כתוב 24 ב"יחידות באריזה". המינימום נספר ביחידות.</p>
      <button class="btn primary block" type="submit">שמירה</button>
    </form>`, onDone);
  $('#pf', sh).onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const barcode = p.barcode || '';
    const data = {
      name: String(f.get('name')).trim(), category: String(f.get('category') || '').trim(), barcode,
      unit: String(f.get('unit') || '').trim() || 'יחידה', pack: String(f.get('pack') || '').trim() || 'ארגז',
      perPack: Math.max(1, num(f.get('perPack'))), min: num(f.get('min')),
    };
    if (!data.name) return;
    if (isNew) {
      const np = { id: uid(), ...data, qty: 0 };
      S.products.push(np);
      const q = num(f.get('qty')); if (q) addMove(np, 'in', q, 'כמות התחלתית');
      toast('המוצר נוסף');
    } else {
      Object.assign(p, data); toast('נשמר');
    }
    saveState(); updateBadge(); closeSheet(); if (tab !== 'scan') render();
  };
}

/* ================= Shelf photos → inventory (Claude vision) ================= */
// A session holds the photos taken in this round and what Claude found in each one.
// Each photo should show a different shelf section; results from all photos are summed per product.
let shelf = { photos: [] }; // {id, thumb, status:'busy'|'done'|'error', error, items:[...], note}

const SHELF_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          existing_id: { type: 'string', description: 'id from the existing product list if this is the same product, otherwise empty string' },
          name_he: { type: 'string', description: 'Short product name in Hebrew (brand + type + size if visible)' },
          category_he: { type: 'string', description: 'Category in Hebrew, e.g. שתייה, חד״פ, ניקיון, יבשים, שימורים' },
          unit_he: { type: 'string', description: 'Name of a single unit in Hebrew, e.g. בקבוק, פחית, חבילה, גליל' },
          pack_he: { type: 'string', description: 'Name of the closed pack in Hebrew, e.g. ארגז, שישייה, קרטון. Empty if none visible' },
          units_per_pack: { type: 'integer', description: 'Units inside one closed pack if known or printed, else 0' },
          closed_packs: { type: 'integer', description: 'Number of closed/sealed packs of this product' },
          loose_units: { type: 'integer', description: 'Number of individual units NOT inside closed packs' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          note_he: { type: 'string', description: 'Short Hebrew note if something is hidden, stacked or uncertain; else empty' },
        },
        required: ['existing_id', 'name_he', 'category_he', 'unit_he', 'pack_he', 'units_per_pack', 'closed_packs', 'loose_units', 'confidence', 'note_he'],
        additionalProperties: false,
      },
    },
    photo_note_he: { type: 'string', description: 'One short Hebrew sentence about the photo quality / what could not be counted' },
  },
  required: ['items', 'photo_note_he'],
  additionalProperties: false,
};

async function analyzeShelf(img) {
  const client = await getClient();
  const known = S.products.map(p => ({ id: p.id, name: p.name, unit: p.unit, pack: p.pack, units_per_pack: p.perPack }));
  const prompt = `This is a photo of one shelf section in a restaurant storeroom. Build a stock count from it.

Identify every distinct product you can see (drinks, disposables like napkins/straws/wipes/cups, cleaning supplies, dry goods, etc.) and count each one.
- Count closed/sealed packs (cases, six-packs, cartons, shrink-wrapped bundles) as closed_packs and do NOT add their contents to loose_units.
- Count individual items outside closed packs as loose_units. Count carefully, row by row and layer by layer.
- If items are hidden behind or under others, count what you can reasonably infer from the visible arrangement (e.g. a full row going back) and explain in note_he; lower the confidence.
- Read labels to tell products apart (brand, flavour, size). Different sizes/flavours are different products.
- Do not list shelves, walls, or non-stock objects.

Existing products in this storeroom (reuse the exact id when it is the same product, so counts line up):
${known.length ? JSON.stringify(known) : '(none yet - use empty existing_id for everything)'}

All names and notes must be in Hebrew.`;
  const resp = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SHELF_SCHEMA } },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.b64 } },
      { type: 'text', text: prompt },
    ] }],
  });
  if (resp.stop_reason === 'refusal') throw new Error('REFUSAL');
  if (resp.stop_reason === 'max_tokens') throw new Error('TOO_MANY');
  const r = JSON.parse(resp.content.find(b => b.type === 'text')?.text || '{}');
  const items = (r.items || []).map(it => ({
    ...it,
    existing_id: byId(it.existing_id) ? it.existing_id : '',
    closed_packs: Math.max(0, it.closed_packs | 0),
    loose_units: Math.max(0, it.loose_units | 0),
    units_per_pack: Math.max(0, it.units_per_pack | 0),
  })).filter(it => it.closed_packs + it.loose_units > 0);
  return { items, note: r.photo_note_he || '' };
}

function errText(err) {
  return err.message === 'NO_KEY' ? 'צריך מפתח API (למטה)'
    : err.message === 'REFUSAL' ? 'הבקשה נדחתה, נסה תמונה אחרת'
    : err.message === 'TOO_MANY' ? 'יותר מדי מוצרים בתמונה אחת. צלם חלק קטן יותר של המדף'
    : err.status === 401 ? 'מפתח ה-API לא תקין'
    : err.status === 429 ? 'יותר מדי בקשות, נסה שוב בעוד דקה'
    : !navigator.onLine ? 'אין אינטרנט'
    : 'שגיאה: ' + (err.message || err);
}

async function addShelfPhotos(files) {
  for (const file of files) {
    const ph = { id: uid(), thumb: '', status: 'busy', items: [], note: '' };
    shelf.photos.push(ph);
    let img;
    try {
      img = await resizeToJpeg(file);
      ph.thumb = await thumbOf(img.dataUrl);
    } catch { ph.status = 'error'; ph.error = 'לא הצלחתי לקרוא את התמונה'; continue; }
    drawShelf();
    analyzeShelf(img).then(r => { ph.items = r.items; ph.note = r.note; ph.status = 'done'; })
      .catch(err => { console.warn(err); ph.status = 'error'; ph.error = errText(err); })
      .finally(() => { if (tab === 'scan') drawShelf(); });
  }
  drawShelf();
}
function thumbOf(dataUrl) {
  return new Promise(res => {
    const im = new Image();
    im.onload = () => {
      const s = 160 / Math.max(im.width, im.height), c = document.createElement('canvas');
      c.width = im.width * s; c.height = im.height * s;
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      res(c.toDataURL('image/jpeg', 0.7));
    };
    im.src = dataUrl;
  });
}

// Sum results across photos, one row per product.
let shelfRows = []; // {key, pid, name, category, unit, pack, perPack, packs, units, include, conf, notes:[]}
function buildRows() {
  const prev = new Map(shelfRows.map(r => [r.key, r]));
  const map = new Map();
  shelf.photos.filter(p => p.status === 'done').forEach(ph => ph.items.forEach(it => {
    const key = it.existing_id || 'new:' + it.name_he.trim();
    let r = map.get(key);
    if (!r) {
      const p = byId(it.existing_id);
      r = { key, pid: it.existing_id, name: p ? p.name : it.name_he.trim(), category: p ? p.category : it.category_he,
        unit: p ? p.unit : (it.unit_he || 'יחידה'), pack: p ? p.pack : (it.pack_he || 'ארגז'),
        perPack: p ? p.perPack : Math.max(1, it.units_per_pack || 1), packs: 0, units: 0, include: true, conf: 'high', notes: [] };
      map.set(key, r);
    }
    r.packs += it.closed_packs; r.units += it.loose_units;
    if (it.confidence === 'low' || (it.confidence === 'medium' && r.conf === 'high')) r.conf = it.confidence;
    if (it.note_he) r.notes.push(it.note_he);
  }));
  // keep the user's edits for rows that are still there
  shelfRows = [...map.values()].map(r => {
    const o = prev.get(r.key);
    return o && o.edited ? { ...r, packs: o.packs, units: o.units, include: o.include, name: o.name, pid: o.pid, perPack: o.perPack, edited: true } : r;
  });
}
const rowTotal = (r) => r.packs * Math.max(1, r.perPack) + r.units;

function renderScan() {
  const v = $('#view');
  const hasKey = !!S.settings.apiKey?.trim();
  v.innerHTML = `
    ${hasKey ? '' : keySetupHtml()}
    <div class="card stack">
      <b>📷 צלם את המחסן, והאפליקציה תספור לבד</b>
      <p class="small muted">צלם כל מדף (או חלק ממדף) בתמונה נפרדת. ה-AI מזהה את המוצרים וסופר ארגזים סגורים ויחידות. בסוף אתה בודק ומאשר.</p>
      <input type="file" accept="image/*" capture="environment" id="shCam" hidden>
      <input type="file" accept="image/*" multiple id="shGal" hidden>
      <button class="btn primary block" id="shTake" style="min-height:60px;font-size:18px" ${hasKey ? '' : 'disabled'}>📷 צלם מדף</button>
      <button class="btn block" id="shPick" ${hasKey ? '' : 'disabled'}>🖼️ בחר תמונות מהגלריה</button>
      <details class="small muted"><summary>טיפים לספירה מדויקת</summary>
        <ul style="margin:6px 0;padding-inline-start:18px">
          <li>אור טוב, מצלמים ישר מול המדף ולא בזווית.</li>
          <li>מדף אחד בכל תמונה. לא לצלם את אותו מקום פעמיים, אחרת הוא ייספר פעמיים.</li>
          <li>אם יש מוצרים מאחור שלא רואים, הוצא שורה קדימה או צלם מלמעלה.</li>
          <li>שיהיה אפשר לקרוא את התוויות, כדי שהמוצרים יזוהו נכון.</li>
        </ul></details>
    </div>
    <div id="shPhotos"></div>
    <div id="shRows"></div>`;
  if (!hasKey) bindKeySetup(renderScan);
  $('#shTake').onclick = () => $('#shCam').click();
  $('#shPick').onclick = () => $('#shGal').click();
  const onFiles = (e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; if (fs.length) addShelfPhotos(fs); };
  $('#shCam').onchange = onFiles; $('#shGal').onchange = onFiles;
  drawShelf();
}

function drawShelf() {
  const pe = $('#shPhotos'), re = $('#shRows'); if (!pe || !re) return;
  if (!shelf.photos.length) { pe.innerHTML = ''; re.innerHTML = ''; return; }
  const busy = shelf.photos.filter(p => p.status === 'busy').length;
  pe.innerHTML = `<h2>תמונות (${shelf.photos.length})${busy ? ` · סופר ${busy}… ⏳` : ''}</h2>
    <div class="photos">${shelf.photos.map(ph => `
      <div class="ph ${ph.status}">
        ${ph.thumb ? `<img src="${ph.thumb}" alt="">` : '<div class="noimg"></div>'}
        <div class="phs">${ph.status === 'busy' ? '⏳ סופר…' : ph.status === 'error' ? `⚠️ ${esc(ph.error)}` : `✓ ${ph.items.length} מוצרים`}</div>
        <button class="phx" data-rm="${ph.id}" aria-label="הסר">✕</button>
      </div>`).join('')}</div>
    ${shelf.photos.filter(p => p.note && p.status === 'done').map(p => `<p class="small muted">• ${esc(p.note)}</p>`).join('')}`;
  pe.onclick = (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    shelf.photos = shelf.photos.filter(p => p.id !== b.dataset.rm); drawShelf();
  };
  buildRows();
  if (!shelfRows.length) { re.innerHTML = busy ? '' : '<p class="muted center">לא זוהו מוצרים עדיין</p>'; return; }
  const opts = (sel) => `<option value="">➕ מוצר חדש</option>` + S.products.slice().sort((a, b) => a.name.localeCompare(b.name, 'he'))
    .map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  re.innerHTML = `<h2>מה נמצא (${shelfRows.length} מוצרים)</h2>
    <p class="small muted">בדוק ותקן אם צריך. "קיים במערכת" אומר שהמוצר כבר מוכר והכמות שלו תתעדכן. מוצרים חדשים ייווצרו.</p>
    <div class="list">${shelfRows.map((r, i) => {
      const p = byId(r.pid), t = rowTotal(r);
      return `<div class="countrow ${r.include ? 'done' : ''}" data-i="${i}">
        <div class="row"><input type="checkbox" data-f="include" ${r.include ? 'checked' : ''} style="width:22px;height:22px">
          <input class="grow" type="text" data-f="name" value="${esc(r.name)}" ${p ? 'readonly' : ''} style="min-height:40px;font-weight:600"></div>
        <div class="row small" style="margin-top:6px"><select data-f="pid" style="min-height:38px">${opts(r.pid)}</select></div>
        <div class="inputs" style="grid-template-columns:1fr 1fr 1fr">
          <label><span>${esc(r.pack)} סגור</span><input type="number" inputmode="numeric" min="0" data-f="packs" value="${r.packs}"></label>
          <label><span>${esc(r.unit)} בודדים</span><input type="number" inputmode="numeric" min="0" data-f="units" value="${r.units}"></label>
          <label><span>ב${esc(r.pack)}</span><input type="number" inputmode="numeric" min="1" data-f="perPack" value="${r.perPack}"></label>
        </div>
        <div class="small" style="margin-top:6px">סה״כ <b>${t}</b> ${esc(r.unit)}${p ? ` · במערכת ${p.qty} · הפרש <span class="${t - p.qty > 0 ? 'diff-pos' : t - p.qty < 0 ? 'diff-neg' : ''}">${signed(t - p.qty)}</span>` : ' · <span class="tag" style="background:var(--accent);color:var(--accent-text)">חדש</span>'}
          ${r.conf !== 'high' ? ` · <span class="diff-neg">ודאות ${r.conf === 'low' ? 'נמוכה' : 'בינונית'}</span>` : ''}</div>
        ${r.notes.length ? `<div class="small muted">${esc(r.notes.join(' · '))}</div>` : ''}
      </div>`;
    }).join('')}</div>
    <div class="notice" style="margin-top:12px">המלאי של המוצרים המסומנים יעודכן לכמות שנספרה. מוצרים שלא צולמו יישארו כמו שהם.</div>
    <div class="grid2" style="margin-top:10px">
      <button class="btn primary" id="shApply" ${busy ? 'disabled' : ''}>✓ עדכן מלאי</button>
      <button class="btn danger" id="shClear">נקה הכל</button>
    </div>`;
  re.oninput = re.onchange = (e) => {
    const row = e.target.closest('[data-i]'); if (!row) return;
    const r = shelfRows[+row.dataset.i], f = e.target.dataset.f; if (!f) return;
    r.edited = true;
    if (f === 'include') r.include = e.target.checked;
    else if (f === 'name') { r.name = e.target.value; return; }
    else if (f === 'pid') {
      r.pid = e.target.value; const p = byId(r.pid);
      if (p) { r.name = p.name; r.unit = p.unit; r.pack = p.pack; r.perPack = p.perPack; }
    } else r[f] = f === 'perPack' ? Math.max(1, num(e.target.value)) : num(e.target.value);
    if (e.type === 'change' || f === 'include') drawShelfRowsOnly();
  };
  $('#shApply').onclick = applyShelf;
  $('#shClear').onclick = () => { if (confirm('לנקות את כל התמונות והתוצאות?')) { shelf.photos = []; shelfRows = []; drawShelf(); } };
}
function drawShelfRowsOnly() { const y = window.scrollY; drawShelf(); window.scrollTo(0, y); }

function applyShelf() {
  const rows = shelfRows.filter(r => r.include && r.name.trim());
  if (!rows.length) return toast('לא סומן אף מוצר');
  const nNew = rows.filter(r => !byId(r.pid)).length;
  if (!confirm(`לעדכן ${rows.length} מוצרים${nNew ? ` (מתוכם ${nNew} חדשים)` : ''}?`)) return;
  const lines = [];
  rows.forEach(r => {
    let p = byId(r.pid);
    const t = rowTotal(r);
    if (!p) {
      p = { id: uid(), name: r.name.trim(), barcode: '', category: r.category || '', unit: r.unit, pack: r.pack, perPack: Math.max(1, r.perPack), min: 0, qty: 0 };
      S.products.push(p);
    } else if (r.perPack !== p.perPack) p.perPack = Math.max(1, r.perPack);
    lines.push({ pid: p.id, name: p.name, category: p.category, unit: p.unit, expected: p.qty, counted: t });
    if (t !== p.qty) addMove(p, 'count', t - p.qty, 'ספירה מצילום');
  });
  S.counts.push({ id: uid(), ts: Date.now(), startedAt: Date.now(), lines, source: 'photo' });
  saveState(); updateBadge();
  shelf.photos = []; shelfRows = [];
  toast(`המלאי עודכן (${rows.length} מוצרים)`);
  if (nNew) setTimeout(() => toast('טיפ: הגדר "מינימום" למוצרים החדשים כדי לקבל התראות חוסר', 3500), 2300);
  go('inventory');
}

/* API key setup, shown where it's needed */
function keySetupHtml() {
  return `<div class="card stack" style="border-color:var(--accent);margin-bottom:12px">
    <b>🔑 הגדרה חד-פעמית: מפתח AI</b>
    <p class="small">הספירה מתמונות נעשית על ידי Claude, ולשם כך צריך מפתח:</p>
    <ol class="small" style="margin:0;padding-inline-start:18px">
      <li>נכנסים ל-<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener" dir="ltr">console.anthropic.com</a> ונרשמים.</li>
      <li>בחלק של Billing מוסיפים קרדיט, למשל 5$.</li>
      <li>לוחצים "Create Key", מעתיקים ומדביקים כאן.</li>
    </ol>
    <input type="password" id="kIn" dir="ltr" placeholder="sk-ant-..." autocomplete="off">
    <button class="btn primary block" id="kSave">שמור</button>
    <p class="small muted">המפתח נשמר רק בטלפון הזה. כל תמונה עולה בערך 5–15 סנט.</p>
  </div>`;
}
function bindKeySetup(after) {
  $('#kSave').onclick = () => {
    const k = $('#kIn').value.trim();
    if (!k.startsWith('sk-ant-')) return toast('המפתח צריך להתחיל ב-sk-ant-');
    S.settings.apiKey = k; saveState(); toast('נשמר! אפשר לצלם'); after();
  };
}

/* ================= Count (stock-take) ================= */
function startCountIfNeeded() {
  if (!S.countDraft) S.countDraft = { startedAt: Date.now(), lines: {} };
}
function renderCount() {
  const v = $('#view');
  if (!S.countDraft) {
    v.innerHTML = `
      <div class="card stack">
        <p>ספירת מלאי: עוברים על המדפים, רושמים כמה יש בפועל (ארגזים סגורים + יחידות בודדות), ובסוף המלאי מתעדכן לפי הספירה.</p>
        <button class="btn primary block" id="cStart">התחל ספירה חדשה</button>
      </div>
      <h2>ספירות קודמות</h2>
      <div class="list">${S.counts.slice().reverse().map(c => {
        const diff = c.lines.filter(l => l.counted !== l.expected).length;
        return `<button class="item" data-cid="${c.id}"><div class="main"><div class="name">${fmtDate(c.ts)}</div>
          <div class="sub">${c.lines.length} מוצרים נספרו · ${diff} פערים</div></div><div class="qty">⬇️ אקסל</div></button>`;
      }).join('') || '<p class="muted">אין עדיין</p>'}</div>`;
    $('#cStart').onclick = () => { startCountIfNeeded(); saveState(); renderCount(); };
    v.querySelector('.list').onclick = (e) => {
      const it = e.target.closest('[data-cid]'); if (it) exportCount(S.counts.find(c => c.id === it.dataset.cid));
    };
    return;
  }
  const d = S.countDraft;
  const done = Object.keys(d.lines).filter(id => byId(id)).length;
  const groups = {};
  S.products.forEach(p => (groups[p.category || 'ללא קטגוריה'] ||= []).push(p));
  v.innerHTML = `
    <div class="card row"><div class="grow"><b id="cDone">${done} / ${S.products.length}</b> <span class="muted">מוצרים נספרו</span><div class="muted small">התחלה: ${fmtDate(d.startedAt)}</div></div>
      <button class="btn primary" id="cFinish">סיום ועדכון</button></div>
    <input type="search" id="cq" placeholder="חיפוש…" style="margin-top:10px">
    <div id="clist"></div>
    <button class="btn danger block" id="cCancel" style="margin-top:16px">ביטול הספירה</button>`;
  const draw = () => {
    const q = $('#cq').value.trim().toLowerCase();
    $('#clist').innerHTML = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'he')).map(g => {
      const ps = groups[g].filter(p => !q || p.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name, 'he'));
      if (!ps.length) return '';
      return `<h3>${esc(g)}</h3><div class="list">${ps.map(countRowHtml).join('')}</div>`;
    }).join('');
  };
  draw();
  $('#cq').oninput = draw;
  $('#clist').addEventListener('input', (e) => {
    const row = e.target.closest('[data-pid]'); if (!row) return;
    const p = byId(row.dataset.pid), per = p.perPack > 1;
    d.lines[p.id] = { packs: per ? num($('[data-k=packs]', row)?.value) : 0, units: num($('[data-k=units]', row).value) };
    row.classList.add('done');
    $('.diffcell', row).innerHTML = diffHtml(p);
    $('#cDone').textContent = `${Object.keys(d.lines).filter(id => byId(id)).length} / ${S.products.length}`;
    saveState();
  });
  $('#clist').addEventListener('click', (e) => {
    const b = e.target.closest('[data-photo]'); if (!b) return;
    const p = byId(b.dataset.photo);
    photoCount(p, (r) => { d.lines[p.id] = { packs: p.perPack > 1 ? r.packs : 0, units: r.units }; saveState(); draw(); });
  });
  $('#cFinish').onclick = finishCount;
  $('#cCancel').onclick = () => { if (confirm('לבטל את הספירה? מה שנרשם יימחק.')) { S.countDraft = null; saveState(); renderCount(); } };
}
const countedTotal = (p) => { const l = S.countDraft?.lines[p.id]; return l ? l.packs * (p.perPack > 1 ? p.perPack : 0) + l.units : null; };
function diffHtml(p) {
  const t = countedTotal(p); if (t === null) return `<span class="muted">במערכת: ${p.qty}</span>`;
  const df = t - p.qty;
  return `במערכת: ${p.qty} · נספר: ${t} · <span class="${df > 0 ? 'diff-pos' : df < 0 ? 'diff-neg' : ''}">${signed(df)}</span>`;
}
function countRowHtml(p) {
  const l = S.countDraft.lines[p.id], per = p.perPack > 1;
  return `<div class="countrow ${l ? 'done' : ''}" data-pid="${p.id}">
    <div class="row"><b class="grow">${esc(p.name)}</b></div>
    <div class="small diffcell">${diffHtml(p)}</div>
    <div class="inputs ${per ? '' : 'single'}">
      ${per ? `<label><span>${esc(p.pack)} (${p.perPack})</span><input type="number" inputmode="numeric" min="0" data-k="packs" value="${l ? l.packs : ''}" placeholder="0"></label>` : ''}
      <label><span>${esc(p.unit)}${per ? ' בודדים' : ''}</span><input type="number" inputmode="numeric" min="0" data-k="units" value="${l ? l.units : ''}" placeholder="0"></label>
      <button class="btn small" data-photo="${p.id}" title="ספירה מתמונה">📷</button>
    </div></div>`;
}
function finishCount() {
  const d = S.countDraft;
  const ids = Object.keys(d.lines).filter(id => byId(id));
  if (!ids.length) return toast('עוד לא נספר אף מוצר');
  const missing = S.products.length - ids.length;
  if (!confirm(`לעדכן את המלאי לפי הספירה? (${ids.length} מוצרים${missing ? `, ${missing} לא נספרו ויישארו כמו שהם` : ''})`)) return;
  const lines = [];
  ids.forEach(id => {
    const p = byId(id), t = countedTotal(p);
    lines.push({ pid: id, name: p.name, category: p.category, unit: p.unit, expected: p.qty, counted: t });
    if (t !== p.qty) addMove(p, 'count', t - p.qty, 'ספירת מלאי');
  });
  const rec = { id: uid(), ts: Date.now(), startedAt: d.startedAt, lines };
  S.counts.push(rec); S.countDraft = null; saveState(); updateBadge();
  toast('המלאי עודכן לפי הספירה');
  renderCount();
  if (confirm('להוריד דוח ספירה לאקסל?')) exportCount(rec);
}

/* ================= Photo count with Claude ================= */
let anthropicMod = null;
async function getClient() {
  const key = S.settings.apiKey?.trim();
  if (!key) throw new Error('NO_KEY');
  // Loaded on demand; the rest of the app works offline without it.
  anthropicMod = anthropicMod || await import('https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.1.0/+esm');
  const Anthropic = anthropicMod.default || anthropicMod.Anthropic;
  // Key lives only on this phone and is sent straight to Anthropic.
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
}
function resizeToJpeg(file, max = 1568) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const dataUrl = c.toDataURL('image/jpeg', 0.85);
      res({ dataUrl, b64: dataUrl.split(',')[1] });
    };
    img.onerror = rej; img.src = url;
  });
}
const COUNT_SCHEMA = {
  type: 'object',
  properties: {
    closed_packs: { type: 'integer', description: 'Number of closed/sealed packs or cases visible' },
    loose_units: { type: 'integer', description: 'Number of individual loose units visible (not inside closed packs)' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    note_he: { type: 'string', description: 'Short note in Hebrew: what was counted, anything hidden or uncertain' },
  },
  required: ['closed_packs', 'loose_units', 'confidence', 'note_he'],
  additionalProperties: false,
};
function photoCount(p, onResult) {
  const prevClose = onSheetClose; // keep the parent flow's close handler
  const hadSheet = !$('#sheet').hidden;
  const holder = document.createElement('div');
  holder.className = 'card stack'; holder.style.marginBottom = '12px';
  holder.innerHTML = `
    <b>📷 ספירה מתמונה: ${esc(p.name)}</b>
    <p class="muted small">צלם את המדף מקרוב ובאור טוב, כך שכל ה${esc(p.unit)} נראים. ה-AI סופר, ואתה מאשר או מתקן.</p>
    <input type="file" accept="image/*" capture="environment" id="phIn" hidden>
    <button class="btn primary block" id="phTake">צלם / בחר תמונה</button>
    <div id="phOut"></div>
    <button class="btn block" id="phClose">סגור</button>`;
  if (hadSheet) $('#sheet').prepend(holder);
  else { openSheet(''); $('#sheet').append(holder); onSheetClose = prevClose; }
  $('#sheet').scrollTop = 0;
  const close = () => { holder.remove(); if (!hadSheet) closeSheet(); };
  $('#phClose', holder).onclick = close;
  $('#phTake', holder).onclick = () => $('#phIn', holder).click();
  $('#phIn', holder).onchange = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const out = $('#phOut', holder);
    let img;
    try { img = await resizeToJpeg(file); } catch { out.innerHTML = '<p class="diff-neg">לא הצלחתי לקרוא את התמונה</p>'; return; }
    out.innerHTML = `<img class="photo-preview" src="${img.dataUrl}" alt=""><p class="center">סופר… ⏳</p>`;
    try {
      const client = await getClient();
      const per = p.perPack > 1;
      const prompt = `You are counting stock in a restaurant storeroom photo.
Product: "${p.name}" (category: ${p.category || 'n/a'}). Unit name (Hebrew): "${p.unit}".
${per ? `It also comes in closed packs called "${p.pack}" containing ${p.perPack} units each. Count sealed/closed packs separately as closed_packs and do NOT add their contents to loose_units.` : 'There are no packs for this product; set closed_packs to 0.'}
Count only this product. Count carefully, row by row; include partially visible items you are confident are there. If items are stacked/hidden behind others so the true number cannot be seen, give your best count of what is visible and say so in note_he.`;
      const resp = await client.beta.messages.create({
        model: 'claude-opus-5-5',
        max_tokens: 4000,
        // if the model declines, the server retries on a fallback model automatically
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: COUNT_SCHEMA } },
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.b64 } },
          { type: 'text', text: prompt },
        ] }],
      });
      if (resp.stop_reason === 'refusal') throw new Error('REFUSAL');
      const txt = resp.content.find(b => b.type === 'text')?.text || '{}';
      const r = JSON.parse(txt);
      const res = { packs: Math.max(0, r.closed_packs | 0), units: Math.max(0, r.loose_units | 0) };
      const conf = { high: 'גבוהה', medium: 'בינונית', low: 'נמוכה' }[r.confidence] || r.confidence;
      out.innerHTML = `<img class="photo-preview" src="${img.dataUrl}" alt="">
        <div class="notice"><b>${per ? `${res.packs} ${esc(p.pack)} + ` : ''}${res.units} ${esc(p.unit)}</b>
        ${per ? ` = ${res.packs * p.perPack + res.units} ${esc(p.unit)}` : ''}<br>
        <span class="small">ודאות: ${esc(conf)}. ${esc(r.note_he || '')}</span></div>
        <button class="btn primary block" id="phUse" style="margin-top:8px">השתמש בתוצאה</button>`;
      $('#phUse', holder).onclick = () => { close(); onResult(res); };
    } catch (err) {
      console.warn(err);
      const msg = err.message === 'NO_KEY' ? 'כדי לספור מתמונה צריך להכניס מפתח API בהגדרות.'
        : err.message === 'REFUSAL' ? 'הבקשה נדחתה. נסה תמונה אחרת.'
        : err.status === 401 ? 'מפתח ה-API לא תקין.'
        : !navigator.onLine ? 'אין חיבור לאינטרנט. ספירה מתמונה צריכה רשת.'
        : 'שגיאה בספירה: ' + (err.message || err);
      out.innerHTML = `<p class="diff-neg">${esc(msg)}</p>`;
    }
  };
}

/* ================= Low stock ================= */
function renderLow() {
  const low = S.products.filter(isLow).sort((a, b) => (a.qty / a.min) - (b.qty / b.min));
  const v = $('#view');
  if (!low.length) {
    v.innerHTML = `<div class="empty"><div class="big">✅</div><p>אין מוצרים מתחת למינימום.</p>
      <p class="small">מגדירים מינימום לכל מוצר במסך העריכה שלו.</p></div>`;
    return;
  }
  v.innerHTML = `
    <div class="grid2"><button class="btn primary" id="lShare">📤 שליחת רשימה</button><button class="btn" id="lXls">⬇️ אקסל</button></div>
    <div class="list" style="margin-top:12px">${low.map(p => {
      const need = p.min - p.qty, per = p.perPack > 1;
      return `<button class="item low" data-id="${p.id}"><div class="main"><div class="name">${esc(p.name)}</div>
        <div class="sub">יש ${esc(fmtQty(p))} · מינימום ${p.min}</div></div>
        <div class="qty">חסר ${need}${per ? `<small>≈ ${Math.ceil(need / p.perPack)} ${esc(p.pack)}</small>` : ''}</div></button>`;
    }).join('')}</div>`;
  v.querySelector('.list').onclick = (e) => { const it = e.target.closest('[data-id]'); if (it) productSheet(it.dataset.id); };
  $('#lShare').onclick = async () => {
    const text = 'רשימת חוסרים במחסן:\n' + low.map(p => {
      const need = p.min - p.qty;
      return `• ${p.name}: יש ${p.qty}, חסר ${need}${p.perPack > 1 ? ` (≈${Math.ceil(need / p.perPack)} ${p.pack})` : ''}`;
    }).join('\n');
    if (navigator.share) { try { await navigator.share({ text }); } catch { /* cancelled */ } }
    else { window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank'); }
  };
  $('#lXls').onclick = () => {
    writeXlsx('רשימת_הזמנה', {
      'חסרים': low.map(p => ({ 'מוצר': p.name, 'קטגוריה': p.category, 'במלאי': p.qty, 'מינימום': p.min, 'חסר (יחידות)': p.min - p.qty,
        'חסר (אריזות)': p.perPack > 1 ? Math.ceil((p.min - p.qty) / p.perPack) : '', 'אריזה': p.perPack > 1 ? `${p.pack} ${p.perPack}` : '' })),
    });
  };
}

/* ================= Excel ================= */
function writeXlsx(name, sheets) {
  if (!window.XLSX) return toast('רכיב האקסל עוד נטען, נסה שוב');
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  for (const [title, rows] of Object.entries(sheets)) {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{}]);
    ws['!cols'] = Object.keys(rows[0] || {}).map(k => ({ wch: Math.max(10, k.length + 4) }));
    XLSX.utils.book_append_sheet(wb, ws, title.slice(0, 31));
  }
  const d = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `${name}_${d}.xlsx`);
}
const TYPE_HE = { in: 'קליטה', out: 'הוצאה', count: 'ספירה', edit: 'עדכון' };
function exportAll() {
  writeXlsx('מלאי', {
    'מלאי': S.products.map(p => ({ 'מוצר': p.name, 'קטגוריה': p.category, 'כמות (יחידות)': p.qty, 'כמות': fmtQty(p),
      'יחידה': p.unit, 'אריזה': p.pack, 'יחידות באריזה': p.perPack, 'מינימום': p.min, 'מצב': isLow(p) ? 'נמוך' : 'תקין' })),
    'תנועות': S.moves.slice().reverse().map(m => { const p = byId(m.pid); return {
      'תאריך': new Date(m.ts).toLocaleString('he-IL'), 'מוצר': p ? p.name : '(נמחק)', 'סוג': TYPE_HE[m.type] || m.type,
      'שינוי': m.delta, 'אחרי': m.after, 'הערה': m.note }; }),
  });
}
function exportCount(c) {
  writeXlsx('ספירת_מלאי', {
    'ספירה': c.lines.map(l => ({ 'מוצר': l.name, 'קטגוריה': l.category || '', 'במערכת': l.expected, 'נספר': l.counted, 'הפרש': l.counted - l.expected, 'יחידה': l.unit || '' })),
  });
}
function importProducts(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const wb = XLSX.read(fr.result, { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      let added = 0, updated = 0;
      rows.forEach(r => {
        const name = String(r['מוצר'] ?? r['שם'] ?? '').trim(); if (!name) return;
        const barcode = String(r['ברקוד'] ?? '').trim();
        const ex = (barcode && byBarcode(barcode)) || S.products.find(p => p.name === name);
        const data = { name, barcode, category: String(r['קטגוריה'] ?? '').trim(), unit: String(r['יחידה'] ?? 'יחידה').trim() || 'יחידה',
          pack: String(r['אריזה'] ?? 'ארגז').trim() || 'ארגז', perPack: Math.max(1, num(r['יחידות באריזה'])), min: num(r['מינימום']) };
        if (ex) { Object.assign(ex, data); updated++; }
        else { const np = { id: uid(), ...data, qty: 0 }; S.products.push(np); const q = num(r['כמות (יחידות)'] ?? r['כמות']); if (q) addMove(np, 'in', q, 'ייבוא'); added++; }
      });
      saveState(); updateBadge(); toast(`יובאו ${added} מוצרים חדשים, עודכנו ${updated}`);
    } catch (e) { console.warn(e); toast('לא הצלחתי לקרוא את הקובץ'); }
  };
  fr.readAsArrayBuffer(file);
}

/* ================= Settings ================= */
function renderSettings() {
  const v = $('#view');
  v.innerHTML = `
    <h2>ייצוא וגיבוי</h2>
    <div class="stack">
      <button class="btn block primary" id="sXls">⬇️ ייצוא מלאי + תנועות לאקסל</button>
      <button class="btn block" id="sBackup">💾 הורדת גיבוי מלא (JSON)</button>
      <label class="btn block">♻️ שחזור מגיבוי<input type="file" accept=".json,application/json" id="sRestore" hidden></label>
      <label class="btn block">📥 ייבוא מוצרים מאקסל<input type="file" accept=".xlsx,.xls,.csv" id="sImport" hidden></label>
      <p class="muted small">עמודות לייבוא: מוצר, ברקוד, קטגוריה, יחידה, אריזה, יחידות באריזה, מינימום, כמות (יחידות). אפשר לייצא קובץ ולהשתמש בו כתבנית.</p>
    </div>
    <h2>ספירה מתמונה (AI)</h2>
    <div class="card stack">
      <p class="small">ספירה מתמונה משתמשת ב-Claude. צריך מפתח API מ-<span dir="ltr">console.anthropic.com</span>. המפתח נשמר רק בטלפון הזה, ונשלח ישירות ל-Anthropic. כל תמונה עולה בערך כמה סנטים.</p>
      <input type="password" id="sKey" dir="ltr" placeholder="sk-ant-..." value="${esc(S.settings.apiKey)}" autocomplete="off">
      <button class="btn block" id="sKeySave">שמור מפתח</button>
    </div>
    <h2>נתונים</h2>
    <div class="card small">
      <div class="row"><span class="grow muted">מוצרים</span><b>${S.products.length}</b></div>
      <div class="row"><span class="grow muted">תנועות</span><b>${S.moves.length}</b></div>
      <div class="row"><span class="grow muted">ספירות</span><b>${S.counts.length}</b></div>
      <p class="muted">הנתונים נשמרים בטלפון הזה בלבד. כדאי להוריד גיבוי מדי פעם.</p>
    </div>
    <div class="stack" style="margin-top:12px">
      ${S.products.length ? '' : '<button class="btn block" id="sDemo">טען מוצרים לדוגמה</button>'}
      <button class="btn block danger" id="sWipe">מחיקת כל הנתונים</button>
    </div>`;
  $('#sXls').onclick = exportAll;
  $('#sBackup').onclick = () => {
    const blob = new Blob([JSON.stringify({ ...S, settings: { apiKey: '' } }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `machsan-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('#sRestore').onchange = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    f.text().then(t => {
      const d = JSON.parse(t);
      if (!Array.isArray(d.products)) throw new Error('bad');
      if (!confirm(`לשחזר ${d.products.length} מוצרים? הנתונים הנוכחיים יוחלפו.`)) return;
      const key = S.settings.apiKey;
      S = { ...DEFAULT_STATE(), ...d, settings: { apiKey: key } };
      saveState(); updateBadge(); toast('שוחזר'); renderSettings();
    }).catch(() => toast('קובץ גיבוי לא תקין'));
  };
  $('#sImport').onchange = (e) => { const f = e.target.files?.[0]; if (f) importProducts(f); };
  $('#sKeySave').onclick = () => { S.settings.apiKey = $('#sKey').value.trim(); saveState(); toast('המפתח נשמר'); };
  $('#sDemo') && ($('#sDemo').onclick = loadDemo);
  $('#sWipe').onclick = () => {
    if (!confirm('למחוק את כל המוצרים, התנועות והספירות? אי אפשר לבטל.')) return;
    if (prompt('כדי לאשר, כתוב: מחק') !== 'מחק') return;
    const key = S.settings.apiKey; S = DEFAULT_STATE(); S.settings.apiKey = key;
    saveState(); updateBadge(); toast('הכל נמחק'); renderSettings();
  };
}

function loadDemo() {
  const demo = [
    ['קולה זכוכית 330', 'שתייה', 'בקבוק', 'ארגז', 24, 48, 60],
    ['מים מינרליים 1.5 ל׳', 'שתייה', 'בקבוק', 'שישייה', 6, 24, 30],
    ['בירה גולדסטאר 330', 'שתייה', 'בקבוק', 'ארגז', 24, 48, 20],
    ['סודה 1.5 ל׳', 'שתייה', 'בקבוק', 'שישייה', 6, 12, 18],
    ['מגבונים לחים', 'חד״פ', 'חבילה', 'קרטון', 12, 10, 14],
    ['קשים', 'חד״פ', 'חבילה', 'קרטון', 20, 10, 6],
    ['מפיות', 'חד״פ', 'חבילה', 'קרטון', 30, 15, 45],
    ['כוסות חד״פ', 'חד״פ', 'שרוול', 'קרטון', 20, 10, 25],
    ['נוזל כלים 4 ל׳', 'ניקיון', 'ג׳ריקן', 'קרטון', 4, 2, 3],
  ];
  demo.forEach(([name, category, unit, pack, perPack, min, qty]) => {
    const p = { id: uid(), name, category, unit, pack, perPack, min, qty: 0, barcode: '' };
    S.products.push(p); addMove(p, 'in', qty, 'דוגמה');
  });
  saveState(); updateBadge(); toast('נטענו מוצרים לדוגמה'); go('inventory');
}

/* ================= Boot ================= */
(async function boot() {
  const saved = await loadState();
  if (saved) S = { ...DEFAULT_STATE(), ...saved, settings: { ...DEFAULT_STATE().settings, ...(saved.settings || {}) } };
  try { navigator.storage?.persist?.(); } catch { /* optional */ }
  updateBadge();
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  }
})();
