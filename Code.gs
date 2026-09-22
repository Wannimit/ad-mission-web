/**
 * AD Mission — Kubota Care tracking backend
 *
 * Apps Script ผูกกับ Google Sheet "Kubota Care tracking" โดยตรง (Extensions > Apps Script)
 * Deploy เป็น Web App แล้วให้ check.html / admin.html เรียกผ่าน fetch แทนการฝัง data.js
 *
 * เหตุผล: data.js เดิมฝังข้อมูล cid + ผลงานของพนักงาน "ทุกคน" ไว้ฝั่ง client
 * ใครเปิด dev tools ก็เห็นข้อมูลคนอื่นได้หมด — ไฟล์นี้แก้ปัญหานั้นโดยให้ server
 * เป็นคนกรองข้อมูลก่อนส่ง ไม่ส่ง dataset เต็มไปที่ client อีกต่อไป อ่านสดจากชีตทุกครั้ง (real-time)
 *
 * Endpoints (GET ทั้งหมด):
 *   ?mode=personal&cid=1234567890123   -> ข้อมูลเฉพาะของพนักงานคนนั้น (ใช้ใน check.html)
 *   ?mode=admin                        -> ภาพรวมทั้งแคมเปญ ไม่มี cid/ข้อมูลระบุตัวตนอื่น (ใช้ใน admin.html)
 *
 * ก่อนใช้งาน ตรวจชื่อแผ่นงาน 3 อันด้านล่างให้ตรงกับชีตจริง (ตอนนี้ตรงกับที่อ่านได้จากชีตจริงแล้ว
 * ณ วันที่เขียนโค้ดนี้ — 2569-09-22):
 *   "ผลการสมัคร"        columns: kubota_id, registration_no, name, submitted_at, comment_care,
 *                                 suggestion_care, submitted_at_care, AD_size, AD
 *                        (comment_care = เลขบัตรประชาชน (cid) ของช่างผู้แนะนำ — เปลี่ยนจากชื่อช่าง
 *                        เป็น cid เมื่อ 2569-09-22 ตามข้อมูลจริงที่ระบบหน้างาน stamp เข้ามา
 *                        จับคู่กับคอลัมน์ cid ในแผ่นงาน "พนักงานที่เข้าร่วม" ไม่ใช่คอลัมน์ Name แล้ว)
 *   "เกณฑ์"              columns: AD_size, จำนวนร้าน, บัตรโควตา, ผู้ใช้ใหม่เป้า, งบประมาณบาท
 *   "พนักงานที่เข้าร่วม"  columns: No., Name, cid
 */

const SHEET_REGISTRATIONS = 'ผลการสมัคร';
const SHEET_CRITERIA = 'เกณฑ์';
const SHEET_MEMBERS = 'พนักงานที่เข้าร่วม';

const CAMPAIGN = {
  pointsPerCard: 4,   // ทุก 4 คนที่แนะนำสำเร็จ = 1 บัตร
  cardValueBaht: 100, // บัตร Lotus's 1 ใบ = 100 บาท
  capBaht: 1000,      // เพดานสูงสุด/คน = 1,000 บาท
};
CAMPAIGN.maxCardsPerPerson = CAMPAIGN.capBaht / CAMPAIGN.cardValueBaht; // 10
CAMPAIGN.maxReferralsPerPerson = CAMPAIGN.maxCardsPerPerson * CAMPAIGN.pointsPerCard; // 40

function doGet(e) {
  try {
    const mode = (e.parameter.mode || '').trim();
    if (mode === 'admin') return jsonOut_(buildAdminSummary());
    if (mode === 'personal') {
      const cid = String(e.parameter.cid || '').replace(/\D/g, '');
      if (cid.length !== 13) return jsonOut_({ error: 'INVALID_CID' });
      return jsonOut_(buildPersonalSummary(cid));
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
        referrerCid: String(r['comment_care'] || '').replace(/\D/g, ''), // cid ของช่างผู้แนะนำ
        adSize: r['AD_size'],
        adName: r['AD'],
      };
    })
    .filter(function (r) { return r.referrerCid; }); // ตัดแถวที่ไม่มี cid ผู้แนะนำทิ้ง

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
      cid: String(m['cid'] || '').replace(/\D/g, ''),
    };
  });

  return { registrations: registrations, brackets: brackets, members: members };
}

function cardsEarnedFor_(count) {
  return Math.min(Math.floor(count / CAMPAIGN.pointsPerCard), CAMPAIGN.maxCardsPerPerson);
}
function bahtEarnedFor_(count) {
  return cardsEarnedFor_(count) * CAMPAIGN.cardValueBaht;
}

function buildEmployeeSummaries_(data) {
  const byCid = new Map();
  data.members.forEach(function (m) {
    byCid.set(m.cid, { name: m.name, cid: m.cid, referrals: [], adName: null, adSize: null });
  });
  data.registrations.forEach(function (r) {
    const s = byCid.get(r.referrerCid);
    if (!s) return; // cid ใน "ผลการสมัคร" ไม่ตรงกับ whitelist "พนักงานที่เข้าร่วม" — ข้ามเงียบๆ ไม่ทำ request พัง
    s.referrals.push(r);
    if (!s.adName) { s.adName = r.adName; s.adSize = r.adSize; }
  });
  const summaries = [];
  byCid.forEach(function (s) {
    s.referrals.sort(function (a, b) { return new Date(a.submittedAt) - new Date(b.submittedAt); });
    const count = s.referrals.length;
    summaries.push({
      name: s.name,
      cid: s.cid,
      adName: s.adName,
      adSize: s.adSize,
      referrals: s.referrals,
      referralCount: count,
      cardsEarned: cardsEarnedFor_(count),
      bahtEarned: bahtEarnedFor_(count),
      atCap: count >= CAMPAIGN.maxReferralsPerPerson,
    });
  });
  return summaries;
}

function buildBracketSummaries_(data, employeeSummaries) {
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

// ---------- mode=personal: กรองเหลือแค่ข้อมูลของ cid ที่ขอมาเท่านั้น ----------
function buildPersonalSummary(cid) {
  const data = loadAll_();
  const member = data.members.filter(function (m) { return m.cid === cid; })[0];
  if (!member) return { error: 'NOT_FOUND' };

  const summaries = buildEmployeeSummaries_(data);
  const me = summaries.filter(function (s) { return s.name === member.name; })[0];
  const brackets = buildBracketSummaries_(data, summaries);
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
    bracket: myBracket, // { size, stores, cardQuota, cardsUsed, cardsRemaining, storesActive } — ไม่มีชื่อ/cid คนอื่นปน
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

// ---------- mode=admin: ภาพรวมล้วนๆ ไม่มี cid ----------
function buildAdminSummary() {
  const data = loadAll_();
  const summaries = buildEmployeeSummaries_(data);
  const brackets = buildBracketSummaries_(data, summaries);

  const totalRegistrations = data.registrations.length;
  const totalCards = summaries.reduce(function (sum, s) { return sum + s.cardsEarned; }, 0);
  const totalBudgetUsed = totalCards * CAMPAIGN.cardValueBaht;
  const participatingEmployees = summaries.filter(function (s) { return s.referralCount > 0; }).length;

  const leaderboard = summaries
    .sort(function (a, b) { return b.referralCount - a.referralCount; })
    .map(function (s) {
      return { name: s.name, adName: s.adName, adSize: s.adSize, referralCount: s.referralCount, cardsEarned: s.cardsEarned, atCap: s.atCap };
      // หมายเหตุ: ไม่ใส่ cid ในผลลัพธ์นี้เด็ดขาด — ชื่อช่าง/ร้านไม่ใช่ข้อมูลลับ แต่ cid เป็น
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
