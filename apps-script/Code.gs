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
const PRESENCE_TTL_MS = 90 * 1000; // ไม่ส่งสัญญาณเกินเวลานี้ = ออกไปแล้ว

// GET ?action=list → รายการรูปทั้งหมดพร้อมข้อที่อัปโหลด
// GET ?action=ping&sid=... → แจ้งว่ายังเปิดดูอยู่ และรับรายชื่อผู้ที่กำลังดู
// (ทุก action รองรับ ?callback= แบบ JSONP)
function doGet(e) {
  const prm = (e && e.parameter) || {};
  let out;
  if (prm.action === 'delete') {
    try { out = deleteImage(prm); }
    catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
  } else if (prm.action === 'ping' || prm.action === 'leave') {
    try { out = presence(prm); }
    catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
  } else if (prm.action === 'list') {
    try {
      const files = [];
      const it = getFolder().getFiles();
      while (it.hasNext()) {
        const f = it.next();
        const desc = f.getDescription() || '';
        if (desc.indexOf(KEY_PREFIX) !== 0) continue;
        files.push({ id: f.getId(), key: desc.slice(KEY_PREFIX.length), name: f.getName(), created: f.getDateCreated().getTime() });
      }
      files.sort((a, b) => a.created - b.created);
      out = { ok: true, files };
    } catch (err) {
      out = { ok: false, error: String((err && err.message) || err) };
    }
  } else {
    out = { ok: true, message: 'upload service is running' };
  }
  return reply(out, prm.callback);
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
  const sid = String(prm.sid || '');
  if (!/^[\w-]{8,64}$/.test(sid)) throw new Error('sid ไม่ถูกต้อง');
  // ตรวจ token นอก lock เพราะต้องเรียกไปที่ Google
  const profile = prm.token ? verifyIdToken(prm.token) : null;
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let map;
  try {
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
  // navigator.sendBeacon ตอนปิดหน้า: ?action=leave&sid=...
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
