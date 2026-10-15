/**
 * รับรูปจากหน้า "สรุปการทดสอบ HOSxP XE" → เก็บใน Google Drive (ระบุข้อที่อัปโหลดไว้ในคำอธิบายไฟล์)
 * → พยายามเขียนลิงก์ลงคอลัมน์ภาพของแถวนั้นด้วย
 * หน้าเว็บดึงรายการรูปจากโฟลเดอร์ (doGet?action=list) มาแสดงที่ปุ่ม "ดูรูป" ของแต่ละข้อ
 *
 * วิธีติดตั้ง (ทำครั้งเดียว ด้วยบัญชีที่แก้ไข Google Sheet และโฟลเดอร์ Drive ได้)
 * 1. เปิด Google Sheet > ส่วนขยาย (Extensions) > Apps Script
 * 2. ลบโค้ดเดิมในไฟล์ Code.gs แล้ววางโค้ดทั้งหมดนี้ > กดบันทึก
 * 3. กด ทำให้ใช้งานได้ (Deploy) > การทำให้ใช้งานได้รายการใหม่ (New deployment)
 *    - เลือกประเภท: เว็บแอป (Web app)
 *    - ดำเนินการในฐานะ (Execute as): ฉัน (Me)
 *    - ผู้ที่มีสิทธิ์เข้าถึง (Who has access): ทุกคน (Anyone)
 * 4. กด Deploy > อนุญาตสิทธิ์ (Authorize) > คัดลอก URL ของเว็บแอป (ลงท้ายด้วย /exec)
 * 5. นำ URL ไปใส่ในค่า UPLOAD_URL ช่วงต้นของสคริปต์ในไฟล์ index.html
 *
 * ถ้าแก้โค้ดนี้ภายหลัง ต้อง Deploy > จัดการการทำให้ใช้งานได้ > แก้ไข (ดินสอ) > เวอร์ชันใหม่ ทุกครั้ง
 */
const SPREADSHEET_ID = '1U5eVS4zEt4g4D1YCwjoToaZEymw9TA-RZBCECkY134s';
// โฟลเดอร์เก็บรูป: https://drive.google.com/drive/u/0/folders/1fwD2jPox8GojPEENajr2jLTt_9NUfZTH
const FOLDER_ID = '1fwD2jPox8GojPEENajr2jLTt_9NUfZTH';
const MAX_BYTES = 15 * 1024 * 1024;
const KEY_PREFIX = 'row:';

// OAuth Client ID ของปุ่ม "เข้าสู่ระบบด้วย Google" (ต้องตรงกับค่า GOOGLE_CLIENT_ID ใน index.html)
const GOOGLE_CLIENT_ID = '';
const PRESENCE_TTL_MS = 150 * 1000; // ไม่ส่งสัญญาณเกินเวลานี้ = ออกไปแล้ว (หน้าเว็บส่งทุก 60 วินาที)

// GET ?action=list → รายการรูปทั้งหมดพร้อมข้อที่อัปโหลด
// GET ?action=ping&vid=... → แจ้งว่ายังเปิดดูอยู่ และรับรายชื่อผู้ที่กำลังดู
// (ทุก action รองรับ ?callback= แบบ JSONP)
function doGet(e) {
  const prm = (e && e.parameter) || {};
  let out;
  if (prm.action === 'today') {
    try { out = todayChanges(String(prm.gids || '').split(',').filter(String)); }
    catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
  } else if (prm.action === 'style') {
    try { out = sheetStyle(prm.gid); }
    catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
  } else if (prm.action === 'notes') {
    try { out = editHistory(prm.gid, Number(prm.since || 0)); }
    catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
  } else if (prm.action === 'getitem') {
    try { out = getItemCell(JSON.parse(prm.p || '{}')); }
    catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
  } else if (prm.action === 'opts' || prm.action === 'rosteropts') {
    try { out = tabOptions(prm.gid || ROSTER_GID); }
    catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
  } else if (prm.action === 'setcell') {
    try { out = setRosterCell(prm); }
    catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
  } else if (prm.action === 'delete') {
    try { out = deleteImage(prm); }
    catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
  } else if (prm.action === 'ping' || prm.action === 'leave') {
    try { out = presence(prm); }
    catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
  } else if (prm.action === 'list') {
    try {
      out = { ok: true, files: imageIndex(prm.rebuild === '1') };
    } catch (err) {
      out = { ok: false, error: String((err && err.message) || err) };
    }
  } else {
    out = { ok: true, message: 'upload service is running' };
  }
  return reply(out, prm.callback);
}

// ---------- ดัชนีรูป (เร็วกว่าการเปิดไฟล์ใน Drive ทีละไฟล์) ----------
// เก็บใน Script Properties: img:<fileId> = {k: key ของข้อ, n: ชื่อไฟล์, c: เวลาสร้าง}
// สร้างใหม่จากโฟลเดอร์ครั้งแรก, ทุก 24 ชั่วโมง หรือเมื่อเรียก ?action=list&rebuild=1
const IMG_PREFIX = 'img:';
function imageIndex(rebuild) {
  const props = PropertiesService.getScriptProperties();
  let all = props.getProperties();
  const built = Number(all['img_index_built'] || 0);
  if (rebuild || !built || Date.now() - built > 24 * 3600 * 1000) {
    const lock = LockService.getScriptLock();
    if (lock.tryLock(1000)) {
      try {
        const add = {};
        const it = getFolder().getFiles();
        while (it.hasNext()) {
          const f = it.next();
          const d = f.getDescription() || '';
          if (d.indexOf(KEY_PREFIX) !== 0) continue;
          add[IMG_PREFIX + f.getId()] = JSON.stringify({ k: d.slice(KEY_PREFIX.length), n: f.getName(), c: f.getDateCreated().getTime() });
        }
        Object.keys(all).forEach(k => { if (k.indexOf(IMG_PREFIX) === 0 && !add[k]) props.deleteProperty(k); });
        add['img_index_built'] = String(Date.now());
        props.setProperties(add);
        all = props.getProperties();
      } finally {
        lock.releaseLock();
      }
    }
  }
  const files = [];
  for (const k in all) {
    if (k.indexOf(IMG_PREFIX) !== 0) continue;
    try { const v = JSON.parse(all[k]); files.push({ id: k.slice(IMG_PREFIX.length), key: v.k, name: v.n, created: v.c }); } catch (e) {}
  }
  return files.sort((a, b) => a.created - b.created);
}

// บันทึกชื่อผู้แก้เป็นโน้ตของช่องนั้น (ล่าสุดอยู่บน เก็บ 10 ครั้งหลังสุด) — ไม่ต้องเพิ่มแท็บใหม่
function noteEditor(range, editor, header) {
  editor = String(editor || '').trim().slice(0, 200) || 'ไม่ระบุชื่อ';
  const now = new Date();
  const when = Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');
  const line = 'แก้ไขโดย ' + editor + ' เมื่อ ' + when;
  const old = String(range.getNote() || '').split('\n').filter(l => l.indexOf('แก้ไขโดย ') === 0);
  range.setNote([line].concat(old).slice(0, 10).join('\n'));
  // ไฟล์ประวัติ (อ่านเร็ว ไม่ต้องอ่านโน้ตทุกช่อง) — ผู้เรียกถือ lock อยู่แล้ว
  try {
    const gid = String(range.getSheet().getSheetId()), row = String(range.getRow());
    const h = histRead();
    const tab = h[gid] = h[gid] || {};
    const r = tab[row] = tab[row] || { u: 0, e: [] };
    r.e.unshift({ who: editor, when, ts: now.getTime(), col: String(header || '') });
    r.e = r.e.slice(0, 20);
    r.u = now.getTime();
    histWrite(h);
  } catch (err) { /* โน้ตในช่องยังมีอยู่ */ }
}

// ---------- ผลการทดสอบที่เปลี่ยนวันนี้ ----------
// เก็บผลการทดสอบของทุกข้อไว้ในไฟล์ result-snapshot.json แล้วเทียบกับค่าตอนเริ่มวัน
// (ค่าล่าสุดที่เห็นก่อนขึ้นวันใหม่) นับทั้งการแก้ผ่านหน้าเว็บและการแก้ในชีทโดยตรง
// { gid: { day: 'yyyy-MM-dd', base: {หัวข้อ: ผล}, last: {หัวข้อ: ผล} } }
function todayChanges(gids) {
  const today = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const cache = CacheService.getScriptCache(), ck = 'today:' + gids.join(',');
  const hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  // อ่านชีทโดยไม่ล็อก (อ่านอย่างเดียว) เพื่อไม่ให้คำสั่งอื่นต้องรอ
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheets = ss.getSheets();
  const snap = jsonFileRead('result-snapshot.json');
  const changed = {};
  gids.forEach(gid => {
    if (isRoster(gid)) return;
    const sh = sheets.find(x => String(x.getSheetId()) === String(gid));
    if (!sh || sh.getLastRow() < 2) return;
    const n = sh.getLastRow() - 1;
    const heads = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].map(h => String(h).trim());
    const tcol = heads.findIndex(h => /^หัวข้อ/.test(h));
    const rcols = heads.map((h, i) => /^ผลการทดสอบ/.test(h) ? i : -1).filter(i => i >= 0);
    if (tcol < 0 || !rcols.length) return;
    const titles = sh.getRange(2, tcol + 1, n, 1).getDisplayValues();
    const results = rcols.map(c => sh.getRange(2, c + 1, n, 1).getDisplayValues());
    // เก็บด้วยรหัสสั้นของหัวข้อ (ไฟล์เล็ก อ่าน/เขียนเร็ว) แต่ส่งกลับเป็นหัวข้อจริง
    const cur = {}, titleOf = {};
    titles.forEach((t, i) => {
      const title = String(t[0]).trim();
      if (!title) return;
      const k = shortKey(title);
      cur[k] = results.map(r => String(r[i][0]).trim()).join('|');
      titleOf[k] = title;
    });
    const st = snap[gid] || { day: '', base: null, last: null };
    // ข้อมูลรุ่นก่อนเก็บด้วยหัวข้อเต็มและคั่นผลด้วย ' | ' — แปลงเป็นรูปแบบใหม่
    if (!st.v2) { st.base = rekey(st.base); st.last = rekey(st.last); st.v2 = 1; }
    if (st.day !== today) { st.base = st.last || cur; st.day = today; }
    changed[gid] = Object.keys(cur).filter(k => cur[k].replace(/\|/g, '') && cur[k] !== (st.base[k] || '')).map(k => titleOf[k]);
    st.last = cur;
    snap[gid] = st;
  });
  // ล็อกเฉพาะตอนเขียนไฟล์ ถ้ามีคำสั่งอื่นใช้อยู่ก็ข้ามไป (รอบหน้าค่อยเขียน)
  const lock = LockService.getScriptLock();
  if (lock.tryLock(2000)) {
    try { jsonFileWrite('result-snapshot.json', snap); } finally { lock.releaseLock(); }
  }
  const out = { ok: true, day: today, changed };
  try { cache.put(ck, JSON.stringify(out), 120); } catch (err) { /* ใหญ่เกิน cache */ }
  return out;
}
function rekey(map) {
  if (!map) return map;
  const out = {};
  for (const k in map) out[shortKey(k)] = String(map[k]).split(' | ').join('|');
  return out;
}
function shortKey(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8)).slice(0, 12);
}

// ไฟล์ JSON ในโฟลเดอร์รูป (ใช้เก็บข้อมูลของระบบ) — จำรหัสไฟล์ไว้ใน Script Properties
function jsonFile(name) {
  const props = PropertiesService.getScriptProperties(), pk = 'file:' + name;
  const id = props.getProperty(pk);
  if (id) { try { return DriveApp.getFileById(id); } catch (err) { /* ถูกลบ สร้างใหม่ */ } }
  const f = getFolder().createFile(name, '{}', 'application/json');
  props.setProperty(pk, f.getId());
  return f;
}
function jsonFileRead(name) {
  try { return JSON.parse(jsonFile(name).getBlob().getDataAsString() || '{}'); } catch (err) { return {}; }
}
function jsonFileWrite(name, obj) { jsonFile(name).setContent(JSON.stringify(obj)); }

// ---------- ไฟล์ประวัติผู้แก้ไข (JSON ไฟล์เดียวในโฟลเดอร์รูป) ----------
// { gid: { แถว: { u: เวลาแก้ล่าสุด, e: [{who, when, ts, col}] } }, _built: { gid: 1 } }
function histFile() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('hist_file_id');
  if (id) { try { return DriveApp.getFileById(id); } catch (err) { /* ถูกลบ สร้างใหม่ */ } }
  const f = getFolder().createFile('edit-history.json', '{}', 'application/json');
  props.setProperty('hist_file_id', f.getId());
  return f;
}
function histRead() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('hist');
  if (hit) return JSON.parse(hit);
  const text = histFile().getBlob().getDataAsString() || '{}';
  try { cache.put('hist', text, 300); } catch (err) { /* ใหญ่เกิน cache */ }
  return JSON.parse(text);
}
function histWrite(h) {
  const text = JSON.stringify(h);
  histFile().setContent(text);
  try { CacheService.getScriptCache().put('hist', text, 300); } catch (err) { CacheService.getScriptCache().remove('hist'); }
}

// ประวัติผู้แก้ไขของทุกแถวในแท็บ (อ่านจากโน้ตของแต่ละช่อง) ล่าสุดอยู่บน
// since = เวลาที่หน้าเว็บโหลดครั้งก่อน: ส่งกลับเฉพาะแถวที่มีการแก้หลังจากนั้น
function editHistory(gid, since) {
  gid = String(gid);
  let h = histRead();
  if (!(h._built && h._built[gid])) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      h = histRead();
      if (!(h._built && h._built[gid])) {
        const old = notesFromSheet(gid).rows;
        const tab = h[gid] = h[gid] || {};
        for (const r in old) {
          const cur = tab[r] = tab[r] || { u: 0, e: [] };
          const seen = new Set(cur.e.map(x => x.ts + '|' + x.col + '|' + x.who));
          old[r].forEach(x => { if (!seen.has(x.ts + '|' + x.col + '|' + x.who)) cur.e.push(x); });
          cur.e.sort((a, b) => b.ts - a.ts); cur.e = cur.e.slice(0, 20);
          cur.u = Math.max(cur.u, cur.e.length ? cur.e[0].ts : 0);
        }
        h._built = h._built || {}; h._built[gid] = 1;
        histWrite(h);
      }
    } finally {
      lock.releaseLock();
    }
  }
  const rows = {}, tab = h[gid] || {};
  for (const r in tab) if (tab[r].u > (since || 0)) rows[r] = tab[r].e;
  return { ok: true, rows, now: Date.now() };
}

// อ่านประวัติจากโน้ตของทุกช่องในแท็บ (ใช้ครั้งเดียวตอนย้ายข้อมูลเดิม เพราะช้า)
function notesFromSheet(gid) {
  const cache = CacheService.getScriptCache(), ckey = 'notes:' + gid;
  const hit = cache.get(ckey);
  if (hit) return JSON.parse(hit);
  const sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()
    .find(s => String(s.getSheetId()) === String(gid));
  if (!sh) throw new Error('ไม่พบแท็บ');
  const range = sh.getDataRange();
  const notes = range.getNotes();
  const heads = (notes.length ? sh.getRange(1, 1, 1, range.getNumColumns()).getDisplayValues()[0] : []).map(h => String(h).trim());
  const re = /^แก้ไขโดย (.+) เมื่อ (\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;
  const rows = {};
  notes.forEach((r, i) => r.forEach((n, j) => {
    if (!n) return;
    String(n).split('\n').forEach(line => {
      const m = line.trim().match(re);
      if (!m) return;
      (rows[i + 1] = rows[i + 1] || []).push({ who: m[1], when: m[2] + '/' + m[3] + '/' + m[4] + ' ' + m[5] + ':' + m[6],
        ts: Date.UTC(+m[4], +m[3] - 1, +m[2], +m[5], +m[6]) - 7 * 3600 * 1000, col: heads[j] || '' });
    });
  }));
  for (const k in rows) rows[k].sort((a, b) => b.ts - a.ts);
  const out = { ok: true, rows };
  try { cache.put(ckey, JSON.stringify(out), 60); } catch (err) { /* ใหญ่เกิน cache */ }
  return out;
}

// ---------- แก้ไขหน้ารายชื่อ ----------
// แก้ได้เฉพาะแท็บรายชื่อทดสอบโปรแกรม(ประจำสัปดาห์) และเฉพาะคอลัมน์ที่หัวตาราง (แถว 2) ชื่อตามนี้ ทุกสัปดาห์
const ROSTER_GID = '1921321948';
const ROSTER_HEADER_ROW = 2;
const ROSTER_EDITABLE = ['หัวหน้าทีม', 'สถานะทดสอบ', 'หมายเหตุ'];
// แท็บแบบรายชื่อทั้งหมด: gid → คอลัมน์ที่แก้ได้ (ชื่อหัวตารางในแถว 2)
const ROSTERS = {
  '1921321948': ROSTER_EDITABLE,                                        // รายชื่อทดสอบโปรแกรม(ประจำสัปดาห์)
  '1348359682': ['สถานะการส่ง WBS', 'ส่งหัวหน้าทีม', 'อัพขึ้น'],         // รายชื่อจัดทำวีดีโอ
};
const isRoster = gid => Object.prototype.hasOwnProperty.call(ROSTERS, String(gid));

// สีพื้น สีตัวอักษร ตัวหนา และเซลล์ที่ผสาน ของแท็บแบบรายชื่อ (ให้หน้าเว็บแสดงเหมือนชีท)
function sheetStyle(gid) {
  gid = String(gid);
  if (!isRoster(gid)) throw new Error('ใช้ได้เฉพาะแท็บแบบรายชื่อ');
  const cache = CacheService.getScriptCache(), key = 'style:' + gid;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()
    .find(s => String(s.getSheetId()) === gid);
  if (!sh) throw new Error('ไม่พบแท็บ');
  const range = sh.getRange(1, 1, Math.min(sh.getLastRow(), 500), sh.getLastColumn());
  const out = {
    ok: true,
    bg: range.getBackgrounds(),
    fc: range.getFontColors(),
    bold: range.getFontWeights().map(r => r.map(w => w === 'bold' ? 1 : 0)),
    merges: range.getMergedRanges().map(m => [m.getRow(), m.getColumn(), m.getNumRows(), m.getNumColumns()]),
  };
  try { cache.put(key, JSON.stringify(out), 300); } catch (err) { /* ใหญ่เกิน cache */ }
  return out;
}

// ตัวเลือก dropdown (Data validation) ของคอลัมน์ที่แก้ได้ในแท็บนั้น + สีของตัวเลือกตามที่แสดงในชีท
// สีอ่านจากหน้า HTML ของชีท จึงได้เฉพาะตัวเลือกที่มีคนเลือกใช้อยู่แล้ว
function tabOptions(gid) {
  gid = String(gid);
  const roster = isRoster(gid);
  const cache = CacheService.getScriptCache(), key = 'opts:' + gid;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()
    .find(s => String(s.getSheetId()) === gid);
  if (!sh) throw new Error('ไม่พบแท็บ');
  const headerRow = roster ? ROSTER_HEADER_ROW : 1;
  const lastCol = sh.getLastColumn();
  if (sh.getLastRow() <= headerRow) return { ok: true, cols: {}, colors: {} };
  const names = sh.getRange(headerRow, 1, 1, lastCol).getDisplayValues()[0];
  // dropdown อาจตั้งไว้ไม่ครบทุกแถว: ไล่หาแถวแรกของแต่ละคอลัมน์ที่มีการตั้งค่า
  const nRows = Math.min(sh.getLastRow() - headerRow, 500);
  const rules = sh.getRange(headerRow + 1, 1, nRows, lastCol).getDataValidations();
  const cols = {}, types = {};
  names.forEach((n, i) => {
    n = String(n).trim();
    if (roster ? ROSTERS[gid].indexOf(n) < 0 : !isItemEditable(n)) return;
    const rule = (rules.find(r => r[i]) || [])[i];
    types[n] = rule ? String(rule.getCriteriaType()) : 'ไม่มี dropdown';
    const list = listOf(rule);
    if (list.length) cols[i + 1] = list;
  });
  // สีของตัวเลือก หน้าเว็บอ่านเองจากหน้าชีท (การโหลดหน้าชีทจากสคริปต์ช้าและได้ผลว่าง)
  const out = { ok: true, cols, colors: {}, types };
  try { cache.put(key, JSON.stringify(out), 600); } catch (err) { /* ใหญ่เกิน cache */ }
  return out;
}

function listOf(rule) {
  if (!rule) return [];
  const type = rule.getCriteriaType(), v = rule.getCriteriaValues();
  const C = SpreadsheetApp.DataValidationCriteria;
  if (type === C.VALUE_IN_LIST) return v[0].map(String).filter(String);
  if (type === C.VALUE_IN_RANGE) return [].concat(...v[0].getDisplayValues()).map(String).filter(String);
  return [];
}

function setRosterCell(prm) {
  const gid = String(prm.gid || ROSTER_GID);
  if (!isRoster(gid)) throw new Error('แท็บนี้ไม่ใช่แท็บแบบรายชื่อ');
  const editable = ROSTERS[gid];
  const sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()
    .find(s => String(s.getSheetId()) === gid);
  if (!sh) throw new Error('ไม่พบแท็บรายชื่อ');
  let col = Number(prm.col);
  let row = Number(prm.row);
  if (!(col >= 1 && col <= sh.getLastColumn())) throw new Error('คอลัมน์ไม่ถูกต้อง');
  const value = String(prm.value || '').slice(0, 1000);

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // หัวตาราง 2 ชั้น: แถว 1 = หัวสัปดาห์ (ผสานเซลล์ = ช่องว่างต่อจากข้อความ), แถว 2 = ชื่อคอลัมน์
    const lastCol = sh.getLastColumn();
    const heads = sh.getRange(1, 1, ROSTER_HEADER_ROW, lastCol).getDisplayValues();
    const weekOf = c => { for (let k = c - 1; k >= 0; k--) { const v = String(heads[0][k]).trim(); if (v) return v; } return ''; };
    const nameOf = c => String(heads[ROSTER_HEADER_ROW - 1][c - 1]).trim();
    const header = String(prm.header || nameOf(col)).trim();
    if (editable.indexOf(header) < 0) throw new Error('แก้ได้เฉพาะคอลัมน์ ' + editable.join(', '));
    // คอลัมน์ชื่อซ้ำกันได้ในแต่ละสัปดาห์: ต้องตรงทั้งชื่อคอลัมน์และหัวสัปดาห์ ถ้าคอลัมน์เลื่อน ให้ค้นหาใหม่
    const week = String(prm.week || '').trim();
    const ok = c => nameOf(c) === header && (!week || weekOf(c) === week);
    if (!ok(col)) {
      col = 0;
      for (let c = 1; c <= lastCol; c++) if (ok(c)) { col = c; break; }
      if (!col) throw new Error('ไม่พบคอลัมน์ ' + header + (week ? ' ของ ' + week.split('\n')[0] : '') + ' กรุณาโหลดข้อมูลใหม่');
    }
    // ตรวจว่าแถวยังเป็นคนเดิม (ถ้ามีการแทรก/ลบแถว ให้ค้นจากชื่อ)
    const ncol = Number(prm.ncol), name = String(prm.name || '').trim();
    if (ncol >= 1 && name) {
      const at = r => r > ROSTER_HEADER_ROW && r <= sh.getLastRow() && String(sh.getRange(r, ncol).getDisplayValue()).trim() === name;
      if (!at(row)) {
        const names = sh.getRange(1, ncol, sh.getLastRow(), 1).getDisplayValues();
        row = names.findIndex((v, i) => i >= ROSTER_HEADER_ROW && String(v[0]).trim() === name) + 1;
        if (row < 1) throw new Error('ไม่พบชื่อ ' + name + ' ในชีท กรุณาโหลดข้อมูลใหม่');
      }
    } else if (!(row > ROSTER_HEADER_ROW)) {
      throw new Error('แถวไม่ถูกต้อง');
    }
    sh.getRange(row, col).setValue(value);
    noteEditor(sh.getRange(row, col), prm.editor, header);
    CacheService.getScriptCache().removeAll(['opts:' + gid, 'notes:' + gid]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, row, col, value };
}

// ---------- แก้ไขหน้ารายการ (ทุกแท็บที่มีหัวตารางในแถว 1) ----------
// แก้ได้เฉพาะคอลัมน์ที่หัวตารางขึ้นต้นด้วยชื่อเหล่านี้ เช่น "วิธีตรวจสอบ/ทดสอบ", "ผลการทดสอบ MySQL"
const ITEM_EDITABLE = ['ระบบงาน', 'ปัญหาที่พบ', 'สิ่งที่แก้ไข', 'วิธีตรวจสอบ', 'ผลการทดสอบ', 'หมายเหตุ'];
const isItemEditable = h => ITEM_EDITABLE.some(x => String(h).trim().indexOf(x) === 0);

// หาแถวและคอลัมน์ของช่องที่จะแก้ (ถ้ามีการแทรกแถว/คอลัมน์ ให้ค้นจากหัวข้อและชื่อคอลัมน์)
function resolveItemCell(p) {
  if (isRoster(p.gid)) throw new Error('แท็บนี้ใช้การแก้ไขของหน้ารายชื่อ');
  const sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()
    .find(s => String(s.getSheetId()) === String(p.gid));
  if (!sh) throw new Error('ไม่พบแท็บ');
  const header = String(p.header || '').trim();
  if (!isItemEditable(header)) throw new Error('แก้ได้เฉพาะคอลัมน์ ' + ITEM_EDITABLE.join(', '));
  const heads = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].map(h => String(h).trim());
  let col = Number(p.col);
  if (heads[col - 1] !== header) {
    col = heads.indexOf(header) + 1;
    if (col < 1) throw new Error('ไม่พบคอลัมน์ ' + header + ' ในแถวหัวตาราง กรุณาโหลดข้อมูลใหม่');
  }
  // คอลัมน์ที่ใช้ระบุแถว (หัวข้อ/ลำดับ) อาจเลื่อน: หาตำแหน่งใหม่จากชื่อหัวตาราง
  (p.match || []).forEach(m => { if (m.header && heads[m.col - 1] !== m.header) { const c = heads.indexOf(m.header); if (c >= 0) m.col = c + 1; } });
  const row = findRow(sh, p);
  if (row < 2) throw new Error('แถวไม่ถูกต้อง');
  return { sh, row, col };
}

function setItemCell(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const c = resolveItemCell(p);
    const value = String(p.value == null ? '' : p.value).slice(0, 40000);
    c.sh.getRange(c.row, c.col).setValue(value);
    noteEditor(c.sh.getRange(c.row, c.col), p.editor, p.header);
    CacheService.getScriptCache().remove('notes:' + p.gid);
    return { ok: true, row: c.row, col: c.col };
  } finally {
    lock.releaseLock();
  }
}

// อ่านค่าปัจจุบันของช่อง (หน้าเว็บใช้ยืนยันหลังส่งแบบ POST ซึ่งอ่านคำตอบไม่ได้)
function getItemCell(p) {
  const c = resolveItemCell(p);
  return { ok: true, row: c.row, col: c.col, value: String(c.sh.getRange(c.row, c.col).getDisplayValue()) };
}

// ---------- ลบรูป ----------
// ลบได้เฉพาะรูปที่อัปโหลดผ่านระบบนี้ (อยู่ในโฟลเดอร์ที่กำหนดและมีคำอธิบาย row:) → ย้ายไปถังขยะของ Drive
function deleteImage(prm) {
  const id = String(prm.id || '');
  if (!/^[\w-]{20,}$/.test(id)) throw new Error('รหัสไฟล์ไม่ถูกต้อง');
  const file = DriveApp.getFileById(id);
  if ((file.getDescription() || '').indexOf(KEY_PREFIX) !== 0) throw new Error('ลบได้เฉพาะรูปที่อัปโหลดผ่านระบบนี้');
  let inFolder = false;
  const parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === FOLDER_ID) inFolder = true;
  if (!inFolder) throw new Error('ลบได้เฉพาะรูปในโฟลเดอร์เก็บรูปของระบบ');
  file.setTrashed(true);
  PropertiesService.getScriptProperties().deleteProperty(IMG_PREFIX + id);

  // เอาลิงก์ของรูปนี้ออกจากช่องภาพในชีท (ถ้ามี)
  let sheetUpdated = false;
  try {
    const p = JSON.parse(prm.p || '{}');
    const sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()
      .find(s => String(s.getSheetId()) === String(p.gid));
    if (sh && p.col) {
      const lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        const cell = sh.getRange(findRow(sh, p), p.col);
        const old = String(cell.getDisplayValue() || '');
        if (old.indexOf(id) >= 0) {
          cell.setValue(old.split('\n').filter(l => l.indexOf(id) < 0).join('\n').trim());
          sheetUpdated = true;
        }
      } finally {
        lock.releaseLock();
      }
    }
  } catch (err) { /* ลบไฟล์แล้ว ส่วนชีทไม่สำคัญ */ }
  return { ok: true, sheetUpdated };
}

// ---------- ผู้ที่กำลังดู ----------
function presence(prm) {
  // ใช้ชื่อ vid เพราะ c และ sid เป็นพารามิเตอร์ที่ Apps Script สงวนไว้
  const sid = String(prm.vid || '');
  if (!/^[\w-]{8,64}$/.test(sid)) throw new Error('vid ไม่ถูกต้อง');
  // ตรวจ token นอก lock เพราะต้องเรียกไปที่ Google
  const profile = prm.token ? verifyIdToken(prm.token) : null;
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  let map = JSON.parse(cache.get('presence') || '{}');
  if (lock.tryLock(3000)) try {
    map = JSON.parse(cache.get('presence') || '{}');
    const now = Date.now();
    for (const k in map) if (now - map[k].last > PRESENCE_TTL_MS) delete map[k];
    if (prm.action === 'leave') {
      delete map[sid];
    } else {
      const cur = map[sid] || {};
      const user = prm.signout ? null : (profile || cur.user || null);
      map[sid] = { last: now, user };
    }
    cache.put('presence', JSON.stringify(map), 21600);
  } finally {
    lock.releaseLock();
  }
  // รวมหลายแท็บของบัญชีเดียวกันเป็นคนเดียว
  const people = {}, me = map[sid] && map[sid].user;
  let guests = 0;
  for (const k in map) {
    const u = map[k].user;
    if (u) people[u.email] = u; else guests++;
  }
  return { ok: true, you: me || null, viewers: Object.values(people), guests, loginEnabled: !!GOOGLE_CLIENT_ID };
}

// ยืนยัน ID token กับ Google (ปลอมชื่อไม่ได้)
function verifyIdToken(token) {
  if (!GOOGLE_CLIENT_ID) return null;
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  const t = JSON.parse(res.getContentText());
  if (t.aud !== GOOGLE_CLIENT_ID || Number(t.exp) * 1000 < Date.now()) return null;
  return { email: t.email, name: t.name || t.email, picture: t.picture || '' };
}

function doPost(e) {
  // แก้ไขช่องในหน้ารายการ (ส่งแบบ POST เพราะข้อความยาว)
  try {
    const body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : null;
    if (body && body.action === 'setitem') return reply(setItemCell(body));
  } catch (err) {
    return reply({ ok: false, error: String((err && err.message) || err) });
  }
  // navigator.sendBeacon ตอนปิดหน้า: ?action=leave&vid=...
  if (e && e.parameter && e.parameter.action === 'leave') {
    try { presence(e.parameter); } catch (err) { /* ไม่ต้องทำอะไร */ }
    return reply({ ok: true });
  }
  try {
    const p = JSON.parse(e.postData.contents);
    if (!/^image\//.test(p.mimeType || '')) throw new Error('รองรับเฉพาะไฟล์รูปภาพ');
    if (!p.key) throw new Error('ไม่ได้ระบุข้อที่อัปโหลด');
    const bytes = Utilities.base64Decode(p.data);
    if (bytes.length > MAX_BYTES) throw new Error('ไฟล์ใหญ่เกินไป');

    const name = [p.sheetName, p.no, p.filename || 'image'].filter(String).join('_');
    const file = getFolder().createFile(Utilities.newBlob(bytes, p.mimeType, name));
    file.setDescription(KEY_PREFIX + p.key);
    PropertiesService.getScriptProperties().setProperty(IMG_PREFIX + file.getId(),
      JSON.stringify({ k: p.key, n: name, c: Date.now() }));
    const warnings = [];
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (err) {
      warnings.push('ตั้งค่าแชร์ลิงก์ไม่ได้: ' + err.message);
    }
    const url = 'https://drive.google.com/file/d/' + file.getId() + '/view';

    // เขียนลิงก์ลงชีทด้วย (ถ้าไม่สำเร็จ รูปยังแสดงได้จากรายการใน Drive)
    let value = null, row = null;
    try {
      const sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()
        .find(s => String(s.getSheetId()) === String(p.gid));
      if (!sh) throw new Error('ไม่พบชีท');
      const lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        row = findRow(sh, p);
        const cell = sh.getRange(row, p.col);
        const old = String(cell.getDisplayValue() || '').trim();
        value = old && old !== '-' ? old + '\n' + url : url;
        cell.setValue(value);
      } finally {
        lock.releaseLock();
      }
    } catch (err) {
      warnings.push('เขียนลิงก์ลงชีทไม่ได้: ' + err.message);
    }
    return reply({ ok: true, id: file.getId(), url, value, row, warnings });
  } catch (err) {
    return reply({ ok: false, error: String((err && err.message) || err) });
  }
}

// หาแถวจากเลขแถวที่ส่งมา ถ้าข้อมูลไม่ตรง (มีการแทรก/ลบแถว) ให้ค้นจากค่าที่ใช้ตรวจสอบ
function findRow(sh, p) {
  const match = p.match || [];
  if (!match.length) throw new Error('ไม่มีข้อมูลสำหรับระบุแถว');
  const same = (v, m) => String(v).trim() === m.value;
  if (p.row >= 1 && p.row <= sh.getLastRow()) {
    const vals = sh.getRange(p.row, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    if (match.every(m => same(vals[m.col - 1], m))) return p.row;
  }
  const all = sh.getDataRange().getDisplayValues();
  for (let i = 0; i < all.length; i++) {
    if (match.every(m => same(all[i][m.col - 1], m))) return i + 1;
  }
  throw new Error('ไม่พบแถวนี้ในชีท');
}

function getFolder() {
  try { return DriveApp.getFolderById(FOLDER_ID); }
  catch (e) { throw new Error('เปิดโฟลเดอร์เก็บรูปใน Google Drive ไม่ได้ (บัญชีที่ Deploy ต้องมีสิทธิ์แก้ไขโฟลเดอร์นี้)'); }
}

function reply(o, callback) {
  const body = JSON.stringify(o);
  if (callback && /^[\w.]+$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + body + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}
