/**
 * ====================================================================
 * ระบบแจ้งเตือนระดับน้ำสถานีบางปะกง (ThaiWater) — แจ้งเตือนแบบขั้นบันได
 *
 * V = ระดับน้ำเทียบตลิ่ง (+ สูงกว่าตลิ่ง / - ต่ำกว่าตลิ่ง)
 *     (diff_wl_bank ของ API เป็นขนาดเฉยๆ ทิศทางดูจาก diff_wl_bank_text)
 *
 * กติกา (ตัวเลขทั้งหมดตั้งที่ CONFIG):
 *  - แต่ละช่องทางมีระดับเป็นขั้นบันได ตั้งแต่ START_V ทุกๆ STEP_V
 *  - V ข้ามระดับขึ้นไป → ส่งข้อความ (รอบละ 1 ข้อความ ของระดับสูงสุดที่เพิ่งข้าม)
 *  - V ลดลงถึง (ระดับนั้น − LEVEL_RESET_BUFFER_V) → รีเซ็ตระดับนั้น
 *    เพื่อให้แจ้งซ้ำได้เมื่อน้ำกลับขึ้นมาอีก
 *  - Telegram ส่งข้อความ "น้ำลดลง" เมื่อมีระดับรีเซ็ตที่ V สูงกว่า
 *    TELEGRAM_FALL_MESSAGE_STOP_BELOW_V
 * ====================================================================
 */

import { readFile, writeFile } from 'fs/promises';

// ====================================================================
// ตั้งค่า
// ====================================================================
const CONFIG = {
  // สถานีที่เฝ้าระวัง
  API_URL: 'https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load',
  STATION_OLD_CODE: 'BPK001',
  STATION_ID: 154,

  // ขั้นบันไดแจ้งเตือน (หน่วย: เมตร)
  LEVEL_END_V: 5.0,              // ระดับสูงสุดที่สร้างไว้
  LEVEL_RESET_BUFFER_V: 0.25,    // รีเซ็ตระดับเมื่อ V ลดลงจากระดับนั้นเท่านี้

  TELEGRAM_LEVEL_START_V: -0.5,  // Telegram: ระดับแรกที่เริ่มส่งข้อความ
  TELEGRAM_LEVEL_STEP_V: 0.25,   // Telegram: ระยะห่างระหว่างระดับ

  LINE_LEVEL_START_V: 0,         // LINE: ระดับแรกที่เริ่มส่งข้อความ
  LINE_LEVEL_STEP_V: 0.3,        // LINE: ระยะห่างระหว่างระดับ

  // Telegram: ส่ง "น้ำลดลง" เมื่อมีระดับรีเซ็ตที่ V สูงกว่าค่านี้
  // (รีเซ็ตระดับที่ V เท่ากับหรือต่ำกว่าค่านี้ จะไม่ส่ง เพราะถือว่าปลอดภัยแล้ว)
  TELEGRAM_FALL_MESSAGE_STOP_BELOW_V: -0.75,

  // หัวข้อข้อความ
  ICON_RISE: '🔺',
  ICON_FALL: '🔻',

  // ไฟล์และ token
  STATE_FILE: 'state.json',
  TELEGRAM_IDS_FILE: 'telegram_ids.txt',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN
};

// ====================================================================
// ระดับขั้นบันได
// ====================================================================
function buildLevels(startV, stepV, endV) {
  const count = Math.round((endV - startV) / stepV) + 1;
  const levels = [];

  for (let i = 0; i < count; i++) {
    const V = +(startV + i * stepV).toFixed(2);
    levels.push({ V, resetV: +(V - CONFIG.LEVEL_RESET_BUFFER_V).toFixed(2) });
  }
  return levels;
}

const TELEGRAM_LEVELS = buildLevels(
  CONFIG.TELEGRAM_LEVEL_START_V, CONFIG.TELEGRAM_LEVEL_STEP_V, CONFIG.LEVEL_END_V
);
const LINE_LEVELS = buildLevels(
  CONFIG.LINE_LEVEL_START_V, CONFIG.LINE_LEVEL_STEP_V, CONFIG.LEVEL_END_V
);

// ====================================================================
// ดึงข้อมูลและคำนวณ V
// ====================================================================
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

  return (
    list.find(item => item.station?.tele_station_oldcode === CONFIG.STATION_OLD_CODE) ||
    list.find(item => item.station?.id === CONFIG.STATION_ID) ||
    null
  );
}

const normalizeText = s => String(s ?? '').normalize('NFKC');

// คำนวณ V (มีเครื่องหมาย) — คืน null ถ้าคำนวณไม่ได้
function getSignedV(item) {
  const diff = parseFloat(item.diff_wl_bank);
  const text = normalizeText(item.diff_wl_bank_text);

  // 1) ทิศทางจากข้อความของ API (ล้นตลิ่ง/สูงกว่า = บวก, ต่ำกว่า = ลบ)
  let vFromText = null;
  if (Number.isFinite(diff)) {
    const magnitude = Math.abs(diff);
    if (text.includes(normalizeText('ล้น')) || text.includes(normalizeText('สูงกว่า'))) {
      vFromText = magnitude;
    } else if (text.includes(normalizeText('ต่ำ'))) {
      vFromText = -magnitude;
    } else if (magnitude === 0) {
      vFromText = 0;
    }
  }

  // 2) สำรอง: waterlevel_msl − min_bank
  const msl = parseFloat(item.waterlevel_msl);
  const minBank = parseFloat(item.station?.min_bank);
  const vFromMsl = Number.isFinite(msl) && Number.isFinite(minBank)
    ? +(msl - minBank).toFixed(2)
    : null;

  if (vFromText !== null && vFromMsl !== null && Math.abs(vFromText - vFromMsl) > 0.05) {
    console.log(
      `คำเตือน: V จากข้อความ (${vFromText.toFixed(2)}) ไม่ตรงกับ ` +
      `waterlevel_msl − min_bank (${vFromMsl.toFixed(2)}) → ใช้ค่าจากข้อความ`
    );
  }

  return vFromText !== null ? vFromText : vFromMsl;
}

// อายุของข้อมูล (นาที) — ใช้แสดงใน log เท่านั้น (waterlevel_datetime เป็นเวลาไทย UTC+7)
function getDataAgeMinutes(item) {
  const m = String(item.waterlevel_datetime ?? '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;

  const [, y, mo, d, h, mi] = m;
  const dataUtcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi) - 7 * 60 * 60 * 1000;
  return Math.round((Date.now() - dataUtcMs) / 60000);
}

// ====================================================================
// สร้างข้อความ
// ====================================================================
function formatV(v) {
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

function describeBank(V) {
  if (V > 0) return 'สูงกว่าตลิ่ง';
  if (V < 0) return 'ต่ำกว่าตลิ่ง';
  return 'เสมอระดับตลิ่ง';
}

// บรรทัด "≈1.17 ม. (เทียบ MSL)" — ไม่มีข้อมูลก็คืนข้อความว่าง
function mslLine(item, V) {
  const msl = parseFloat(item.waterlevel_msl);
  const minBank = parseFloat(item.station?.min_bank);

  let value = null;
  if (Number.isFinite(msl)) value = msl;                    // ใช้ค่าจริงจาก API ก่อน
  else if (Number.isFinite(minBank)) value = minBank + V;   // สำรอง: ระดับตลิ่ง + V

  return value === null ? '' : `≈${value.toFixed(2)} ม. (เทียบ MSL)\n\n`;
}

function buildMessage(icon, stationName, item, V) {
  return (
    `${icon} ระดับน้ำสถานี${stationName}\n\n` +
    mslLine(item, V) +
    `${formatV(V)} ม. (${describeBank(V)})`
  );
}

// ====================================================================
// ส่งข้อความ (คืนค่า true ถ้าส่งสำเร็จ)
// ====================================================================
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

// สำเร็จเมื่อส่งถึงอย่างน้อย 1 คน
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

      if (res.ok) okCount++;
      else console.log(`ส่ง Telegram ไปยัง ${chatId} ไม่สำเร็จ: ${await res.text()}`);
    } catch (e) {
      console.log(`ส่ง Telegram ไปยัง ${chatId} เกิดข้อผิดพลาด: ${e.message}`);
    }
  }

  console.log(`ส่ง Telegram สำเร็จ ${okCount}/${chatIds.length} รายชื่อ`);
  return okCount > 0;
}

// ส่งแบบ Broadcast ถึงเพื่อนทุกคนของบัญชี LINE Official
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

// ====================================================================
// ช่องทางแจ้งเตือน
//   stateKey : ชื่อที่ใช้เก็บใน state.json
//   send     : ฟังก์ชันส่งข้อความแจ้งเตือนน้ำสูงขึ้น
//   sendFall : ฟังก์ชันส่งข้อความ "น้ำลดลง" (null = ไม่ส่ง)
// ====================================================================
const CHANNELS = [
  { name: 'Telegram', stateKey: 'telegram', levels: TELEGRAM_LEVELS, send: sendTelegramMessage, sendFall: sendTelegramMessage },
  { name: 'LINE',     stateKey: 'line',     levels: LINE_LEVELS,     send: sendLineMessage,     sendFall: null }
];

// ====================================================================
// อ่าน/เขียนสถานะ (รีเซ็ตแยกรายช่องทางเมื่อโครงสร้างไม่ตรงกับการตั้งค่า)
// ====================================================================
async function getState() {
  let saved = {};
  try {
    saved = JSON.parse(await readFile(CONFIG.STATE_FILE, 'utf-8'));
  } catch {
    // ไม่มีไฟล์หรืออ่านไม่ได้ → เริ่มใหม่ทั้งหมด
  }

  const state = {};
  for (const channel of CHANNELS) {
    const old = saved[channel.stateKey];
    const valid = Array.isArray(old?.sentLevels) && old.sentLevels.length === channel.levels.length;

    if (old && !valid) {
      console.log(`state ของ ${channel.name} ไม่ตรงกับการตั้งค่าปัจจุบัน → เริ่มใหม่เฉพาะ ${channel.name}`);
    }

    state[channel.stateKey] = valid
      ? old
      : { sentLevels: new Array(channel.levels.length).fill(false), alertCount: 0 };
  }

  return state;
}

async function setState(state) {
  await writeFile(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
}

// ====================================================================
// ประมวลผลขั้นบันไดของหนึ่งช่องทาง (คืนค่า true ถ้า state เปลี่ยน)
// ====================================================================
async function processChannel(channel, channelState, { stationName, item, V }) {
  const { name, levels, send, sendFall } = channel;
  const crossed = [];    // ระดับที่เพิ่งข้ามเกณฑ์ในรอบนี้
  const resetIdx = [];   // ระดับที่น้ำลดพ้นจุดรีเซ็ตในรอบนี้
  let changed = false;

  levels.forEach((level, i) => {
    const alreadySent = channelState.sentLevels[i];

    if (V >= level.V) {
      if (!alreadySent) crossed.push(i);
    } else if (V <= level.resetV) {
      if (alreadySent) resetIdx.push(i);
    }
  });

  // ---------- 1) รีเซ็ตระดับที่น้ำลดพ้นจุดรีเซ็ต ----------
  if (resetIdx.length > 0) {
    resetIdx.forEach(i => { channelState.sentLevels[i] = false; });
    changed = true;
    console.log(`[${name}] รีเซ็ต ${resetIdx.length} ระดับ (V=${resetIdx.map(i => levels[i].V).join(', ')} ม.)`);
  }

  // ---------- 2) ข้ามระดับใหม่: ส่งข้อความเดียวต่อรอบ (ลองใหม่ในรอบถัดไปถ้าส่งไม่สำเร็จ) ----------
  if (crossed.length > 0) {
    const topLevel = levels[crossed[crossed.length - 1]];
    const ok = await send(buildMessage(CONFIG.ICON_RISE, stationName, item, V));

    if (ok) {
      channelState.alertCount += 1;
      crossed.forEach(i => { channelState.sentLevels[i] = true; });
      changed = true;
      console.log(
        `[${name}] ข้ามระดับ V=${topLevel.V} ม.` +
        (crossed.length > 1 ? ` (พร้อมกัน ${crossed.length} ระดับ)` : '') +
        ` → ส่งข้อความครั้งที่ ${channelState.alertCount}`
      );
    } else {
      console.log(`[${name}] ส่งแจ้งเตือนไม่สำเร็จ จะลองใหม่ในรอบถัดไป`);
    }
  }

  // ---------- 3) ข้อความ "น้ำลดลง" ----------
  // ส่งเมื่อมีระดับรีเซ็ตที่ V สูงกว่าเกณฑ์หยุดส่ง และไม่มีการข้ามระดับใหม่ในรอบเดียวกัน
  // (กันข้อความที่ขัดกัน) — ส่งไม่สำเร็จจะไม่ลองใหม่ เพราะรีเซ็ตสถานะไปแล้ว
  if (sendFall && resetIdx.length > 0 && crossed.length === 0) {
    const highestResetV = Math.max(...resetIdx.map(i => levels[i].V));
    const stopBelowV = CONFIG.TELEGRAM_FALL_MESSAGE_STOP_BELOW_V;

    if (highestResetV > stopBelowV) {
      const ok = await sendFall(buildMessage(CONFIG.ICON_FALL, stationName, item, V));
      console.log(
        ok
          ? `[${name}] รีเซ็ตระดับ V=${highestResetV} ม. (V ปัจจุบัน ${V.toFixed(2)}) → ส่งข้อความน้ำลดลง`
          : `[${name}] ส่งข้อความน้ำลดลงไม่สำเร็จ (ไม่ลองใหม่)`
      );
    } else {
      console.log(
        `[${name}] รีเซ็ตเฉพาะระดับ V=${highestResetV} ม. ซึ่งไม่สูงกว่า ${stopBelowV} ม.` +
        ` → ไม่ส่งข้อความน้ำลดลง (ปลอดภัยแล้ว)`
      );
    }
  }

  return changed;
}

// ====================================================================
// ฟังก์ชันหลัก
// ====================================================================
async function main() {
  const item = await fetchStationData();

  if (!item) {
    console.log('ไม่พบข้อมูลสถานีบางปะกงในผลลัพธ์ API');
    return;
  }

  const V = getSignedV(item);

  if (V === null) {
    console.log(
      `คำนวณระดับน้ำเทียบตลิ่งไม่ได้ (diff_wl_bank=${item.diff_wl_bank}, ` +
      `text=${item.diff_wl_bank_text}) ข้ามรอบนี้`
    );
    return;
  }

  const stationName = item.station.tele_station_name.th.trim();
  const state = await getState();

  console.log(
    `ข้อมูล ณ ${item.waterlevel_datetime} (อายุ ${getDataAgeMinutes(item) ?? '?'} นาที) | ` +
    `diff_wl_bank=${item.diff_wl_bank} (${String(item.diff_wl_bank_text).trim()}) → V = ${formatV(V)} ม.`
  );

  let changed = false;
  for (const channel of CHANNELS) {
    const channelChanged = await processChannel(channel, state[channel.stateKey], { stationName, item, V });
    changed = changed || channelChanged;
  }

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
