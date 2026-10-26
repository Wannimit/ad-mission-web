/**
 * AD Mission — Kubota Care tracking backend
 *
 * Apps Script ผูกกับ Google Sheet "Kubota Care tracking" โดยตรง (Extensions > Apps Script)
 * Deploy เป็น Web App แล้วให้ check.html / admin.html เรียกผ่าน fetch แทนการฝัง data.js
 *
 * เหตุผล: data.js เดิมฝังข้อมูล phone + ผลงานของพนักงาน "ทุกคน" ไว้ฝั่ง client
 * ใครเปิด dev tools ก็เห็นข้อมูลคนอื่นได้หมด — ไฟล์นี้แก้ปัญหานั้นโดยให้ server
 * เป็นคนกรองข้อมูลก่อนส่ง ไม่ส่ง dataset เต็มไปที่ client อีกต่อไป อ่านสดจากชีตทุกครั้ง (real-time)
 *
 * Endpoints (GET ทั้งหมด):
 *   ?mode=personal&phone=1234567890123     -> ข้อมูลเฉพาะของพนักงานคนนั้น (ใช้ใน check.html)
 *   ?mode=admin&password=...             -> ภาพรวมทั้งแคมเปญ + เบอร์โทรพนักงาน (เฉพาะหลังผ่านรหัสผ่าน admin) (ใช้ใน admin.html)
 *   ?mode=stamp&password=...             -> Admin กดปุ่ม "แสตมป์อัตโนมัติ" เพื่อล็อกจำนวนบัตรที่ได้สิทธิ์จริง
 *                                            เรียงตามเวลาที่ครบ 4 register จริง (submitted_at) ข้ามทุกคน/ทุกร้าน
 *                                            (กันโควตา bracket แจกเกิน) — idempotent เรียกซ้ำได้ไม่แสตมป์ซ้ำ
 *
 * referrerPhone อ่านจากคอลัมน์ comment_care ของชีต "ผลการสมัคร" เท่านั้น (ไม่ใช้ suggestion_care แล้ว
 * — เคยลอง fallback ไป suggestion_care แต่ทำให้ชีตปัญหาซับซ้อนขึ้นจนพัง เลยตัดสินใจตัดออก)
 * AD/AD_Size (คอลัมน์ F/G ของชีต "ผลการสมัคร") เป็น ARRAYFORMULA lookup จาก comment_care — ห้ามแก้มือ
 */

const SHEET_REGISTRATIONS = 'ผลการสมัคร';
const SHEET_CRITERIA = 'เกณฑ์';
const SHEET_MEMBERS = 'พนักงานที่เข้าร่วม';
const SHEET_AD_SIZE = 'ขนาด AD';
const SHEET_ADMIN = 'Admin';
const SHEET_STAMPS = 'บัตรที่แจกแล้ว';
const SHEET_UUID = 'UUID';
const SHEET_SUSPECT = 'Suspect';

const CAMPAIGN = {
  pointsPerCard: 4,   // ทุก 4 คนที่แนะนำสำเร็จ = 1 บัตร
  cardValueBaht: 100, // บัตร Lotus's 1 ใบ = 100 บาท
  capBaht: 1000,      // เพดานสูงสุด/คน = 1,000 บาท
};
CAMPAIGN.maxCardsPerPerson = CAMPAIGN.capBaht / CAMPAIGN.cardValueBaht; // 10
CAMPAIGN.maxReferralsPerPerson = CAMPAIGN.maxCardsPerPerson * CAMPAIGN.pointsPerCard; // 40

// วันที่เปิดให้กดแลกบัตรจริงผ่าน Google Form — hardcode ตามที่ Planner/user ตกลงกัน (2569-09-22)
const REDEEM_OPENS_AT = '2026-12-01';

function doGet(e) {
  try {
    const mode = (e.parameter.mode || '').trim();
    if (mode === 'admin') {
      const role = getAdminRole_(String(e.parameter.password || ''));
      if (!role) return jsonOut_({ error: 'UNAUTHORIZED' });
      if (role.denied) return jsonOut_({ error: 'NO_ACCESS' });
      return jsonOut_(buildAdminSummary(role));
    }
    if (mode === 'personal') {
      const phone = String(e.parameter.phone || '').replace(/\D/g, '');
      if (phone.length < 9 || phone.length > 10) return jsonOut_({ error: 'INVALID_PHONE' });
      return jsonOut_(buildPersonalSummary(phone));
    }
    if (mode === 'stamp') {
      const role = getAdminRole_(String(e.parameter.password || ''));
      if (!role) return jsonOut_({ error: 'UNAUTHORIZED' });
      if (role.denied) return jsonOut_({ error: 'NO_ACCESS' });
      if (role.regions) return jsonOut_({ error: 'FORBIDDEN' }); // user ระดับเขตสั่งแสตมป์ไม่ได้
      return jsonOut_(runStampAndSuspect());
    }
    return jsonOut_({ error: 'INVALID_MODE' });
  } catch (err) {
    return jsonOut_({ error: 'SERVER_ERROR', message: String(err) });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- อ่านชีตเป็น array of object ตาม header แถวแรก ----------
function readSheetAsObjects_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) throw new Error('ไม่พบแผ่นงาน: ' + sheetName);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(function (h) { return String(h).trim(); });
  return values.slice(1)
    .filter(function (row) { return row.some(function (cell) { return cell !== '' && cell !== null; }); })
    .map(function (row) {
      const obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });
}

function formatDate_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss");
  }
  return String(v || '');
}

// ---------- ตรวจว่าลูกค้าลงทะเบียนจากเครื่องของพนักงานเองหรือไม่ ----------
// ชีต "UUID": kubota_id_UUID | device_id | submitted_at — device_id คือ JSON array ของ token เครื่องที่ใช้ลงทะเบียน
// 1 เครื่องควรเป็นของลูกค้า 1 คน ถ้า token เดียวกันโผล่กับหลาย kubota_id แปลว่าเครื่องเดียวลงทะเบียนหลายบัญชี (น่าจะเป็นเครื่องพนักงาน)
// คืน { kubota_id: true } ของทุกบัญชีที่ใช้เครื่องร่วมกับบัญชีอื่น — ไม่มีชีตนี้ก็ไม่ทำให้ระบบพัง (ไม่ติดธงใคร)
function parseDeviceTokens_(v) {
  const s = String(v || '').trim();
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    if (Array.isArray(a)) return a.filter(function (t) { return typeof t === 'string' && t; });
  } catch (e) {}
  return [];
}

function readDeviceMap_() {
  const idToTokens = {};
  const tokenToIds = {};
  let rows;
  try { rows = readSheetAsObjects_(SHEET_UUID); } catch (e) { return { idToTokens: idToTokens, tokenToIds: tokenToIds }; }
  rows.forEach(function (r) {
    const id = String(r['kubota_id_UUID'] || '').trim();
    if (!id) return;
    const tokens = parseDeviceTokens_(r['device_id']);
    idToTokens[id] = tokens;
    tokens.forEach(function (t) { (tokenToIds[t] = tokenToIds[t] || {})[id] = true; });
  });
  return { idToTokens: idToTokens, tokenToIds: tokenToIds };
}

function readSharedDeviceIds_() {
  const tokenToIds = readDeviceMap_().tokenToIds;
  const shared = {};
  Object.keys(tokenToIds).forEach(function (t) {
    const ids = Object.keys(tokenToIds[t]);
    if (ids.length > 1) ids.forEach(function (id) { shared[id] = true; });
  });
  return shared;
}

function loadAll_() {
  const sharedDeviceIds = readSharedDeviceIds_();
  const registrations = readSheetAsObjects_(SHEET_REGISTRATIONS)
    .map(function (r) {
      return {
        kubotaId: String(r['kubota_id'] || '').trim(),
        sharedDevice: !!sharedDeviceIds[String(r['kubota_id'] || '').trim()], // เครื่องที่ลงทะเบียนถูกใช้กับบัญชีอื่นด้วย
        customerName: r['name'],
        submittedAt: formatDate_(r['submitted_at']),
        referrerPhone: String(r['comment_care'] || '').replace(/\D/g, ''), // เบอร์โทรของช่างผู้แนะนำ
        adSize: r['AD_Size'],
        adName: r['AD'],
      };
    })
    .filter(function (r) { return r.referrerPhone.length >= 9 && r.referrerPhone.length <= 10; }) // ต้องเป็นเบอร์โทร 9-10 หลักเท่านั้น
    // ลูกค้าคนเดียวกัน (kubota_id ซ้ำ) ลงทะเบียนหลายแถว นับเป็น 1 ครั้งของผู้แนะนำ — เก็บแถวที่ส่งก่อนสุด
    .sort(function (a, b) { return a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0; })
    .filter((function () {
      const seen = {};
      return function (r) {
        if (!r.kubotaId) return true;
        if (seen[r.kubotaId]) return false;
        seen[r.kubotaId] = true;
        return true;
      };
    })());

  const brackets = readSheetAsObjects_(SHEET_CRITERIA).map(function (b) {
    return {
      size: b['AD_size'],
      stores: Number(b['จำนวนร้าน'] || 0),
      cardQuota: Number(b['บัตรโควตา'] || 0),
      userTarget: Number(b['ผู้ใช้ใหม่เป้า'] || 0),
      budget: Number(b['งบประมาณบาท'] || 0),
    };
  });

  const members = readSheetAsObjects_(SHEET_MEMBERS).map(function (m) {
    return {
      name: m['Name'],
      phone: String(m['phone'] || '').replace(/\D/g, ''),
      // คอลัมน์วันที่ลงทะเบียนเข้าร่วม — ชื่อคอลัมน์จริงในชีตคือ "ประทับเวลา" (ยืนยันแล้วกับ user)
      joinedAt: formatDate_(m['ประทับเวลา'] || m['Timestamp'] || m['วันที่'] || ''),
      memberStore: String(m['ร้านผู้แทนจำหน่าย'] || '').trim(), // ร้านที่พนักงานลงทะเบียนไว้ — ใช้จัดเข้าเขตของ user ระดับเขต
    };
  });

  return { registrations: registrations, brackets: brackets, members: members };
}

// ---------- อ่านแผ่นงาน "ขนาด AD": ชื่อร้าน (หัวคอลัมน์ "AD" ถ้าไม่มีใช้คอลัมน์ A), ขนาด, จำนวนพนักงานในร้าน (คอลัมน์ E) ----------
// อ่านคอลัมน์ E ตามตำแหน่ง (index 4) ตามที่ user ระบุ ไม่ผูกกับชื่อหัวตาราง — ถ้าไม่มีแผ่นงานนี้ไม่ทำให้ admin พัง
function readAdStores_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_AD_SIZE);
  if (!sheet) return [];
  // getDisplayValues กันรหัสร้าน (เช่น 0810) ที่เก็บเป็นตัวเลขแล้วเลข 0 นำหน้าหาย
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];
  // แผ่นงานนี้มีแถวชื่อเรื่องอยู่บนหัวตาราง (ซึ่งมีคำว่า "ชื่อร้าน" ปนอยู่ในประโยคด้วย) — หาแถวหัวตารางจากเซลล์ที่เป็น "Bracket" เป๊ะๆ
  let headerRow = -1;
  for (let i = 0; i < Math.min(values.length, 10); i++) {
    if (values[i].some(function (c) { return String(c).trim() === 'Bracket'; })) { headerRow = i; break; }
  }
  if (headerRow < 0) return [];
  const headers = values[headerRow].map(function (h) { return String(h).trim(); });
  function findCol(pred, fallback) {
    for (let i = 0; i < headers.length; i++) if (pred(headers[i])) return i;
    return fallback;
  }
  const nameIdx = findCol(function (h) { return h.indexOf('ชื่อร้าน') === 0; }, 3);
  const sizeIdx = findCol(function (h) { return h === 'Bracket' || h === 'AD_Size' || h === 'AD_size'; }, 0);
  const staffIdx = findCol(function (h) { return h.indexOf('จำนวนช่าง') >= 0; }, 4);
  const codeIdx = findCol(function (h) { return h.indexOf('รหัสร้าน') === 0; }, -1);
  const regionIdx = findCol(function (h) { return h.indexOf('เขต') === 0; }, -1);
  const centerIdx = findCol(function (h) { return h.indexOf('ศูนย์') === 0; }, -1);
  function cellText(row, idx) { return idx >= 0 ? String(row[idx] == null ? '' : row[idx]).trim() : ''; }
  return values.slice(headerRow + 1)
    .filter(function (row) { return String(row[nameIdx] || '').trim() !== ''; })
    .map(function (row) {
      return {
        adName: String(row[nameIdx]).trim(),
        adSize: row[sizeIdx],
        staffCount: Number(row[staffIdx]) || 0,
        storeCode: cellText(row, codeIdx),
        region: cellText(row, regionIdx),
        center: cellText(row, centerIdx),
      };
    });
}

// ---------- ตรวจรหัสผ่านหน้า admin กับแผ่นงาน "Admin" และหาสิทธิ์ (ทุกเขต / เฉพาะเขต) ----------
// แผ่นงาน Admin: label | password | region
//   region = SuperAdmin / ALL / ทั้งหมด (ต้องเขียนชัดๆ) = เห็นทุกเขต + สั่งแสตมป์ได้
//   region ว่าง (หรือไม่มีคอลัมน์ region) = ไม่เห็นข้อมูลเลย (NO_ACCESS)
//   region = ค่าในคอลัมน์ "เขต" ของแผ่นงาน "ขนาด AD" เป๊ะๆ เช่น กลางตะวันตก (ใส่หลายเขตคั่นด้วย , ได้) = เห็นเฉพาะ AD ในเขตนั้น ไม่เห็นแสตมป์
// คืน null ถ้ารหัสผ่านผิด
function getAdminRole_(password) {
  if (!password) return null;
  const rows = readSheetAsObjects_(SHEET_ADMIN);
  const row = rows.filter(function (r) { return String(r['password'] || '') === password; })[0];
  if (!row) return null;
  const label = String(row['label'] || '');
  const parts = String(row['region'] || '').split(/[,;]/)
    .map(function (x) { return x.trim(); })
    .filter(function (x) { return x; });
  const isAllKeyword = function (x) { return x === 'ทั้งหมด' || x.toUpperCase() === 'ALL' || x.toUpperCase() === 'SUPERADMIN'; };
  if (parts.some(isAllKeyword)) return { label: label, regions: null }; // เห็นทุกเขต — ต้องเขียนคำนี้ชัดๆ เท่านั้น
  if (!parts.length) return { label: label, regions: [], denied: true }; // region ว่าง/ไม่มีคอลัมน์ = ไม่เห็นข้อมูลเลย (กันเปิดหมดโดยไม่ตั้งใจ)
  return { label: label, regions: parts };
}

// จำนวนบัตรที่ "ควรมีสิทธิ์" ตามยอด register (ใช้ตอนแสตมป์เท่านั้น — ไม่ใช้ตัดสิน cardsEarned ที่ส่งออกโดยตรงแล้ว)
function eligibleCardsFor_(count) {
  return Math.min(Math.floor(count / CAMPAIGN.pointsPerCard), CAMPAIGN.maxCardsPerPerson);
}

// ---------- อ่านชีต "บัตรที่แจกแล้ว" นับจำนวนแถวต่อเบอร์โทร ----------
function readStamps_() {
  return readSheetAsObjects_(SHEET_STAMPS).map(function (r) {
    return {
      phone: String(r['phone'] || '').replace(/\D/g, ''),
      stampedAt: formatDate_(r['stampedAt']),
    };
  });
}

function buildEmployeeSummaries_(data, stamps) {
  const byPhone = new Map();
  data.members.forEach(function (m) {
    byPhone.set(m.phone, { name: m.name, phone: m.phone, joinedAt: m.joinedAt, memberStore: m.memberStore, referrals: [], adName: null, adSize: null });
  });
  data.registrations.forEach(function (r) {
    const s = byPhone.get(r.referrerPhone);
    if (!s) return; // เบอร์โทรใน "ผลการสมัคร" ไม่ตรงกับ whitelist "พนักงานที่เข้าร่วม" — ข้ามเงียบๆ ไม่ทำ request พัง
    s.referrals.push(r);
    if (!s.adName) { s.adName = r.adName; s.adSize = r.adSize; }
  });
  const summaries = [];
  byPhone.forEach(function (s) {
    s.referrals.sort(function (a, b) { return new Date(a.submittedAt) - new Date(b.submittedAt); });
    const count = s.referrals.length;
    const cardsEarned = eligibleCardsFor_(count); // คำนวณสดจาก referralCount ทุกครั้ง — ไม่ต้องรอแอดมินกด "แสตมป์อัตโนมัติ" อีกต่อไป
    summaries.push({
      name: s.name,
      phone: s.phone,
      joinedAt: s.joinedAt,
      memberStore: s.memberStore,
      adName: s.adName,
      adSize: s.adSize,
      referrals: s.referrals,
      suspectCount: s.referrals.filter(function (r) { return r.sharedDevice; }).length, // ลูกค้าที่ใช้เครื่องซ้ำกับบัญชีอื่น — ให้ Admin ตรวจ ยังไม่หักออกจากยอด
      referralCount: count,
      cardsEarned: cardsEarned,
      bahtEarned: cardsEarned * CAMPAIGN.cardValueBaht,
      atCap: count >= CAMPAIGN.maxReferralsPerPerson,
    });
  });
  return summaries;
}

// ---------- แสตมป์บัตรอัตโนมัติ: ใครครบ 4 คนใหม่ก็บันทึกลง "บัตรที่แจกแล้ว" ทันที ----------
// เรียกทุกครั้งที่มีคนเรียก mode=personal หรือ mode=admin (ไม่ต้องรอแอดมินกดปุ่มอีกต่อไป)
// ไม่เช็คโควตา bracket ก่อนบันทึกแล้ว (ตามที่ user ตกลง)
// idempotent: เช็ก currentStamped ต่อเบอร์โทรก่อนเสมอ เรียกซ้ำได้ไม่แสตมป์ซ้ำ
//
// เขียนแค่คอลัมน์ A (phone), E (stampedAt), F (บัตรใบที่) เท่านั้น — B (name), C (AD), D (AD_Size)
// เป็นสูตร ARRAYFORMULA lookup จาก phone เอง (ดูหัวชีต "บัตรที่แจกแล้ว") ถ้าเขียนทับ B-D ด้วย
// จะไปโดนช่วง spill ของสูตร ทำให้สูตรพัง (#REF!)
function autoStampNewCards_(data) {
  const summaries = buildEmployeeSummaries_(data, []);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_STAMPS);
  if (!sheet) throw new Error('ไม่พบแผ่นงาน: ' + SHEET_STAMPS);

  const existing = readStamps_();
  const stampedCountByPhone = {};
  existing.forEach(function (st) { stampedCountByPhone[st.phone] = (stampedCountByPhone[st.phone] || 0) + 1; });

  const now = new Date();
  const phonesToAppend = [];
  const cardNumbersToAppend = []; // บัตรใบที่เท่าไหร่ของคนนั้น (นับต่อจากที่แสตมป์ไปแล้ว)
  summaries.forEach(function (s) {
    const eligible = eligibleCardsFor_(s.referralCount);
    const already = stampedCountByPhone[s.phone] || 0;
    for (let k = already; k < eligible; k++) {
      phonesToAppend.push(s.phone);
      cardNumbersToAppend.push(k + 1);
    }
  });

  if (phonesToAppend.length > 0) {
    // ห้ามใช้ sheet.getLastRow() ตรงนี้ — คอลัมน์ B-D เป็น ARRAYFORMULA ที่ spill ยาวถึงแถว 1000
    // ทำให้ Sheets มองว่าแถวพวกนั้น "มีข้อมูล" ไปด้วย getLastRow() เลยเพี้ยนเป็นเกือบ 1000 บัตรใหม่
    // ที่เขียนจะไปโผล่แถวท้ายสุดของชีตแทนที่จะต่อจากแถวข้อมูลจริง (เจอบั๊กนี้จริงมาแล้ว บัตรหายเข้ากลีบเมฆ)
    // ใช้จำนวนแถวข้อมูลจริงจาก existing (อ่านจาก readStamps_ ซึ่งกรอง cell ว่างจาก spill ออกแล้ว) แทน
    const startRow = existing.length + 2;
    // ตั้ง format คอลัมน์ phone เป็นข้อความก่อนเขียนเสมอ ไม่งั้น Sheets จะตีความ "0914..." เป็นตัวเลข
    // แล้วตัดเลข 0 นำหน้าทิ้ง (เจอบั๊กนี้จริงมาแล้ว — เลขเพี้ยนจนจับคู่กับ phone เดิมไม่ได้อีกเลย)
    sheet.getRange(startRow, 1, phonesToAppend.length, 1).setNumberFormat('@');
    sheet.getRange(startRow, 1, phonesToAppend.length, 1).setValues(phonesToAppend.map(function (p) { return [p]; }));
    sheet.getRange(startRow, 5, phonesToAppend.length, 1).setValues(phonesToAppend.map(function () { return [now]; }));
    // คอลัมน์ F: บัตรใบที่เท่าไหร่ — เขียนตรงเป็นตัวเลข ไม่ใช้สูตร (กันปัญหา array formula spill ที่เจอมาแล้วซ้ำ)
    sheet.getRange(startRow, 6, cardNumbersToAppend.length, 1).setValues(cardNumbersToAppend.map(function (n) { return [n]; }));
  }

  // คอลัมน์ G: "ปกติ" / "suspect" ต่อแถว — suspect = ช่างคนนั้นมีลูกค้าที่ลงทะเบียนจากเครื่องซ้ำกับบัญชีอื่น (ดู readSharedDeviceIds_)
  // ติดธงอย่างเดียว ไม่ได้ระงับการแสตมป์ (แสตมป์ไปก่อนตามที่ user สั่ง) เขียนทับทุกครั้งเพราะธงเปลี่ยนได้ตามข้อมูลใหม่
  const totalRows = existing.length + phonesToAppend.length;
  if (totalRows > 0) {
    const suspectPhones = {};
    summaries.forEach(function (s) { if (s.suspectCount > 0) suspectPhones[s.phone] = true; });
    const phones = sheet.getRange(2, 1, totalRows, 1).getDisplayValues();
    sheet.getRange(1, 7).setValue('สถานะ');
    sheet.getRange(2, 7, totalRows, 1).setValues(phones.map(function (r) {
      return [suspectPhones[String(r[0]).replace(/\D/g, '')] ? 'suspect' : 'ปกติ'];
    }));
  }

  return { added: phonesToAppend.length };
}

// ---------- ชีต "Suspect": ลูกค้าที่ลงทะเบียนจากเครื่องที่ใช้กับบัญชีอื่นด้วย พร้อมพนักงานที่แนะนำและ device_id ----------
// สร้างชีตถ้ายังไม่มี และเขียนทับทั้งชีตทุกครั้ง (เป็นรายงานที่คำนวณใหม่จากข้อมูลล่าสุด ไม่ใช่ข้อมูลที่ต้องแก้มือ)
function syncSuspectSheet_(data) {
  const dm = readDeviceMap_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_SUSPECT);
  if (!sheet) sheet = ss.insertSheet(SHEET_SUSPECT);

  const memberByPhone = {};
  data.members.forEach(function (m) { memberByPhone[m.phone] = m; });
  const refById = {};
  data.registrations.forEach(function (r) { if (memberByPhone[r.referrerPhone]) refById[r.kubotaId] = r; });

  const rows = [];
  data.registrations.forEach(function (r) {
    const m = memberByPhone[r.referrerPhone];
    if (!m) return;
    (dm.idToTokens[r.kubotaId] || []).forEach(function (t) {
      const ids = Object.keys(dm.tokenToIds[t] || {});
      if (ids.length < 2) return;
      const others = ids.filter(function (id) { return id !== r.kubotaId; }).map(function (id) {
        const o = refById[id];
        return id + (o ? ' (' + ((memberByPhone[o.referrerPhone] || {}).name || o.referrerPhone) + ')' : ' (ไม่ได้อยู่ในยอดแนะนำ)');
      });
      rows.push([m.name, r.referrerPhone, r.adName, r.adSize, r.kubotaId, r.customerName, r.submittedAt, t, ids.length, others.join('; ')]);
    });
  });
  rows.sort(function (a, b) { return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[7] < b[7] ? -1 : a[7] > b[7] ? 1 : a[6] < b[6] ? -1 : 1; });

  const header = ['ชื่อพนักงาน', 'เบอร์พนักงาน', 'AD (ร้าน)', 'ขนาด AD', 'kubota_id (ลูกค้าที่แนะนำ)', 'ชื่อลูกค้า', 'วันที่ลงทะเบียน', 'device_id', 'จำนวนบัญชีที่ใช้เครื่องนี้', 'kubota_id อื่นที่ใช้เครื่องเดียวกัน (พนักงานที่แนะนำ)'];
  sheet.clearContents();
  // เบอร์/kubota_id เป็นข้อความ กัน Sheets ตัดเลข 0 นำหน้า
  sheet.getRange(1, 2, rows.length + 1, 1).setNumberFormat('@');
  sheet.getRange(1, 5, rows.length + 1, 1).setNumberFormat('@');
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length > 0) sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  sheet.setFrozenRows(1);

  const employees = {};
  rows.forEach(function (r) { employees[r[1]] = true; });
  return { rows: rows.length, employees: Object.keys(employees).length };
}

// เรียกจาก editor (Run) หรือ mode=stamp: แสตมป์บัตรที่ครบแล้ว + อัปเดตธงคอลัมน์ G + สร้าง/อัปเดตชีต Suspect
function runStampAndSuspect() {
  const data = loadAll_();
  const stamp = autoStampNewCards_(data);
  const suspect = syncSuspectSheet_(data);
  return { added: stamp.added, suspect: suspect };
}

// ---------- อัปเดตชีต Suspect + ธง G อัตโนมัติเมื่อมีการแก้ไข/วางข้อมูลในชีต "ผลการสมัคร" หรือ "UUID" ----------
// ต้องตั้งเป็น installable trigger (Triggers > Add Trigger > onEditRefreshSuspect > From spreadsheet > On edit)
// การแก้ไขจากสคริปต์ (เช่น ตอน runStampAndSuspect เขียนชีต Suspect/บัตรที่แจกแล้ว) ไม่ทำให้ onEdit ทำงานซ้ำ จึงไม่วนลูป
// กันรันถี่: รอให้การวางต่อเนื่องจบก่อน — ถ้ามีการแก้ไขใหม่กว่าระหว่างรอ รอบเก่าจะออกไปเฉยๆ ให้รอบใหม่เป็นคนรันแทน (รันครั้งเดียวต่อชุดการแก้ไข)
const AUTO_SUSPECT_SHEETS = [SHEET_REGISTRATIONS, SHEET_UUID];
const AUTO_SUSPECT_WAIT_MS = 15000;

function onEditRefreshSuspect(e) {
  if (!e || !e.range || AUTO_SUSPECT_SHEETS.indexOf(e.range.getSheet().getName()) < 0) return;
  const props = PropertiesService.getScriptProperties();
  const stamp = Date.now() + '-' + Math.random(); // ต่อค่าสุ่มกัน event ที่เกิดในมิลลิวินาทีเดียวกันได้ตราเท่ากัน
  props.setProperty('SUSPECT_EDIT_AT', stamp);
  Utilities.sleep(AUTO_SUSPECT_WAIT_MS);
  if (props.getProperty('SUSPECT_EDIT_AT') !== stamp) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return; // มีรอบอื่นกำลังรันอยู่ — รอบนั้นอ่านข้อมูลล่าสุดอยู่แล้ว
  try {
    runStampAndSuspect();
  } finally {
    lock.releaseLock();
  }
}

function buildBracketSummaries_(data, employeeSummaries, stamps) {
  return data.brackets.map(function (b) {
    const empsInBracket = employeeSummaries.filter(function (e) { return e.adSize === b.size; });
    const cardsUsed = empsInBracket.reduce(function (sum, e) { return sum + e.cardsEarned; }, 0);
    const storesActive = new Set(
      empsInBracket.filter(function (e) { return e.referralCount > 0; }).map(function (e) { return e.adName; })
    ).size;
    return {
      size: b.size,
      stores: b.stores,
      cardQuota: b.cardQuota,
      userTarget: b.userTarget,
      budget: b.budget,
      cardsUsed: cardsUsed,
      cardsRemaining: b.cardQuota - cardsUsed,
      storesActive: storesActive,
    };
  });
}

// ---------- mode=personal: กรองเหลือแค่ข้อมูลของเบอร์โทรที่ขอมาเท่านั้น ----------
function buildPersonalSummary(phone) {
  const data = loadAll_();
  const member = data.members.filter(function (m) { return m.phone === phone; })[0];
  if (!member) return { error: 'NOT_FOUND' };

  autoStampNewCards_(data); // ใครครบ 4 คนใหม่ก็บันทึกลง "บัตรที่แจกแล้ว" ทันทีตอนเช็ก
  const stamps = readStamps_();
  const summaries = buildEmployeeSummaries_(data, stamps);
  // จับคู่ด้วยเบอร์ ไม่ใช่ชื่อ — เบอร์เดียวกันที่ลงทะเบียนหลายแถวด้วยชื่อต่างกัน summaries เก็บชื่อจากแถวล่าสุด แต่ member ด้านบนเป็นแถวแรก ชื่อไม่ตรงกันทำให้ me เป็น undefined
  const me = summaries.filter(function (s) { return s.phone === phone; })[0];
  if (!me) return { error: 'NOT_FOUND' };
  const brackets = buildBracketSummaries_(data, summaries, stamps);
  const myBracket = brackets.filter(function (b) { return b.size === me.adSize; })[0];

  return {
    name: me.name,
    adName: me.adName,
    adSize: me.adSize,
    referrals: me.referrals.map(function (r) { return { customerName: r.customerName, submittedAt: r.submittedAt }; }),
    referralCount: me.referralCount,
    cardsEarned: me.cardsEarned,
    bahtEarned: me.bahtEarned,
    atCap: me.atCap,
    campaign: CAMPAIGN,
    redeemOpensAt: REDEEM_OPENS_AT, // ปุ่มแลกใน check.html โชว์เสมอถ้า cardsEarned > 0 แต่กดไม่ได้ก่อนวันนี้
    bracket: myBracket, // { size, stores, cardQuota, cardsUsed, cardsRemaining, storesActive } — ไม่มีชื่อ/เบอร์โทรคนอื่นปน
  };
}

// ================================================================
// Sync "ผลการสมัคร" จาก Excel Online ผ่าน Microsoft Graph API
// (แทน Power Automate ที่ติด DLP policy บล็อก Google Sheets connector
// ในองค์กร — ดูขั้นตอน setup เต็มใน GraphAPI-Sync-Setup.md)
// อ่านอย่างเดียว ไม่มีการเขียน/แก้ไฟล์ Excel ต้นทางเลย
// ================================================================

const EXCEL_SITE_NAME = 'SKC Tableau Sharing';
const EXCEL_FILE_PATH = '/Service/KUBOTA Care/Master Care.xlsx';
const EXCEL_TABLE_NAME = 'Register';

function getGraphToken_() {
  const props = PropertiesService.getScriptProperties();
  const tenantId = props.getProperty('MS_TENANT_ID');
  const clientId = props.getProperty('MS_CLIENT_ID');
  const clientSecret = props.getProperty('MS_CLIENT_SECRET');
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('ยังไม่ได้ตั้งค่า MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET ใน Script Properties — ดู GraphAPI-Sync-Setup.md');
  }
  const res = UrlFetchApp.fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'post',
    payload: {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    },
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText());
  if (!data.access_token) throw new Error('ขอ Graph API token ไม่สำเร็จ: ' + res.getContentText());
  return data.access_token;
}

function getExcelSiteId_(token) {
  const url = 'https://graph.microsoft.com/v1.0/sites?search=' + encodeURIComponent(EXCEL_SITE_NAME);
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText());
  if (!data.value || !data.value.length) throw new Error('ไม่พบ SharePoint site: ' + EXCEL_SITE_NAME);
  return data.value[0].id;
}

// อ่านตาราง Excel ต้นทางเป็น array of object ตามชื่อคอลัมน์ (ไม่ใช่ตำแหน่ง — ปลอดภัยกว่าถ้ามีคนสลับคอลัมน์)
function fetchExcelTableRows_() {
  const token = getGraphToken_();
  const siteId = getExcelSiteId_(token);
  const base = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:${EXCEL_FILE_PATH}:/workbook/tables/${EXCEL_TABLE_NAME}`;

  const colsRes = UrlFetchApp.fetch(base + '/columns', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  const columns = JSON.parse(colsRes.getContentText()).value.map(function (c) { return c.name; });

  const rowsRes = UrlFetchApp.fetch(base + '/rows', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  const rows = JSON.parse(rowsRes.getContentText()).value || [];

  return rows.map(function (r) {
    const obj = {};
    columns.forEach(function (col, i) { obj[col] = r.values[0][i]; });
    return obj;
  });
}

// เบอร์โทรซ้ำนับเป็นคนเดียว (ถ้าลงทะเบียนหลายแถว ใช้ร้านจากแถวล่าสุด ตรงกับที่ buildEmployeeSummaries_ จับคู่ด้วยเบอร์) — แถวที่ไม่มีเบอร์แยกไม่ได้ จึงนับเป็นรายแถว
function uniqueMembersByPhone_(members) {
  const byPhone = {};
  const noPhone = [];
  members.forEach(function (m) {
    if (m.phone) byPhone[m.phone] = m; else noPhone.push(m);
  });
  return Object.keys(byPhone).map(function (k) { return byPhone[k]; }).concat(noPhone);
}

// ---------- mode=admin: ภาพรวมล้วนๆ ไม่มีเบอร์โทร ----------
// role.regions = null → เห็นทุกเขต; เป็น array ชื่อเขต → กรองฝั่ง server ให้เหลือเฉพาะ AD/พนักงานในเขตนั้น (ข้อมูลเขตอื่นไม่ถูกส่งออกไปเลย)
function buildAdminSummary(role) {
  const regions = role && role.regions;
  const data = loadAll_();
  autoStampNewCards_(data); // ใครครบ 4 คนใหม่ก็บันทึกลง "บัตรที่แจกแล้ว" ทันทีทุกครั้งที่แอดมินเปิดหน้านี้ (กระทบทุกเขตเสมอ ไม่ขึ้นกับ user ที่เปิด)
  let summaries = buildEmployeeSummaries_(data, []);
  const allStores = readAdStores_();
  let adStores = allStores;
  let brackets = data.brackets;
  const uniqueMembers = uniqueMembersByPhone_(data.members);
  let totalMembers = uniqueMembers.length;

  if (regions) {
    adStores = allStores.filter(function (s) { return regions.indexOf(s.region) >= 0; });
    const inRegion = {};
    adStores.forEach(function (s) { inRegion[s.adName] = true; });
    // จัดพนักงานเข้าเขตตามร้านที่ลงทะเบียนไว้ (ถ้าไม่มีใช้ AD จาก referral)
    summaries = summaries.filter(function (s) { return inRegion[s.memberStore || s.adName]; });
    totalMembers = uniqueMembers.filter(function (m) { return inRegion[m.memberStore]; }).length;
    // โควตา/งบ/เป้าหมายของ Bracket แบ่งตามสัดส่วนจำนวนร้านของเขต ต่อร้านทั้งหมดใน Bracket นั้น (เกณฑ์เดิมแบ่งเท่าๆ กันทุกร้านใน Bracket)
    brackets = data.brackets.map(function (b) {
      const total = allStores.filter(function (s) { return s.adSize === b.size; }).length || b.stores;
      const n = adStores.filter(function (s) { return s.adSize === b.size; }).length;
      const ratio = total > 0 ? Math.min(1, n / total) : 0;
      return {
        size: b.size,
        stores: n,
        cardQuota: Math.round(b.cardQuota * ratio),
        userTarget: Math.round(b.userTarget * ratio),
        budget: Math.round(b.budget * ratio),
      };
    }).filter(function (b) { return b.stores > 0; });
  }

  // จำนวนพนักงานที่ลงทะเบียนไว้ต่อร้าน (คอลัมน์ "ร้านผู้แทนจำหน่าย" ในชีตพนักงาน) — ส่งเฉพาะตัวเลขรวม ไม่มีชื่อ/เบอร์
  const registeredByStore = {};
  uniqueMembers.forEach(function (m) {
    if (m.memberStore) registeredByStore[m.memberStore] = (registeredByStore[m.memberStore] || 0) + 1;
  });
  adStores = adStores.map(function (s) {
    return Object.assign({}, s, { registeredCount: registeredByStore[s.adName] || 0 });
  });

  const employees = summaries.map(function (s) {
    return {
      name: s.name,
      phone: s.phone, // เบอร์โทรพนักงาน — แสดงเฉพาะหน้า admin (ต้องผ่านรหัสผ่านแล้วเท่านั้น)
      memberStore: s.memberStore, // ร้านที่ลงทะเบียนไว้ — หน้า admin ใช้กรองตามเขต/ศูนย์/ร้านให้พนักงานที่ยังไม่มี referral ด้วย
      adName: s.adName,
      adSize: s.adSize,
      joinedAt: s.joinedAt, // วันที่ลงทะเบียนเข้าร่วม (จากชีต "พนักงานที่เข้าร่วม") — ใช้ทำกราฟแท่งรายวัน
      referrals: s.referrals.map(function (r) { return r.submittedAt; }),
      suspectCount: s.suspectCount,
    };
  });

  return {
    campaign: CAMPAIGN,
    scope: regions ? { type: 'region', regions: regions, label: role.label } : { type: 'all' }, // หน้าเว็บใช้ซ่อนการ์ดแสตมป์ + แสดงชื่อเขต
    totalMembers: totalMembers,
    brackets: brackets, // { size, stores, cardQuota, userTarget, budget } — ค่าคงที่ตามเกณฑ์ ไม่ผูกกับตัวกรอง (user ระดับเขต = แบ่งสัดส่วนตามจำนวนร้านของเขต)
    adStores: adStores, // { adName, adSize, staffCount, storeCode, region, center } จากแผ่นงาน "ขนาด AD"
    employees: employees,
    generatedAt: new Date().toISOString(),
  };
}
