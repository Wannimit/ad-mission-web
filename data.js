/*
  AD Mission — snapshot data
  ที่มา: Google Sheet "Kubota Care tracking"
  https://docs.google.com/spreadsheets/d/1v6xm9z4gwiqEFZBAPrP1ugQ3m2A_w94RVkIgyk5nV2o
  ดึงข้อมูล (snapshot) เมื่อ 2026-09-21 — ยังไม่ได้ต่อ live fetch
  แผ่นงาน: "ผลการสมัคร", "เกณฑ์", "พนักงานที่เข้าร่วม"

  ข้อควรระวังด้านความปลอดภัย (สำคัญสำหรับ Dev ทีมถัดไป):
  ไฟล์นี้ถูก include เข้าเว็บฝั่ง client ทั้งสองหน้า (admin.html, check.html)
  ตอนนี้ยังฝัง cid + ผลงานของพนักงาน "ทุกคน" ไว้ใน JS ฝั่ง client แบบ plain text
  ซึ่งขัดกับหลักการใน Plan.md ที่ว่า "พนักงาน/ร้านไม่เข้าถึงไฟล์ดิบโดยตรง"
  เพราะพนักงานคนหนึ่งเปิด dev tools ดูได้ว่าคนอื่นมี cid/ผลงานอะไรบ้าง
  พอมี backend/API จริงแล้ว ต้องเปลี่ยนเป็นให้ server เป็นคนกรองข้อมูลตาม cid
  ที่ล็อกอินเข้ามาเท่านั้น ห้ามส่ง dataset เต็มมาที่ client อีก
*/

const CAMPAIGN = {
  pointsPerCard: 4,      // ทุก 4 คนที่แนะนำสำเร็จ = 1 บัตร
  cardValueBaht: 100,    // บัตร Lotus's 1 ใบ = 100 บาท
  capBaht: 1000,         // เพดานสูงสุด/คน = 1,000 บาท
  snapshotDate: "2026-09-21",
};
CAMPAIGN.maxCardsPerPerson = CAMPAIGN.capBaht / CAMPAIGN.cardValueBaht; // 10
CAMPAIGN.maxReferralsPerPerson = CAMPAIGN.maxCardsPerPerson * CAMPAIGN.pointsPerCard; // 40

// เกณฑ์ต่อ bracket (จากแผ่นงาน "เกณฑ์")
const BRACKETS = [
  { size: "เล็ก",       range: "2–16 คน",  stores: 28, cardQuota: 140, userTarget: 560,  budget: 14000 },
  { size: "กลาง",       range: "17–26 คน", stores: 29, cardQuota: 310, userTarget: 1240, budget: 31000 },
  { size: "ใหญ่",       range: "27–45 คน", stores: 21, cardQuota: 350, userTarget: 1400, budget: 35000 },
  { size: "ใหญ่พิเศษ", range: "46–78 คน", stores: 8,  cardQuota: 200, userTarget: 800,  budget: 20000 },
];

// พนักงานที่เข้าร่วม (จากแผ่นงาน "พนักงานที่เข้าร่วม")
const EMPLOYEES = [
  { no: 1, name: "ช่าง A", cid: "1650101117135" },
  { no: 2, name: "ช่าง B", cid: "1419900412103" },
  { no: 3, name: "ช่าง C", cid: "1410301127004" },
  { no: 4, name: "ช่าง D", cid: "3411200150709" },
  { no: 5, name: "ช่าง E", cid: "3341600059947" },
  { no: 6, name: "ช่าง F", cid: "4850300002497" },
  { no: 7, name: "ช่าง G", cid: "1449900439681" },
];

// ผลการสมัคร (ลูกค้าที่แนะนำสำเร็จ, จากแผ่นงาน "ผลการสมัคร")
const REGISTRATIONS = [
  { kubotaId: "9000179737", regNo: 5442, customerName: "คุณสมเกียรติ ร่องจิก",       submittedAt: "2026-09-01T14:09:24", employee: "ช่าง A", adSize: "เล็ก",       adName: "คูโบต้าปทุมธานี" },
  { kubotaId: "9000829941", regNo: 5443, customerName: "คุณรัฐพร อยู่สกุนีย์",        submittedAt: "2026-09-01T14:11:18", employee: "ช่าง B", adSize: "เล็ก",       adName: "อยุธยา ฮั้วเฮงหลี" },
  { kubotaId: "9000307108", regNo: 5444, customerName: "คุณสมพล สายอุดมสิน",         submittedAt: "2026-09-01T14:53:52", employee: "ช่าง C", adSize: "กลาง",       adName: "มิตรแท้นครศรี" },
  { kubotaId: "9000889188", regNo: 5445, customerName: "คุณเฉลิมพล เยาวชัย",         submittedAt: "2026-09-01T14:53:53", employee: "ช่าง D", adSize: "กลาง",       adName: "ชัยศิริ" },
  { kubotaId: "9000298772", regNo: 5446, customerName: "คุณสุดาพร คำเหมือง",         submittedAt: "2026-09-01T15:58:43", employee: "ช่าง E", adSize: "ใหญ่",       adName: "เจริญชัย" },
  { kubotaId: "9000001890", regNo: 5447, customerName: "คุณดำรงค์ศักดิ์ วันดี",      submittedAt: "2026-09-01T16:13:31", employee: "ช่าง F", adSize: "ใหญ่",       adName: "9 เอที พี" },
  { kubotaId: "9100029275", regNo: 5448, customerName: "คุณพิเชษฐ์ เดชเกิด",         submittedAt: "2026-09-01T16:41:28", employee: "ช่าง G", adSize: "ใหญ่พิเศษ", adName: "หาดใหญ่จักรกล" },
  { kubotaId: "9100018063", regNo: 5527, customerName: "คุณประสิทธิ์ คัฒมารศรี",     submittedAt: "2026-09-21T09:39:21", employee: "ช่าง A", adSize: "เล็ก",       adName: "คูโบต้าปทุมธานี" },
];

// ---------- ฟังก์ชันคำนวณกลาง ใช้ร่วมกันทั้ง admin.html และ check.html ----------

function cardsEarnedFor(referralCount) {
  return Math.min(Math.floor(referralCount / CAMPAIGN.pointsPerCard), CAMPAIGN.maxCardsPerPerson);
}

function bahtEarnedFor(referralCount) {
  return cardsEarnedFor(referralCount) * CAMPAIGN.cardValueBaht;
}

// สรุปผลงานรายพนักงาน: จำนวนลูกค้าที่แนะนำสำเร็จ, บัตร/แต้มที่ได้, ร้าน/bracket ของพนักงาน
function buildEmployeeSummaries() {
  const byEmployee = new Map();
  for (const emp of EMPLOYEES) {
    byEmployee.set(emp.name, {
      ...emp,
      referrals: [],
      adName: null,
      adSize: null,
    });
  }
  for (const r of REGISTRATIONS) {
    const s = byEmployee.get(r.employee);
    if (!s) continue; // ข้อมูลไม่ตรงกับพนักงานที่ลงทะเบียนไว้ — ข้ามอย่างเงียบๆ ไม่ทำหน้าเว็บพัง
    s.referrals.push(r);
    if (!s.adName) { s.adName = r.adName; s.adSize = r.adSize; }
  }
  const summaries = [];
  for (const s of byEmployee.values()) {
    s.referrals.sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
    const count = s.referrals.length;
    summaries.push({
      ...s,
      referralCount: count,
      cardsEarned: cardsEarnedFor(count),
      bahtEarned: bahtEarnedFor(count),
      atCap: count >= CAMPAIGN.maxReferralsPerPerson,
    });
  }
  return summaries;
}

function buildBracketSummaries(employeeSummaries) {
  return BRACKETS.map((b) => {
    const empsInBracket = employeeSummaries.filter((e) => e.adSize === b.size);
    const cardsUsed = empsInBracket.reduce((sum, e) => sum + e.cardsEarned, 0);
    const storesActive = new Set(empsInBracket.filter(e => e.referralCount > 0).map(e => e.adName)).size;
    return { ...b, cardsUsed, cardsRemaining: b.cardQuota - cardsUsed, storesActive, employees: empsInBracket };
  });
}

function buildDailyTrend() {
  const counts = new Map();
  for (const r of REGISTRATIONS) {
    const day = r.submittedAt.slice(0, 10);
    counts.set(day, (counts.get(day) || 0) + 1);
  }
  const days = [...counts.keys()].sort();
  if (days.length === 0) return [];
  const start = new Date(days[0]);
  const end = new Date(days[days.length - 1]);
  const out = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const dow = d.getDay(); // 0 = อาทิตย์, 6 = เสาร์
    out.push({ date: key, count: counts.get(key) || 0, isWeekend: dow === 0 || dow === 6 });
  }
  return out;
}

function findEmployeeByCid(cid) {
  const cleaned = String(cid).replace(/\D/g, "");
  return EMPLOYEES.find((e) => e.cid === cleaned) || null;
}
