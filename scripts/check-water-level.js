/**
 * ====================================================================
 * ระบบแจ้งเตือนระดับน้ำสถานีบางปะกง (ThaiWater API)
 * รันผ่าน GitHub Actions — อ่าน/บันทึกสถานะและรายชื่อจาก Google Sheets
 * ====================================================================
 */
import { google } from 'googleapis';
import nodemailer from 'nodemailer';

// ------------------------- การตั้งค่า -------------------------------
const CONFIG = {
  API_URL: 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load',
  STATION_OLD_CODE: 'BPK001',
  STATION_ID: 154,

  ALERT_THRESHOLD_M: 0.50,   // แจ้งเตือนเมื่อระดับน้ำต่ำกว่าตลิ่งน้อยกว่าค่านี้ (เมตร)
  RESET_BUFFER_M: 0.20,      // ต้องสูงกว่าเกณฑ์เท่านี้ ถึงจะรีเซ็ตสถานะ

  SHEET_LIST_NAME: 'list',
  SHEET_STATE_NAME: 'State',
  SHEET_LOG_NAME: 'Log',

  EMAIL_SUBJECT_PREFIX: '🚨 แจ้งเตือนระดับน้ำบางปะกง'
};

// ------------------------- Google Sheets client -------------------------------
function getSheetsClient() {
  const credentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8')
  );

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return google.sheets({ version: 'v4', auth });
}

// ------------------------- ดึงข้อมูลจาก ThaiWater API -------------------------------
async function fetchStationData() {
  const res = await fetch(CONFIG.API_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (GitHub Actions water-alert bot)',
      'Referer': 'https://www.thaiwater.net/'
    }
  });

  if (!res.ok) {
    throw new Error(`API ตอบกลับผิดพลาด: ${res.status}`);
  }

  const data = await res.json();
  const list = Array.isArray(data) ? data : (data.data || data.waterlevel || []);

  let found = list.find(item => item.station?.tele_station_oldcode === CONFIG.STATION_OLD_CODE);
  if (!found) {
    found = list.find(item => item.station?.id === CONFIG.STATION_ID);
  }

  return found || null;
}

// ------------------------- อ่านรายชื่ออีเมลจากชีต "list" -------------------------------
async function getEmailList(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${CONFIG.SHEET_LIST_NAME}!A:A`
  });

  const rows = res.data.values || [];
  return rows
    .map(r => (r[0] || '').trim())
    .filter(v => v.includes('@'));
}

// ------------------------- อ่าน/เขียนสถานะ ALERT_SENT ในชีต "State" -------------------------------
async function getAlertState(sheets, spreadsheetId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${CONFIG.SHEET_STATE_NAME}!B1`
    });
    return (res.data.values?.[0]?.[0] || 'false') === 'true';
  } catch {
    return false; // ถ้าชีต/เซลล์ยังไม่มี ถือว่ายังไม่เคยแจ้งเตือน
  }
}

async function setAlertState(sheets, spreadsheetId, sent) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${CONFIG.SHEET_STATE_NAME}!A1:B1`,
    valueInputOption: 'RAW',
    requestBody: { values: [['ALERT_SENT', sent ? 'true' : 'false']] }
  });
}

// ------------------------- บันทึก Log ลงชีต "Log" -------------------------------
async function logToSheet(sheets, spreadsheetId, status, message, diffWlBank) {
  const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${CONFIG.SHEET_LOG_NAME}!A:D`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[now, status, message, diffWlBank]] }
  });
}

// ------------------------- ส่งอีเมลแจ้งเตือน -------------------------------
async function sendAlertEmails(station, diffWlBank, emails) {
  if (emails.length === 0) {
    console.log('ไม่พบรายชื่ออีเมลในชีต "list"');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  const stationNameTh = station.station.tele_station_name.th;
  const provinceTh = station.geocode.province_name.th;
  const amphoeTh = station.geocode.amphoe_name.th;
  const minBank = station.station.min_bank;
  const waterlevelNow = (minBank - diffWlBank).toFixed(2);
  const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });

  const subject = `${CONFIG.EMAIL_SUBJECT_PREFIX} - ${stationNameTh}`;
  const text =
    `🚨 แจ้งเตือนระดับน้ำใกล้ล้นตลิ่ง\n\n` +
    `สถานี: ${stationNameTh}\n` +
    `ที่ตั้ง: อ.${amphoeTh} จ.${provinceTh}\n` +
    `ระดับน้ำปัจจุบัน (เทียบ MSL): ~${waterlevelNow} ม.\n` +
    `ต่ำกว่าตลิ่ง: ${diffWlBank} ม.\n` +
    `เกณฑ์แจ้งเตือนที่ตั้งไว้: ${CONFIG.ALERT_THRESHOLD_M} ม.\n` +
    `เวลาที่ตรวจสอบ: ${now}\n\n` +
    `ข้อมูลจาก: ThaiWater (สสน.)`;

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: emails.join(','),
    subject,
    text
  });

  console.log(`ส่งอีเมลแจ้งเตือนไปยัง ${emails.length} รายชื่อเรียบร้อย`);
}

// ------------------------- ฟังก์ชันหลัก -------------------------------
async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheets = getSheetsClient();

  const station = await fetchStationData();

  if (!station) {
    console.log('ไม่พบข้อมูลสถานีบางปะกงในผลลัพธ์ API');
    await logToSheet(sheets, spreadsheetId, 'ERROR', 'ไม่พบสถานีในข้อมูล API', null);
    return;
  }

  const diffWlBank = parseFloat(station.diff_wl_bank);
  const alertAlreadySent = await getAlertState(sheets, spreadsheetId);

  console.log(`diff_wl_bank: ${diffWlBank} ม. | เคยแจ้งเตือนแล้ว: ${alertAlreadySent}`);

  if (diffWlBank <= CONFIG.ALERT_THRESHOLD_M) {
    if (!alertAlreadySent) {
      const emails = await getEmailList(sheets, spreadsheetId);
      await sendAlertEmails(station, diffWlBank, emails);
      await setAlertState(sheets, spreadsheetId, true);
      await logToSheet(sheets, spreadsheetId, 'ALERT_SENT', 'ส่งแจ้งเตือนแล้ว', diffWlBank);
    } else {
      await logToSheet(sheets, spreadsheetId, 'ALERT_SKIPPED', 'เข้าเกณฑ์แต่เคยแจ้งเตือนไปแล้ว', diffWlBank);
    }
  } else if (diffWlBank >= CONFIG.ALERT_THRESHOLD_M + CONFIG.RESET_BUFFER_M) {
    if (alertAlreadySent) {
      await setAlertState(sheets, spreadsheetId, false);
      await logToSheet(sheets, spreadsheetId, 'RESET', 'ระดับน้ำกลับสู่ภาวะปกติ รีเซ็ตสถานะ', diffWlBank);
    } else {
      await logToSheet(sheets, spreadsheetId, 'NORMAL', 'ระดับน้ำปกติ', diffWlBank);
    }
  } else {
    await logToSheet(sheets, spreadsheetId, 'BUFFER_ZONE', 'อยู่ในช่วงกันชน', diffWlBank);
  }
}

main().catch(err => {
  console.error('เกิดข้อผิดพลาด:', err);
  process.exit(1);
});
