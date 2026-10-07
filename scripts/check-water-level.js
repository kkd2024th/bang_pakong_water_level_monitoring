/**
 * ====================================================================
 * ระบบแจ้งเตือนระดับน้ำสถานีบางปะกง — เวอร์ชันแจ้งเตือนแบบขั้นบันได (Step Ladder)
 * - Telegram: เริ่มแจ้งเตือนที่ V = -1.0 ม. (diff_wl_bank = 1.0) ทุกๆ 0.5 ม.
 * - LINE: เริ่มแจ้งเตือนที่ V = -0.5 ม. (diff_wl_bank = 0.5) ทุกๆ 0.5 ม.
 * - V = ระดับน้ำเทียบตลิ่ง (+ สูงกว่าตลิ่ง / - ต่ำกว่าตลิ่ง) = -diff_wl_bank
 * - แต่ละระดับมีจุดรีเซ็ทของตัวเอง (ถอยกลับ 0.25 ม. จากระดับนั้น)
 * ====================================================================
 */

import { readFile, writeFile } from 'fs/promises';

const CONFIG = {
  API_URL: 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load',
  STATION_OLD_CODE: 'BPK001',
  STATION_ID: 154,

  // ------------------------- ตั้งค่าขั้นบันไดแจ้งเตือน -------------------------
  LEVEL_STEP_V: 0.5,            // ระยะห่างระหว่างแต่ละระดับ (ม.)
  LEVEL_RESET_BUFFER_V: 0.25,   // ต้องถอยกลับเท่านี้ (ม.) ถึงจะรีเซ็ทระดับนั้นได้

  TELEGRAM_LEVEL_START_V: -1.0, // ระดับแรกสุดที่ Telegram เริ่มแจ้งเตือน
  LINE_LEVEL_START_V: -0.5,     // ระดับแรกสุดที่ LINE เริ่มแจ้งเตือน
  LEVEL_COUNT: 10,              // จำนวนระดับที่สร้างไว้ล่วงหน้า (กันน้ำท่วมสูงเกินคาด)

  STATE_FILE: 'state.json',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_IDS_FILE: 'telegram_ids.txt',
  LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN
};

// ------------------------- สร้างรายการระดับขั้นบันได -------------------------------
function buildLevels(startV) {
  const levels = [];
  for (let i = 0; i < CONFIG.LEVEL_COUNT; i++) {
    const V = +(startV + i * CONFIG.LEVEL_STEP_V).toFixed(2);
    levels.push({
      V,
      diffThreshold: +(-V).toFixed(2),
      diffReset: +((-V) + CONFIG.LEVEL_RESET_BUFFER_V).toFixed(2)
    });
  }
  return levels;
}

const TELEGRAM_LEVELS = buildLevels(CONFIG.TELEGRAM_LEVEL_START_V);
const LINE_LEVELS = buildLevels(CONFIG.LINE_LEVEL_START_V);

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
  const list = data.waterlevel_data?.data || [];

  let found = list.find(item => item.station?.tele_station_oldcode === CONFIG.STATION_OLD_CODE);
  if (!found) found = list.find(item => item.station?.id === CONFIG.STATION_ID);

  return found || null;
}

// ------------------------- อ่านรายชื่อ chat_id -------------------------------
async function getTelegramIds() {
  let raw;
  try {
    raw = await readFile(CONFIG.TELEGRAM_IDS_FILE, 'utf-8');
  } catch {
    console.log(`ไม่พบไฟล์ ${CONFIG.TELEGRAM_IDS_FILE}`);
    return [];
  }

  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

// ------------------------- อ่าน/เขียนสถานะ -------------------------------
function defaultState() {
  return {
    telegram: { sentLevels: new Array(CONFIG.LEVEL_COUNT).fill(false), alertCount: 0 },
    line: { sentLevels: new Array(CONFIG.LEVEL_COUNT).fill(false), alertCount: 0 }
  };
}

async function getState() {
  try {
    const raw = await readFile(CONFIG.STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    // เผื่อไฟล์ state.json เก่าที่ยังไม่มีโครงสร้างใหม่
    if (!parsed.telegram || !parsed.line) return defaultState();
    return parsed;
  } catch {
    return defaultState();
  }
}

async function setState(state) {
  await writeFile(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
}

// ------------------------- สร้างข้อความแจ้งเตือน -------------------------------
function buildMessage(station, diffWlBank, level, alertCount) {
  const stationNameTh = station.station.tele_station_name.th;
  const provinceTh = station.geocode.province_name.th;
  const amphoeTh = station.geocode.amphoe_name.th;
  const minBank = station.station.min_bank;
  const waterlevelNow = (minBank - diffWlBank).toFixed(2);
  const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });

  const actualV = -diffWlBank;
  const actualVText = (actualV >= 0 ? '+' : '') + actualV.toFixed(2);
  const levelVText = (level.V >= 0 ? '+' : '') + level.V.toFixed(2);

  return (
    `🚨 แจ้งเตือนระดับน้ำใกล้ล้นตลิ่ง (การแจ้งเตือนครั้งที่ ${alertCount})\n\n` +
    `สถานี: ${stationNameTh}\n` +
    `ที่ตั้ง: อ.${amphoeTh} จ.${provinceTh}\n` +
    `ระดับน้ำปัจจุบัน (เทียบ MSL): ~${waterlevelNow} ม.\n` +
    `ระดับน้ำเทียบตลิ่ง (ค่าจริง ณ ขณะนี้): ${actualVText} ม. (${actualV >= 0 ? 'สูงกว่าตลิ่ง' : 'ต่ำกว่าตลิ่ง'})\n` +
    `ระดับเกณฑ์ที่ข้าม: ${levelVText} ม.\n` +
    `เวลาที่ตรวจสอบ: ${now}\n\n` +
    `ข้อมูลจาก: สสน.`
  );
}

// ------------------------- ส่งข้อความแจ้งเตือนผ่าน Telegram -------------------------------
async function sendTelegramMessage(message) {
  const chatIds = await getTelegramIds();

  if (chatIds.length === 0 || !CONFIG.TELEGRAM_BOT_TOKEN) {
    console.log('ข้าม Telegram (ไม่มี chat_id หรือ token)');
    return;
  }

  const apiUrl = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;

  for (const chatId of chatIds) {
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message })
      });
      if (!res.ok) console.log(`ส่ง Telegram ไปยัง ${chatId} ไม่สำเร็จ: ${await res.text()}`);
    } catch (e) {
      console.log(`ส่ง Telegram ไปยัง ${chatId} เกิดข้อผิดพลาด: ${e.message}`);
    }
  }
  console.log(`ส่ง Telegram ไปยัง ${chatIds.length} รายชื่อเรียบร้อย`);
}

// ------------------------- ส่งข้อความแจ้งเตือนผ่าน LINE (Broadcast) -------------------------------
async function sendLineMessage(message) {
  if (!CONFIG.LINE_CHANNEL_ACCESS_TOKEN) {
    console.log('ข้าม LINE (ไม่มี token)');
    return;
  }

  try {
    const res = await fetch('https://api.line.me/v2/bot/message/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({ messages: [{ type: 'text', text: message }] })
    });

    if (!res.ok) {
      console.log(`ส่ง LINE ไม่สำเร็จ: ${await res.text()}`);
      return;
    }
    console.log('ส่ง LINE (broadcast) เรียบร้อย');
  } catch (e) {
    console.log(`ส่ง LINE เกิดข้อผิดพลาด: ${e.message}`);
  }
}

// ------------------------- ประมวลผลขั้นบันไดของแต่ละช่องทาง -------------------------------
async function processLadder(channelName, levels, channelState, station, diffWlBank, sendFn) {
  let changed = false;

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const alreadySent = channelState.sentLevels[i];

    if (diffWlBank <= level.diffThreshold) {
      // เข้าเกณฑ์ระดับนี้
      if (!alreadySent) {
        channelState.alertCount += 1;
        const message = buildMessage(station, diffWlBank, level, channelState.alertCount);
        await sendFn(message);
        channelState.sentLevels[i] = true;
        changed = true;
        console.log(`[${channelName}] ข้ามระดับ V=${level.V} ม. → ส่งแจ้งเตือนครั้งที่ ${channelState.alertCount}`);
      }
    } else if (diffWlBank >= level.diffReset) {
      // กลับขึ้นสูงกว่าจุดรีเซ็ทของระดับนี้แล้ว
      if (alreadySent) {
        channelState.sentLevels[i] = false;
        changed = true;
        console.log(`[${channelName}] ระดับ V=${level.V} ม. รีเซ็ทแล้ว (น้ำกลับขึ้น)`);
      }
    }
  }

  return changed;
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

  console.log(`diff_wl_bank: ${diffWlBank} ม. (V = ${(-diffWlBank).toFixed(2)} ม.)`);

  let changed = false;

  const telegramChanged = await processLadder(
    'Telegram', TELEGRAM_LEVELS, state.telegram, station, diffWlBank, sendTelegramMessage
  );
  const lineChanged = await processLadder(
    'LINE', LINE_LEVELS, state.line, station, diffWlBank, sendLineMessage
  );

  changed = telegramChanged || lineChanged;

  if (changed) {
    await setState(state);
  } else {
    console.log('ไม่มีการเปลี่ยนแปลงสถานะในรอบนี้');
  }
}

main().catch(err => {
  console.error('เกิดข้อผิดพลาด:', err);
  process.exit(1);
});
