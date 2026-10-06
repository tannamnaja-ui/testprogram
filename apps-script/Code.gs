/**
 * รับรูปจากหน้า "สรุปการทดสอบ HOSxP XE" → เก็บใน Google Drive → เขียนลิงก์ลงคอลัมน์ภาพของแถวนั้น
 *
 * วิธีติดตั้ง (ทำครั้งเดียว ด้วยบัญชีที่แก้ไข Google Sheet ได้)
 * 1. เปิด Google Sheet > ส่วนขยาย (Extensions) > Apps Script
 * 2. ลบโค้ดเดิมในไฟล์ Code.gs แล้ววางโค้ดทั้งหมดนี้ > กดบันทึก
 * 3. กด ทำให้ใช้งานได้ (Deploy) > การทำให้ใช้งานได้รายการใหม่ (New deployment)
 *    - เลือกประเภท: เว็บแอป (Web app)
 *    - ดำเนินการในฐานะ (Execute as): ฉัน (Me)
 *    - ผู้ที่มีสิทธิ์เข้าถึง (Who has access): ทุกคน (Anyone)
 * 4. กด Deploy > อนุญาตสิทธิ์ (Authorize) > คัดลอก URL ของเว็บแอป (ลงท้ายด้วย /exec)
 * 5. นำ URL ไปใส่ในค่า UPLOAD_URL ช่วงต้นของสคริปต์ในไฟล์ index.html
 *
 * ถ้าแก้โค้ดนี้ภายหลัง ต้อง Deploy > จัดการการทำให้ใช้งานได้ > แก้ไข > เวอร์ชันใหม่ ทุกครั้ง
 */
const SPREADSHEET_ID = '1U5eVS4zEt4g4D1YCwjoToaZEymw9TA-RZBCECkY134s';
// โฟลเดอร์เก็บรูป: https://drive.google.com/drive/u/0/folders/1fwD2jPox8GojPEENajr2jLTt_9NUfZTH
const FOLDER_ID = '1fwD2jPox8GojPEENajr2jLTt_9NUfZTH';
const MAX_BYTES = 15 * 1024 * 1024;

function doGet() {
  return json({ ok: true, message: 'upload service is running' });
}

function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents);
    if (!/^image\//.test(p.mimeType || '')) throw new Error('รองรับเฉพาะไฟล์รูปภาพ');
    const bytes = Utilities.base64Decode(p.data);
    if (bytes.length > MAX_BYTES) throw new Error('ไฟล์ใหญ่เกินไป');

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sh = ss.getSheets().find(s => String(s.getSheetId()) === String(p.gid));
    if (!sh) throw new Error('ไม่พบชีทที่ต้องการ');

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    let value, row, url;
    try {
      // หาแถวให้เจอก่อน แล้วจึงสร้างไฟล์ เพื่อไม่ให้มีไฟล์ค้างใน Drive เมื่อหาแถวไม่เจอ
      row = findRow(sh, p);
      const file = getFolder().createFile(Utilities.newBlob(bytes, p.mimeType, p.filename || 'image'));
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      url = 'https://drive.google.com/file/d/' + file.getId() + '/view';
      const cell = sh.getRange(row, p.col);
      const old = String(cell.getDisplayValue() || '').trim();
      value = old && old !== '-' ? old + '\n' + url : url;
      cell.setValue(value);
    } finally {
      lock.releaseLock();
    }
    return json({ ok: true, url, value, row });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
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
  throw new Error('ไม่พบแถวนี้ในชีท (ข้อมูลอาจถูกแก้ไข) กรุณากดโหลดข้อมูลใหม่แล้วลองอีกครั้ง');
}

function getFolder() {
  try { return DriveApp.getFolderById(FOLDER_ID); }
  catch (e) { throw new Error('เปิดโฟลเดอร์เก็บรูปใน Google Drive ไม่ได้ (บัญชีที่ Deploy ต้องมีสิทธิ์แก้ไขโฟลเดอร์นี้)'); }
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
