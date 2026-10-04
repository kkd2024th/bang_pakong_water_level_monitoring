/**
 * ====================================================================
 * ระบบแจ้งเตือนระดับน้ำสถานีบางปะกง — เวอร์ชันจบที่ GitHub 100%
 * - อ่านรายชื่ออีเมล: ไฟล์ emails.txt ใน repo
 * - จำสถานะ: ไฟล์ state.json ใน repo (commit กลับทุกครั้งที่รัน)
 * - ส่งอีเมล: Gmail SMTP ผ่าน nodemailer
 * ====================================================================
 */
import nodemailer from 'nodemailer';
import { readFile, writeFile } from 'fs/promises';

const CONFIG = {
  API_URL: 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load',
  STATION_OLD_CODE: 'BPK001',
  STATION_ID: 154,

  ALERT_THRESHOLD_M: 0.50,
  RESET_BUFFER_M: 0.20,

  EMAILS_FILE: 'emails.txt',
  STATE_FILE: 'state.json',
  EMAIL_SUBJECT_PREFIX: '🚨 แจ้งเตือนระดับน้ำบางปะกง'
};

// ------------------------- ดึงข้อมูลจาก ThaiWater API -------------------------------
async function fetchStationData() {
  const res = await fetch(CONFIG.API_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (GitHub Actions water-alert bot)',
      'Referer': 'https://www.thaiwater.net/'
    }
  });

  if (!res.ok) throw new Error(`API ตอบกลับผิดพลาด: ${res.status}`);

  const data = await res.json();

  // โครงสร้างจริง: { waterlevel_data: { result: "OK", data: [ ...สถานีทั้งหมด... ] }, ... }
  const list = data.waterlevel_data?.data || [];

  let found = list.find(item => item.station?.tele_station_oldcode === CONFIG.STATION_OLD_CODE);
  if (!found) found = list.find(item => item.station?.id === CONFIG.STATION_ID);

  return found || null;
}

// ------------------------- อ่านรายชื่ออีเมลจากไฟล์ emails.txt -------------------------------
async function getEmailList() {
  let raw;
  try {
    raw = await readFile(CONFIG.EMAILS_FILE, 'utf-8');
  } catch {
    console.log(`ไม่พบไฟล์ ${CONFIG.EMAILS_FILE}`);
    return [];
  }

  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes('@') && !line.startsWith('#')); // # นำหน้า = comment, ข้ามได้
}

// ------------------------- อ่าน/เขียนสถานะ -------------------------------
async function getState() {
  try {
    const raw = await readFile(CONFIG.STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { alertSent: false };
  }
}

async function setState(state) {
  await writeFile(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
}

// ------------------------- ส่งอีเมลแจ้งเตือน -------------------------------
async function sendAlertEmails(station, diffWlBank, emails) {
  if (emails.length === 0) {
    console.log('ไม่พบรายชื่ออีเมลในไฟล์ emails.txt');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });

  const stationNameTh = station.station.tele_station_name.th;
  const provinceTh = station.geocode.province_name.th;
  const amphoeTh = station.geocode.amphoe_name.th;
  const minBank = station.station.min_bank;
  const waterlevelNow = (minBank - diffWlBank).toFixed(2);
  const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: emails.join(','),
    subject: `${CONFIG.EMAIL_SUBJECT_PREFIX} - ${stationNameTh}`,
    text:
      `🚨 แจ้งเตือนระดับน้ำใกล้ล้นตลิ่ง\n\n` +
      `สถานี: ${stationNameTh}\n` +
      `ที่ตั้ง: อ.${amphoeTh} จ.${provinceTh}\n` +
      `ระดับน้ำปัจจุบัน (เทียบ MSL): ~${waterlevelNow} ม.\n` +
      `ต่ำกว่าตลิ่ง: ${diffWlBank} ม.\n` +
      `เกณฑ์แจ้งเตือนที่ตั้งไว้: ${CONFIG.ALERT_THRESHOLD_M} ม.\n` +
      `เวลาที่ตรวจสอบ: ${now}\n\n` +
      `ข้อมูลจาก: ThaiWater (สสน.)`
  });

  console.log(`ส่งอีเมลแจ้งเตือนไปยัง ${emails.length} รายชื่อเรียบร้อย`);
}

// ------------------------- ฟังก์ชันหลัก -------------------------------
async function main() {
  const station = await fetchStationData();

  if (!station) {
    console.log('ไม่พบข้อมูลสถานีบางปะกงในผลลัพธ์ API');
    return;
  }

  const diffWlBank = parseFloat(station.diff_wl_bank);
  const state = await getState();

  console.log(`diff_wl_bank: ${diffWlBank} ม. | เคยแจ้งเตือนแล้ว: ${state.alertSent}`);

  if (diffWlBank <= CONFIG.ALERT_THRESHOLD_M) {
    if (!state.alertSent) {
      const emails = await getEmailList();
      await sendAlertEmails(station, diffWlBank, emails);
      await setState({ alertSent: true });
    } else {
      console.log('เข้าเกณฑ์แต่เคยแจ้งเตือนไปแล้ว — ข้าม');
    }
  } else if (diffWlBank >= CONFIG.ALERT_THRESHOLD_M + CONFIG.RESET_BUFFER_M) {
    if (state.alertSent) {
      await setState({ alertSent: false });
      console.log('ระดับน้ำกลับสู่ภาวะปกติ รีเซ็ตสถานะแล้ว');
    } else {
      console.log('ระดับน้ำปกติ');
    }
  } else {
    console.log('อยู่ในช่วงกันชน ไม่ทำอะไร');
  }
}

main().catch(err => {
  console.error('เกิดข้อผิดพลาด:', err);
  process.exit(1);
});
