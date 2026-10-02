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
 *   ?mode=admin&password=...             -> ภาพรวมทั้งแคมเปญ ไม่มี phone/ข้อมูลระบุตัวตนอื่น (ใช้ใน admin.html)
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
      const password = String(e.parameter.password || '');
      if (!isValidAdminPassword_(password)) return jsonOut_({ error: 'UNAUTHORIZED' });
      return jsonOut_(buildAdminSummary());
    }
    if (mode === 'personal') {
      const phone = String(e.parameter.phone || '').replace(/\D/g, '');
      if (phone.length < 9 || phone.length > 10) return jsonOut_({ error: 'INVALID_PHONE' });
      return jsonOut_(buildPersonalSummary(phone));
    }
    if (mode === 'stamp') {
      const password = String(e.parameter.password || '');
      if (!isValidAdminPassword_(password)) return jsonOut_({ error: 'UNAUTHORIZED' });
      return jsonOut_(autoStampNewCards_(loadAll_()));
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

function loadAll_() {
  const registrations = readSheetAsObjects_(SHEET_REGISTRATIONS)
    .map(function (r) {
      return {
        customerName: r['name'],
        submittedAt: formatDate_(r['submitted_at']),
        referrerPhone: String(r['comment_care'] || '').replace(/\D/g, ''), // เบอร์โทรของช่างผู้แนะนำ
        adSize: r['AD_Size'],
        adName: r['AD'],
      };
    })
    .filter(function (r) { return r.referrerPhone.length >= 9 && r.referrerPhone.length <= 10; }); // ต้องเป็นเบอร์โทร 9-10 หลักเท่านั้น

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
    };
  });

  return { registrations: registrations, brackets: brackets, members: members };
}

// ---------- อ่านแผ่นงาน "ขนาด AD": ชื่อร้าน (หัวคอลัมน์ "AD" ถ้าไม่มีใช้คอลัมน์ A), ขนาด, จำนวนพนักงานในร้าน (คอลัมน์ E) ----------
// อ่านคอลัมน์ E ตามตำแหน่ง (index 4) ตามที่ user ระบุ ไม่ผูกกับชื่อหัวตาราง — ถ้าไม่มีแผ่นงานนี้ไม่ทำให้ admin พัง
function readAdStores_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_AD_SIZE);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(function (h) { return String(h).trim(); });
  const nameIdx = headers.indexOf('AD') >= 0 ? headers.indexOf('AD') : 0;
  const sizeIdx = headers.indexOf('AD_Size') >= 0 ? headers.indexOf('AD_Size') : headers.indexOf('AD_size');
  return values.slice(1)
    .filter(function (row) { return String(row[nameIdx] || '').trim() !== ''; })
    .map(function (row) {
      return {
        adName: String(row[nameIdx]).trim(),
        adSize: sizeIdx >= 0 ? row[sizeIdx] : null,
        staffCount: Number(row[4]) || 0,
      };
    });
}

// ---------- ตรวจรหัสผ่านหน้า admin กับแผ่นงาน "Admin" ----------
function isValidAdminPassword_(password) {
  if (!password) return false;
  const rows = readSheetAsObjects_(SHEET_ADMIN);
  return rows.some(function (r) { return String(r['password'] || '') === password; });
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
    byPhone.set(m.phone, { name: m.name, phone: m.phone, joinedAt: m.joinedAt, referrals: [], adName: null, adSize: null });
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
      adName: s.adName,
      adSize: s.adSize,
      referrals: s.referrals,
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

  return { added: phonesToAppend.length };
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
  const me = summaries.filter(function (s) { return s.name === member.name; })[0];
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

// ---------- Sync จริง: เพิ่มเฉพาะแถวใหม่เข้าชีต "ผลการสมัคร" (กันซ้ำด้วย registration_no) ----------
function syncRegistrationsFromExcelOnline() {
  const sourceRows = fetchExcelTableRows_();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_REGISTRATIONS);
  if (!sheet) throw new Error('ไม่พบแผ่นงาน: ' + SHEET_REGISTRATIONS);

  const existing = readSheetAsObjects_(SHEET_REGISTRATIONS);
  const existingKeys = new Set(existing.map(function (r) { return String(r['registration_no'] || ''); }));

  // เขียนแค่ A-G เท่านั้น — คอลัมน์ H (AD) และ I (AD_Size) เป็นสูตร ARRAYFORMULA ที่ lookup
  // จาก comment_care (E) เองอัตโนมัติอยู่แล้ว (ดูคอลัมน์ H/I ในชีต) ถ้าเขียนทับตรงนี้ด้วย
  // จะไปโดนช่วง spill ของสูตร ทำให้สูตรพัง (#REF!) และค่าที่เขียนก็สลับคอลัมน์กันด้วย (บั๊กเดิม)
  const headers = ['kubota_id', 'registration_no', 'name', 'submitted_at', 'comment_care',
    'suggestion_care', 'submitted_at_care'];

  const newRows = sourceRows
    .filter(function (r) { return !existingKeys.has(String(r['registration_no'] || '')); })
    .map(function (r) { return headers.map(function (h) { return r[h] !== undefined ? r[h] : ''; }); });

  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, headers.length).setValues(newRows);
  }
  return { added: newRows.length };
}

// ---------- mode=admin: ภาพรวมล้วนๆ ไม่มีเบอร์โทร ----------
function buildAdminSummary() {
  const data = loadAll_();
  autoStampNewCards_(data); // ใครครบ 4 คนใหม่ก็บันทึกลง "บัตรที่แจกแล้ว" ทันทีทุกครั้งที่แอดมินเปิดหน้านี้
  const summaries = buildEmployeeSummaries_(data, []);

  const employees = summaries.map(function (s) {
    return {
      name: s.name,
      adName: s.adName,
      adSize: s.adSize,
      joinedAt: s.joinedAt, // วันที่ลงทะเบียนเข้าร่วม (จากชีต "พนักงานที่เข้าร่วม") — ใช้ทำกราฟแท่งรายวัน
      referrals: s.referrals.map(function (r) { return r.submittedAt; }),
    };
  });

  return {
    campaign: CAMPAIGN,
    totalMembers: data.members.length,
    brackets: data.brackets, // { size, stores, cardQuota, userTarget, budget } — ค่าคงที่ตามเกณฑ์ ไม่ผูกกับตัวกรอง
    adStores: readAdStores_(), // { adName, adSize, staffCount } จากแผ่นงาน "ขนาด AD" (staffCount = คอลัมน์ E)
    employees: employees,
    generatedAt: new Date().toISOString(),
  };
}
