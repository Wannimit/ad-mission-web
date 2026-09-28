/**
 * AD Mission — Kubota Care tracking backend
 *
 * Apps Script ผูกกับ Google Sheet "Kubota Care tracking" โดยตรง (Extensions > Apps Script)
 * Deploy เป็น Web App แล้วให้ check.html / admin.html เรียกผ่าน fetch แทนการฝัง data.js
 *
 * เหตุผล: data.js เดิมฝังข้อมูลเบอร์โทร + ผลงานของพนักงาน "ทุกคน" ไว้ฝั่ง client
 * ใครเปิด dev tools ก็เห็นข้อมูลคนอื่นได้หมด — ไฟล์นี้แก้ปัญหานั้นโดยให้ server
 * เป็นคนกรองข้อมูลก่อนส่ง ไม่ส่ง dataset เต็มไปที่ client อีกต่อไป อ่านสดจากชีตทุกครั้ง (real-time)
 *
 * Endpoints (GET ทั้งหมด):
 *   ?mode=personal&phone=0812345678      -> ข้อมูลเฉพาะของพนักงานคนนั้น (ใช้ใน check.html)
 *   ?mode=admin&password=...             -> ภาพรวมทั้งแคมเปญ ไม่มีเบอร์โทร/ข้อมูลระบุตัวตนอื่น (ใช้ใน admin.html)
 *   ?mode=stamp&password=...             -> Admin กดปุ่ม "แสตมป์อัตโนมัติ" เพื่อล็อกจำนวนบัตรที่ได้สิทธิ์จริง
 *                                            เรียงตามเวลาที่ครบ 4 register จริง (submitted_at) ข้ามทุกคน/ทุกร้าน
 *                                            (กันโควตา bracket แจกเกิน) — idempotent เรียกซ้ำได้ไม่แสตมป์ซ้ำ
 *
 * ก่อนใช้งาน ตรวจชื่อแผ่นงาน 5 อันด้านล่างให้ตรงกับชีตจริง (ตอนนี้ตรงกับที่อ่านได้จากชีตจริงแล้ว
 * ณ วันที่เขียนโค้ดนี้ — 2569-09-22):
 *   "ผลการสมัคร"        columns: kubota_id, registration_no, name, submitted_at, comment_care,
 *                                 suggestion_care, submitted_at_care, AD_size, AD
 *                        (comment_care = เบอร์โทรศัพท์ของช่างผู้แนะนำ — เปลี่ยนจาก cid มาเป็นเบอร์โทร
 *                        ตามที่ตกลงกัน ณ วันที่แก้โค้ดนี้ จับคู่กับคอลัมน์ phone ในแผ่นงาน
 *                        "พนักงานที่เข้าร่วม" — ⚠️ ต้องให้ระบบต้นทางที่ feed ค่าเข้า comment_care
 *                        ส่งเบอร์โทรจริงมาด้วย ไม่งั้นจับคู่ไม่ได้เหมือนตอนที่เปลี่ยนจากชื่อช่างเป็น cid)
 *   "เกณฑ์"              columns: AD_size, จำนวนร้าน, บัตรโควตา, ผู้ใช้ใหม่เป้า, งบประมาณบาท
 *   "พนักงานที่เข้าร่วม"  columns: No., Name, phone
 *   "Admin"              columns: label, password
 *                        (รายชื่อรหัสผ่านที่ใช้เข้าหน้า admin.html ได้ — เพิ่ม/ลบแถวในนี้ได้เลย
 *                        ไม่ต้องแก้โค้ด ตรวจสอบผ่าน ?mode=admin&password=... เท่านั้น ไม่มี endpoint
 *                        ไหนคืนค่ารหัสผ่านกลับออกไปให้ client เห็น)
 *   "บัตรที่แจกแล้ว"     columns: phone, name, adSize, status, stampedAt
 *                        (สร้างโดยปุ่ม "แสตมป์อัตโนมัติ" ใน admin.html เท่านั้น — ห้ามแก้มือ
 *                        1 แถว = 1 บัตรที่ล็อกสิทธิ์แล้วจริง status: "granted" = ได้ในโควตา bracket,
 *                        "queued" = ครบ 4 register แล้วแต่โควตา bracket เต็มตอนแสตมป์ ยังนับว่าได้บัตร
 *                        ฝั่งพนักงาน รอ Admin ตัดสินใจเพิ่มโควตาทีหลัง — cardsEarned ที่ส่งออกทุก mode
 *                        นับจากจำนวนแถวในชีตนี้ ไม่ใช่คำนวณสดจาก referralCount อีกต่อไป)
 */

const SHEET_REGISTRATIONS = 'ผลการสมัคร';
const SHEET_CRITERIA = 'เกณฑ์';
const SHEET_MEMBERS = 'พนักงานที่เข้าร่วม';
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
      return jsonOut_(stampCards_());
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
    .filter(function (r) { return r.referrerPhone.length >= 9 && r.referrerPhone.length <= 10; }); // ต้องเป็นเบอร์โทร 9-10 หลักเท่านั้น — ตัดทิ้งทั้งแถวว่างและแถวที่ comment_care ผิดรูปแบบ (เช่น mapping พลาดจาก pipeline ต้นทาง ได้ค่าที่ไม่ใช่เบอร์โทรมาแทน)

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
    };
  });

  return { registrations: registrations, brackets: brackets, members: members };
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

// ---------- อ่านชีต "บัตรที่แจกแล้ว" นับจำนวนแถว (granted+queued) ต่อเบอร์โทร ----------
function readStamps_() {
  return readSheetAsObjects_(SHEET_STAMPS).map(function (r) {
    return {
      phone: String(r['phone'] || '').replace(/\D/g, ''),
      name: r['name'],
      adSize: r['adSize'],
      status: String(r['status'] || ''),
      stampedAt: formatDate_(r['stampedAt']),
    };
  });
}

function buildEmployeeSummaries_(data, stamps) {
  const byPhone = new Map();
  data.members.forEach(function (m) {
    byPhone.set(m.phone, { name: m.name, phone: m.phone, referrals: [], adName: null, adSize: null });
  });
  data.registrations.forEach(function (r) {
    const s = byPhone.get(r.referrerPhone);
    if (!s) return; // เบอร์โทรใน "ผลการสมัคร" ไม่ตรงกับ whitelist "พนักงานที่เข้าร่วม" — ข้ามเงียบๆ ไม่ทำ request พัง
    s.referrals.push(r);
    if (!s.adName) { s.adName = r.adName; s.adSize = r.adSize; }
  });
  const stampCountByPhone = {};
  stamps.forEach(function (st) { stampCountByPhone[st.phone] = (stampCountByPhone[st.phone] || 0) + 1; });

  const summaries = [];
  byPhone.forEach(function (s) {
    s.referrals.sort(function (a, b) { return new Date(a.submittedAt) - new Date(b.submittedAt); });
    const count = s.referrals.length;
    const cardsEarned = stampCountByPhone[s.phone] || 0; // นับจากแถวที่แสตมป์จริงแล้วเท่านั้น (granted+queued รวมกัน)
    summaries.push({
      name: s.name,
      phone: s.phone,
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

// ---------- แสตมป์บัตร: ล็อกสิทธิ์จริงตามลำดับเวลาที่ครบจริง กันโควตา bracket แจกเกิน (idempotent) ----------
function stampCards_() {
  const data = loadAll_();
  const summaries = buildEmployeeSummaries_(data, []); // ใช้ referralCount ล้วนๆ เพื่อคำนวณ eligible ไม่พึ่งค่าที่แสตมป์ไปแล้ว
  const quotaBySize = {};
  data.brackets.forEach(function (b) { quotaBySize[b.size] = b.cardQuota; });

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_STAMPS);
  if (!sheet) throw new Error('ไม่พบแผ่นงาน: ' + SHEET_STAMPS);

  const existing = readStamps_();
  const stampedCountByPhone = {};
  const grantedCountBySize = {};
  existing.forEach(function (st) {
    stampedCountByPhone[st.phone] = (stampedCountByPhone[st.phone] || 0) + 1;
    if (st.status === 'granted') grantedCountBySize[st.adSize] = (grantedCountBySize[st.adSize] || 0) + 1;
  });

  // รวม "ใบที่รอแสตมป์" ของทุกคนเป็น pool เดียว ผูกกับเวลาที่ครบจริง (submitted_at ของ referral
  // ตัวที่ 4, 8, 12... ของคนนั้น — s.referrals ถูก sort ตาม submittedAt มาแล้วจาก buildEmployeeSummaries_)
  // แล้วเรียง pool ทั้งหมดตามเวลาที่ครบจริงก่อนแสตมป์ ไม่ใช่ตามลำดับแถวในชีตสมาชิก — ให้คนที่ทำครบ
  // 4 คนก่อนตามเวลานาฬิกาจริงได้สิทธิ์ granted ก่อนเวลาที่โควตาใกล้เต็ม
  const pending = [];
  summaries.forEach(function (s) {
    const eligible = eligibleCardsFor_(s.referralCount);
    const already = stampedCountByPhone[s.phone] || 0;
    for (let k = already; k < eligible; k++) {
      const completingReferral = s.referrals[(k + 1) * CAMPAIGN.pointsPerCard - 1];
      pending.push({
        phone: s.phone,
        name: s.name,
        adSize: s.adSize,
        completedAt: completingReferral ? new Date(completingReferral.submittedAt) : new Date(8640000000000000),
      });
    }
  });
  pending.sort(function (a, b) { return a.completedAt - b.completedAt; });

  const rowsToAppend = [];
  let grantedAdded = 0, queuedAdded = 0;

  pending.forEach(function (p) {
    const quota = quotaBySize[p.adSize] || 0;
    const usedGranted = grantedCountBySize[p.adSize] || 0;
    let status;
    if (usedGranted < quota) {
      status = 'granted';
      grantedCountBySize[p.adSize] = usedGranted + 1;
      grantedAdded++;
    } else {
      status = 'queued';
      queuedAdded++;
    }
    rowsToAppend.push([p.phone, p.name, p.adSize, status, new Date()]);
  });

  if (rowsToAppend.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, 5).setValues(rowsToAppend);
  }

  return { added: rowsToAppend.length, granted: grantedAdded, queued: queuedAdded };
}

function buildBracketSummaries_(data, employeeSummaries, stamps) {
  return data.brackets.map(function (b) {
    const empsInBracket = employeeSummaries.filter(function (e) { return e.adSize === b.size; });
    const cardsUsed = empsInBracket.reduce(function (sum, e) { return sum + e.cardsEarned; }, 0);
    const storesActive = new Set(
      empsInBracket.filter(function (e) { return e.referralCount > 0; }).map(function (e) { return e.adName; })
    ).size;
    // นับตรงจากชีต "บัตรที่แจกแล้ว" เอง ไม่พึ่งผลจากการกดปุ่มแสตมป์ครั้งล่าสุด — Admin ใช้ดูว่ามี queued ค้างอยู่กี่ใบ
    // เพื่อตัดสินใจเพิ่มโควตา ไม่ต้องกดปุ่มแสตมป์ก็เห็นตัวเลขนี้ได้ (queued ที่เกิดจากการแสตมป์ครั้งก่อนๆ ทั้งหมด)
    const queuedCount = (stamps || []).filter(function (st) { return st.adSize === b.size && st.status === 'queued'; }).length;
    return {
      size: b.size,
      stores: b.stores,
      cardQuota: b.cardQuota,
      userTarget: b.userTarget,
      budget: b.budget,
      cardsUsed: cardsUsed,
      cardsRemaining: b.cardQuota - cardsUsed,
      storesActive: storesActive,
      queuedCount: queuedCount,
    };
  });
}

// ---------- mode=personal: กรองเหลือแค่ข้อมูลของเบอร์โทรที่ขอมาเท่านั้น ----------
function buildPersonalSummary(phone) {
  const data = loadAll_();
  const member = data.members.filter(function (m) { return m.phone === phone; })[0];
  if (!member) return { error: 'NOT_FOUND' };

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

// ---------- นับยอด register รายวัน (นับรวมเท่านั้น ไม่มีชื่อลูกค้า/ช่างปน ปลอดภัยที่จะส่งให้ admin) ----------
function buildDailyTrend_(registrations) {
  const counts = {};
  registrations.forEach(function (r) {
    const day = String(r.submittedAt).slice(0, 10);
    counts[day] = (counts[day] || 0) + 1;
  });
  const days = Object.keys(counts).sort();
  if (days.length === 0) return [];
  const start = new Date(days[0]);
  const end = new Date(days[days.length - 1]);
  const out = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd');
    const dow = d.getDay(); // 0 = อาทิตย์, 6 = เสาร์
    out.push({ date: key, count: counts[key] || 0, isWeekend: dow === 0 || dow === 6 });
  }
  return out;
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
  const stamps = readStamps_();
  const summaries = buildEmployeeSummaries_(data, stamps);
  const brackets = buildBracketSummaries_(data, summaries, stamps);

  const totalRegistrations = data.registrations.length;
  const totalCards = summaries.reduce(function (sum, s) { return sum + s.cardsEarned; }, 0);
  const totalBudgetUsed = totalCards * CAMPAIGN.cardValueBaht;
  const participatingEmployees = summaries.filter(function (s) { return s.referralCount > 0; }).length;

  const leaderboard = summaries
    .sort(function (a, b) { return b.referralCount - a.referralCount; })
    .map(function (s) {
      return { name: s.name, adName: s.adName, adSize: s.adSize, referralCount: s.referralCount, cardsEarned: s.cardsEarned, atCap: s.atCap };
      // หมายเหตุ: ไม่ใส่เบอร์โทรในผลลัพธ์นี้เด็ดขาด — ชื่อช่าง/ร้านไม่ใช่ข้อมูลลับ แต่เบอร์โทรเป็น
    });

  return {
    campaign: CAMPAIGN,
    totalRegistrations: totalRegistrations,
    totalCards: totalCards,
    totalBudgetUsed: totalBudgetUsed,
    totalMembers: data.members.length,
    participatingEmployees: participatingEmployees,
    brackets: brackets,
    leaderboard: leaderboard,
    dailyTrend: buildDailyTrend_(data.registrations),
    generatedAt: new Date().toISOString(),
  };
}
