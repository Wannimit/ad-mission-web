// AD Mission — ตั้งค่า endpoint ของ backend (Google Apps Script Web App)
// ดู Web/apps-script/Code.gs และ Web/apps-script/README.md สำหรับวิธี deploy/แก้ไข backend
const API_BASE_URL = "https://script.google.com/macros/s/AKfycbyTjP5-A90hNPASwqCIpla-P43x43AvVMQoFbhBhmE3f6ANPosQV4N0HEvjgmaqNPxC/exec";

// label ช่วงจำนวนช่างต่อ bracket (ค่าคงที่ ไม่ใช่ข้อมูลลับ — ไม่ต้องดึงจาก backend)
const BRACKET_RANGE_LABELS = {
  "เล็ก": "2–16 คน",
  "กลาง": "17–26 คน",
  "ใหญ่": "27–45 คน",
  "ใหญ่พิเศษ": "46–78 คน",
};

async function fetchApi(params) {
  const url = `${API_BASE_URL}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json && json.error) throw new Error(json.error);
  return json;
}
