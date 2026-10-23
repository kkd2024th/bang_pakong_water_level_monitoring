/**
 * ====================================================================
 * ระบบแจ้งเตือนระดับน้ำสถานีบางปะกง — ขั้นบันไดตามตาราง
 * - V = ระดับน้ำเทียบตลิ่ง (+ สูงกว่าตลิ่ง / - ต่ำกว่าตลิ่ง) = -diff_wl_bank
 * - Telegram: ทุก 0.25 ม. ตั้งแต่ V=-1.0 ถึง +2.0
 *             + แจ้ง "น้ำลดลง" เมื่อมีระดับถูกรีเซ็ตและ V ต่ำกว่า -0.5 ม.
 * - LINE:     ทุก 0.5 ม.  ตั้งแต่ V=-0.5 ถึง +2.0
 * - จุดรีเซ็ทของแต่ละระดับ = V ของระดับนั้น − 0.25
 * - ระดับ V < 0 ใช้ ⚠️ / ระดับ V ≥ 0 ใช้ 🚨
 * ====================================================================
 */

import { readFile, writeFile } from 'fs/promises';

const CONFIG = {
  API_URL: 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load',
  STATION_OLD_CODE: 'BPK001',
  STATION_ID: 154,

  // ------------------------- ตั้งค่าขั้นบันได (ตรงตามตาราง) -------------------------
  LEVEL_RESET_BUFFER_V: 0.25,   // รีเซ็ทเมื่อ V ลดลงจากระดับนั้นเท่านี้ (ม.)
  LEVEL_END_V: 2.0,             // ระดับสูงสุดที่กำหนดไว้

  TELEGRAM_LEVEL_START_V: -1.0,
  TELEGRAM_LEVEL_STEP_V: 0.25,

  LINE_LEVEL_START_V: -0.5,
  LINE_LEVEL_STEP_V: 0.5,

  // Telegram: ส่งข้อความ "น้ำลดลง" เมื่อมีการรีเซ็ต และ V ปัจจุบันต่ำกว่าค่านี้ (ม.)
  TELEGRAM_FALL_MESSAGE_BELOW_V: -0.5,

  STATE_FILE: 'state.json',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_IDS_FILE: 'telegram_ids.txt',
  LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN
};

// ------------------------- สร้างรายการระดับขั้นบันได -------------------------------
function buildLevels(startV, stepV, endV) {
  const count = Math.round((endV - startV) / stepV) + 1;
  const levels = [];
  for (let i = 0; i < count; i++) {
    const V = +(startV + i * stepV).toFixed(2);
    levels.push({
      V,
      diffThreshold: +(-V).toFixed(2),
      diffReset: +((-V) + CONFIG.LEVEL_RESET_BUFFER_V).toFixed(2)
    });
  }
  return levels;
}

const TELEGRAM_LEVELS = buildLevels(
  CONFIG.TELEGRAM_LEVEL_START_V, CONFIG.TELEGRAM_LEVEL_STEP_V, CONFIG.LEVEL_END_V
);
const LINE_LEVELS = buildLevels(
  CONFIG.LINE_LEVEL_START_V, CONFIG.LINE_LEVEL_STEP_V, CONFIG.LEVEL_END_V
);

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
function defaultChannelState(levelCount) {
  return {
    sentLevels: new Array(levelCount).fill(false),
    alertCount: 0
  };
}

function defaultState() {
  return {
    telegram: defaultChannelState(TELEGRAM_LEVELS.length),
    line: defaultChannelState(LINE_LEVELS.length)
  };
}

function isValidChannelState(s, expectedLen) {
  return s && Array.isArray(s.sentLevels) && s.sentLevels.length === expectedLen;
}

async function getState() {
  try {
    const raw = await readFile(CONFIG.STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);

    // โครงสร้างเก่า หรือจำนวนระดับไม่ตรงกับที่ตั้งค่าไว้ → เริ่มสถานะใหม่
    if (
      !isValidChannelState(parsed.telegram, TELEGRAM_LEVELS.length) ||
      !isValidChannelState(parsed.line, LINE_LEVELS.length)
    ) {
      console.log('โครงสร้าง state.json ไม่ตรงกับการตั้งค่าปัจจุบัน → เริ่มสถานะใหม่');
      return defaultState();
    }

    return parsed;
  } catch {
    return defaultState();
  }
}

async function setState(state) {
  await writeFile(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
}

// ------------------------- สร้างข้อความ -------------------------------
function formatV(v) {
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

// ข้อความแจ้งเตือนเมื่อข้ามระดับ (น้ำสูงขึ้น)
function buildAlertMessage(station, diffWlBank, level) {
  const stationNameTh = station.station.tele_station_name.th;
  const minBank = station.station.min_bank;
  const waterlevelNow = (minBank - diffWlBank).toFixed(2);
  const actualV = -diffWlBank;
  const emoji = level.V >= 0 ? '🚨' : '⚠️';

  return (
    `${emoji} ระดับน้ำสถานี${stationNameTh}\n\n` +
    `≈${waterlevelNow} ม. (เทียบ MSL)\n\n` +
    `${formatV(actualV)} ม. (${actualV >= 0 ? 'สูงกว่าตลิ่ง' : 'ต่ำกว่าตลิ่ง'})`
  );
}

// ข้อความ "น้ำลดลง" (Telegram)
function buildFallMessage(station, diffWlBank) {
  const stationNameTh = station.station.tele_station_name.th;
  const minBank = station.station.min_bank;
  const waterlevelNow = (minBank - diffWlBank).toFixed(2);
  const actualV = -diffWlBank;
  const belowBankCm = Math.round(diffWlBank * 100);

  return (
    `📉 น้ำลดลง ระดับน้ำสถานี${stationNameTh}\n\n` +
    `≈${waterlevelNow} ม. (เทียบ MSL)\n\n` +
    `${formatV(actualV)} ม. (ต่ำกว่าตลิ่ง ${belowBankCm} ซม.)`
  );
}

// ------------------------- ส่งข้อความผ่าน Telegram (true = สำเร็จอย่างน้อย 1 คน) -------------------------------
async function sendTelegramMessage(message) {
  const chatIds = await getTelegramIds();

  if (chatIds.length === 0 || !CONFIG.TELEGRAM_BOT_TOKEN) {
    console.log('ข้าม Telegram (ไม่มี chat_id หรือ token)');
    return false;
  }

  const apiUrl = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
  let okCount = 0;

  for (const chatId of chatIds) {
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message })
      });
      if (res.ok) {
        okCount++;
      } else {
        console.log(`ส่ง Telegram ไปยัง ${chatId} ไม่สำเร็จ: ${await res.text()}`);
      }
    } catch (e) {
      console.log(`ส่ง Telegram ไปยัง ${chatId} เกิดข้อผิดพลาด: ${e.message}`);
    }
  }

  console.log(`ส่ง Telegram สำเร็จ ${okCount}/${chatIds.length} รายชื่อ`);
  return okCount > 0;
}

// ------------------------- ส่งข้อความผ่าน LINE Broadcast (true = สำเร็จ) -------------------------------
async function sendLineMessage(message) {
  if (!CONFIG.LINE_CHANNEL_ACCESS_TOKEN) {
    console.log('ข้าม LINE (ไม่มี token)');
    return false;
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
      return false;
    }
    console.log('ส่ง LINE (broadcast) เรียบร้อย');
    return true;
  } catch (e) {
    console.log(`ส่ง LINE เกิดข้อผิดพลาด: ${e.message}`);
    return false;
  }
}

// ------------------------- ประมวลผลขั้นบันไดของแต่ละช่องทาง -------------------------------
// fallFn: (ไม่บังคับ) ฟังก์ชันส่งข้อความ "น้ำลดลง" เมื่อมีการรีเซ็ตและ V ต่ำกว่าเกณฑ์
async function processLadder(channelName, levels, channelState, station, diffWlBank, sendFn, fallFn = null) {
  let changed = false;
  const crossed = [];   // ระดับที่เพิ่งข้ามเกณฑ์ในรอบนี้
  const resetIdx = [];  // ระดับที่น้ำลดพ้นจุดรีเซ็ทในรอบนี้

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const alreadySent = channelState.sentLevels[i];

    if (diffWlBank <= level.diffThreshold) {
      if (!alreadySent) crossed.push(i);
    } else if (diffWlBank >= level.diffReset) {
      if (alreadySent) resetIdx.push(i);
    }
  }

  // ---------- รีเซ็ทระดับที่น้ำลดพ้นจุดรีเซ็ท ----------
  if (resetIdx.length > 0) {
    resetIdx.forEach(i => { channelState.sentLevels[i] = false; });
    changed = true;
    console.log(`[${channelName}] รีเซ็ท ${resetIdx.length} ระดับ (V=${resetIdx.map(i => levels[i].V).join(', ')} ม.)`);
  }

  // ---------- ข้ามระดับใหม่: ส่งข้อความเดียวต่อรอบ (ของระดับสูงสุดที่เพิ่งข้าม) ----------
  if (crossed.length > 0) {
    const topLevel = levels[crossed[crossed.length - 1]];
    const ok = await sendFn(buildAlertMessage(station, diffWlBank, topLevel));

    if (ok) {
      channelState.alertCount += 1;
      crossed.forEach(i => { channelState.sentLevels[i] = true; });
      changed = true;
      console.log(
        `[${channelName}] ข้ามระดับ V=${topLevel.V} ม.` +
        (crossed.length > 1 ? ` (พร้อมกัน ${crossed.length} ระดับ)` : '') +
        ` → ส่งข้อความครั้งที่ ${channelState.alertCount}`
      );
    } else {
      console.log(`[${channelName}] ส่งแจ้งเตือนไม่สำเร็จ จะลองใหม่ในรอบถัดไป`);
    }
  }

  // ---------- ข้อความ "น้ำลดลง": มีการรีเซ็ต + V ต่ำกว่าเกณฑ์ + ไม่มีการข้ามระดับใหม่ในรอบเดียวกัน ----------
  if (fallFn && resetIdx.length > 0 && crossed.length === 0) {
    const currentV = -diffWlBank;

    if (currentV < CONFIG.TELEGRAM_FALL_MESSAGE_BELOW_V) {
      const ok = await fallFn(buildFallMessage(station, diffWlBank));
      if (ok) {
        console.log(`[${channelName}] V=${currentV.toFixed(2)} ม. → ส่งข้อความน้ำลดลง`);
      } else {
        console.log(`[${channelName}] ส่งข้อความน้ำลดลงไม่สำเร็จ (ไม่ลองใหม่ เพราะรีเซ็ทสถานะไปแล้ว)`);
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

  if (Number.isNaN(diffWlBank)) {
    console.log(`diff_wl_bank ไม่ใช่ตัวเลข (ค่าที่ได้: ${station.diff_wl_bank}) ข้ามรอบนี้`);
    return;
  }

  const state = await getState();

  console.log(`diff_wl_bank: ${diffWlBank} ม. (V = ${(-diffWlBank).toFixed(2)} ม.)`);

  const telegramChanged = await processLadder(
    'Telegram', TELEGRAM_LEVELS, state.telegram, station, diffWlBank,
    sendTelegramMessage, sendTelegramMessage   // อาร์กิวเมนต์สุดท้าย = ส่งข้อความน้ำลดลง
  );
  const lineChanged = await processLadder(
    'LINE', LINE_LEVELS, state.line, station, diffWlBank, sendLineMessage
  );

  if (telegramChanged || lineChanged) {
    await setState(state);
  } else {
    console.log('ไม่มีการเปลี่ยนแปลงสถานะในรอบนี้');
  }
}

main().catch(err => {
  console.error('เกิดข้อผิดพลาด:', err);
  process.exit(1);
});
