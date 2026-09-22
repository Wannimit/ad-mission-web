# วิธี Deploy backend (Google Apps Script)

ไฟล์ [Code.gs](Code.gs) คือ backend ที่อ่านข้อมูลสดจาก Google Sheet "Kubota Care tracking" แล้วกรองให้เหลือเฉพาะข้อมูลที่ควรส่งจริง (โหมด `personal` กรองตาม cid, โหมด `admin` ตัด cid ออกทั้งหมด) แทนการฝังข้อมูลทุกคนไว้ใน [Web/data.js](../data.js) แบบเดิม

## ขั้นตอน Deploy

1. เปิด Google Sheet "Kubota Care tracking" (https://docs.google.com/spreadsheets/d/1v6xm9z4gwiqEFZBAPrP1ugQ3m2A_w94RVkIgyk5nV2o)
2. เมนู **Extensions > Apps Script**
3. ลบโค้ดเริ่มต้นในไฟล์ `Code.gs` ที่เปิดมา แล้ววางเนื้อหาจาก [Code.gs](Code.gs) ในโปรเจกต์นี้ทับลงไปทั้งหมด
4. กด **Deploy > New deployment**
   - Select type: **Web app**
   - Execute as: **Me** (เจ้าของชีต)
   - Who has access: **Anyone with the link** (ต้องเปิดกว้างระดับนี้ เพราะพนักงานเข้าผ่านเว็บโดยไม่ล็อกอิน — ความปลอดภัยอยู่ที่ backend กรองข้อมูลตาม cid ให้แล้ว ไม่ใช่การจำกัดผู้เรียก API)
5. กด Deploy จะได้ **Web app URL** หน้าตาประมาณ `https://script.google.com/macros/s/XXXXXXXXXXXX/exec` — เก็บ URL นี้ไว้ ต้องใช้ต่อในขั้นเชื่อม check.html/admin.html
6. ทดสอบยิง URL ตรงๆ ในเบราว์เซอร์:
   - `<URL>?mode=admin` — ควรได้ JSON ภาพรวม ไม่มี cid ปน
   - `<URL>?mode=personal&cid=1650101117135` — ควรได้ JSON ของ "ช่าง A" คนเดียว (ใช้ cid ตัวอย่างจากชีตปัจจุบัน)

## จุดที่ต้องระวัง

- ถ้าแก้ชื่อแผ่นงาน (tab) หรือชื่อคอลัมน์ใน Sheet ในอนาคต ต้องแก้ค่าคงที่ `SHEET_REGISTRATIONS` / `SHEET_CRITERIA` / `SHEET_MEMBERS` และชื่อ key ที่ใช้ดึงค่าใน `loadAll_()` ให้ตรงด้วย ไม่งั้น backend จะ error
- ทุก request อ่านชีตสดใหม่ทุกครั้ง (ของจริง real-time ตามที่ขอ) ยังไม่มี cache — ถ้าจำนวนคนเรียกพร้อมกันเยอะมากในอนาคตอาจต้องเติม `CacheService` เพื่อลดโควตา Apps Script (แต่ ณ ขนาดแคมเปญนี้ ~2,060 คน ไม่น่าจะชนโควตา)
- Deploy ใหม่ทุกครั้งที่แก้โค้ด (Deploy > Manage deployments > แก้ deployment เดิม หรือสร้างใหม่) ไม่งั้น URL เดิมจะยังรันโค้ดเก่าอยู่

## สถานะปัจจุบัน (2569-09-22)

Web app URL ใช้งานได้แล้ว: `https://script.google.com/macros/s/AKfycbyTjP5-A90hNPASwqCIpla-P43x43AvVMQoFbhBhmE3f6ANPosQV4N0HEvjgmaqNPxC/exec` (ตั้งค่าไว้ใน [Web/config.js](../config.js) แล้ว) — [Web/check.html](../check.html) และ [Web/admin.html](../admin.html) เปลี่ยนไป `fetch()` จาก URL นี้แทนการอ่าน [Web/data.js](../data.js) เรียบร้อยแล้ว (data.js เหลือไว้แค่เป็นตัวอย่างโครงสร้างข้อมูล ไม่ได้ถูก include ในหน้าเว็บอีกต่อไป)

**ต้อง redeploy ทุกครั้งที่แก้ Code.gs** ไม่งั้น URL เดิมจะยังรันโค้ดเก่าอยู่ — วิธี redeploy แบบคง URL เดิม:
1. วางโค้ดใหม่ทับใน Apps Script editor
2. Deploy > Manage deployments > กดดินสอ (แก้ไข) ที่ deployment ที่ใช้อยู่
3. ที่ dropdown "Version" เลือก **New version**
4. กด **Deploy**

### แก้ไขล่าสุด: comment_care เปลี่ยนจากชื่อช่างเป็น cid

วันที่ 2569-09-22 พบว่าคอลัมน์ `comment_care` ในแผ่นงาน "ผลการสมัคร" เปลี่ยนจากชื่อช่าง (เช่น "ช่าง A") เป็น**เลขบัตรประชาชน (cid)** ของช่างผู้แนะนำ ทำให้ระบบจับคู่ข้อมูลไม่ได้ (leaderboard ว่าง, referralCount ขึ้น 0 หมดทุกคน) — user ยืนยันแล้วว่า cid คือรูปแบบข้อมูลจริงที่ถูกต้อง จึงแก้ `Code.gs` ให้จับคู่ `comment_care` กับคอลัมน์ `cid` ในแผ่นงาน "พนักงานที่เข้าร่วม" แทนคอลัมน์ `Name` เรียบร้อยแล้ว **โค้ดนี้ในเครื่องแก้แล้ว แต่ยังไม่ได้ redeploy ขึ้น production — ต้อง redeploy ตามขั้นตอนด้านบนก่อนถึงจะใช้งานได้ถูกต้อง**
