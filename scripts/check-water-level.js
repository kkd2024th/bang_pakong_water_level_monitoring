/**
 * ====================================================================
 * ระบบแจ้งเตือนระดับน้ำสถานีบางปะกง — ขั้นบันไดตามตาราง
 * - V = ระดับน้ำเทียบตลิ่ง (+ สูงกว่าตลิ่ง / - ต่ำกว่าตลิ่ง)
 *   (diff_wl_bank ของ API เป็นขนาดเฉยๆ ทิศทางดูจาก diff_wl_bank_text)
 * - Telegram: ทุก 0.25 ม. ตั้งแต่ V=-1.0 ถึง +2.0
 *             + "น้ำลดลง" เมื่อมีระดับรีเซ็ต (ยกเว้นระดับเริ่มต้น = ปลอดภัยแล้ว)
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
  LEVEL_RESET_BUFFER_V: 0.25,  // รีเซ็ทเมื่อ V ลดลงจากระดับนั้นเท่านี้ (ม.)
  LEVEL_END_V: 2.0,  // ระดับสูงสุดที่กำหนดไว้

  TELEGRAM_LEVEL_START_V: -1.0,  // ระดับน้ำที่จะเริ่มส่งข้อความ Telegram
  TELEGRAM_LEVEL_STEP_V: 0.25,  // ช่วงของระดับน้ำใน Telegram

  LINE_LEVEL_START_V: -0.5,  // ระดับน้ำที่จะเริ่มส่งข้อความ LINE
  LINE_LEVEL_STEP_V: 0.5,  // ช่วงของระดับน้ำใน LINE

  // Telegram: ส่ง "น้ำลดลง" เมื่อมีระดับรีเซ็ตที่ V สูงกว่าค่านี้
  // (รีเซ็ตระดับที่ V เท่ากับหรือต่ำกว่าค่านี้ ไม่ส่ง เพราะถือว่าปลอดภัยแล้ว)
  TELEGRAM_FALL_MESSAGE_STOP_BELOW_V: -1.0,

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

// ------------------------- คำนวณ V (มีเครื่องหมาย) -------------------------------
const norm = s => String(s ?? '').normalize('NFKC');

function getSignedV(item) {
  const diff = parseFloat(item.diff_wl_bank);
  const text = norm(item.diff_wl_bank_text);

  // 1) ทิศทางจากข้อความของ API (ล้นตลิ่ง/สูงกว่า = บวก, ต่ำกว่า = ลบ)
  let vFromText = null;
  if (Number.isFinite(diff)) {
    const mag = Math.abs(diff);
    if (text.includes(norm('ล้น')) || text.includes(norm('สูงกว่า'))) vFromText = mag;
    else if (text.includes(norm('ต่ำ'))) vFromText = -mag;
    else if (mag === 0) vFromText = 0;
  }

  // 2) สำรอง: waterlevel_msl − min_bank
  const msl = parseFloat(item.waterlevel_msl);
  const minBank = parseFloat(item.station?.min_bank);
  const vFromMsl = Number.isFinite(msl) && Number.isFinite(minBank)
    ? +(msl - minBank).toFixed(2)
    : null;

  if (vFromText !== null && vFromMsl !== null && Math.abs(vFromText - vFromMsl) > 0.05) {
    console.log(
      `คำเตือน: V จากข้อความ (${vFromText.toFixed(2)}) ไม่ตรงกับ waterlevel_msl − min_bank (${vFromMsl.toFixed(2)}) → ใช้ค่าจากข้อความ`
    );
  }

  return vFromText !== null ? vFromText : vFromMsl;
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

// ------------------------- อ่าน/เขียนสถานะ (รีเซ็ตแยกรายช่องทาง) -------------------------------
function defaultChannelState(levelCount) {
  return { sentLevels: new Array(levelCount).fill(false), alertCount: 0 };
}

function isValidChannelState(s, expectedLen) {
  return s && Array.isArray(s.sentLevels) && s.sentLevels.length === expectedLen;
}

async function getState() {
  const freshTelegram = defaultChannelState(TELEGRAM_LEVELS.length);
  const freshLine = defaultChannelState(LINE_LEVELS.length);

  try {
    const parsed = JSON.parse(await readFile(CONFIG.STATE_FILE, 'utf-8'));

    const telegramOk = isValidChannelState(parsed.telegram, TELEGRAM_LEVELS.length);
    const lineOk = isValidChannelState(parsed.line, LINE_LEVELS.length);

    if (!telegramOk) console.log('state ของ Telegram ไม่ตรงกับการตั้งค่าปัจจุบัน → เริ่มใหม่เฉพาะ Telegram');
    if (!lineOk) console.log('state ของ LINE ไม่ตรงกับการตั้งค่าปัจจุบัน → เริ่มใหม่เฉพาะ LINE');

    return {
      telegram: telegramOk ? parsed.telegram : freshTelegram,
      line: lineOk ? parsed.line : freshLine
    };
  } catch {
    return { telegram: freshTelegram, line: freshLine };
  }
}

async function setState(state) {
  await writeFile(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
}

// ------------------------- สร้างข้อความ -------------------------------
function formatV(v) {
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

// สร้างบรรทัด "≈1.17 ม. (เทียบ MSL)"
function mslLine(item, V) {
  const msl = parseFloat(item.waterlevel_msl);
  const minBank = parseFloat(item.station?.min_bank);

  let value = null;
  if (Number.isFinite(msl)) value = msl;                       // ใช้ค่าจริงจาก API ก่อน
  else if (Number.isFinite(minBank)) value = minBank + V;      // สำรอง: ระดับตลิ่ง + V

  return value === null ? '' : `≈${value.toFixed(2)} ม. (เทียบ MSL)\n\n`;
}

// ------------------------- Time stamp: DD/MM/YYYY, HH:MM (ค.ศ.) -------------------------------
function getTimestampLine(item) {
  // เวลาของข้อมูลจาก API (เป็นเวลาไทยอยู่แล้ว เช่น "2026-10-04 21:00")
  const m = String(item.waterlevel_datetime ?? '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) {
    const [, y, mo, d, h, mi] = m;
    return `🕒 ${d}/${mo}/${y}, ${h}:${mi}`;
  }

  // สำรอง: ไม่มีเวลาของข้อมูล → ใช้เวลาปัจจุบัน (Asia/Bangkok)
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date()).map(x => [x.type, x.value])
  );
  return `🕒 ${p.day}/${p.month}/${p.year}, ${p.hour}:${p.minute}`;
}

// ข้อความแจ้งเตือนเมื่อข้ามระดับ (น้ำสูงขึ้น)
function buildAlertMessage(stationName, item, V, level) {
  const emoji = level.V >= 0 ? '🚨' : '⚠️';
  return (
    `${emoji} ระดับน้ำสถานี${stationName} เพิ่มขึ้น\n\n` +
    mslLine(item, V) +
    `${formatV(V)} ม. (${V >= 0 ? 'สูงกว่าตลิ่ง' : 'ต่ำกว่าตลิ่ง'})\n\n` +
    getTimestampLine(item)
  );
}

// ข้อความ "น้ำลดลง" (Telegram)
function buildFallMessage(stationName, item, V) {
  const cm = Math.round(Math.abs(V) * 100);
  let relativeText;
  if (cm === 0) relativeText = 'เสมอระดับตลิ่ง';
  else if (V > 0) relativeText = `สูงกว่าตลิ่ง`;
  else relativeText = `ต่ำกว่าตลิ่ง`;

  return (
    `📉 ระดับน้ำสถานี${stationName} ลดลง\n\n` +
    mslLine(item, V) +
    `${formatV(V)} ม. (${relativeText})\n\n` +
    getTimestampLine(item)
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
// fallFn: (ไม่บังคับ) ฟังก์ชันส่งข้อความ "น้ำลดลง"
async function processLadder(channelName, levels, channelState, stationName, item, V, sendFn, fallFn = null) {
  let changed = false;
  const crossed = [];   // ระดับที่เพิ่งข้ามเกณฑ์ในรอบนี้
  const resetIdx = [];  // ระดับที่น้ำลดพ้นจุดรีเซ็ทในรอบนี้

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const alreadySent = channelState.sentLevels[i];

    if (V >= level.V) {
      if (!alreadySent) crossed.push(i);
    } else if (V <= level.resetV) {
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
    const ok = await sendFn(buildAlertMessage(stationName, item, V, topLevel));

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

  // ---------- ข้อความ "น้ำลดลง": ส่งเมื่อมีระดับรีเซ็ตที่ V สูงกว่าเกณฑ์หยุดส่ง ----------
  // (ไม่ส่งถ้ามีการข้ามระดับใหม่ในรอบเดียวกัน เพื่อไม่ให้ได้ข้อความที่ขัดกัน)
  if (fallFn && resetIdx.length > 0 && crossed.length === 0) {
    const highestResetV = Math.max(...resetIdx.map(i => levels[i].V));

    if (highestResetV > CONFIG.TELEGRAM_FALL_MESSAGE_STOP_BELOW_V) {
      const ok = await fallFn(buildFallMessage(stationName, item, V));
      if (ok) {
        console.log(`[${channelName}] รีเซ็ตระดับ V=${highestResetV} ม. (V ปัจจุบัน ${V.toFixed(2)}) → ส่งข้อความน้ำลดลง`);
      } else {
        console.log(`[${channelName}] ส่งข้อความน้ำลดลงไม่สำเร็จ (ไม่ลองใหม่ เพราะรีเซ็ตสถานะไปแล้ว)`);
      }
    } else {
      console.log(
        `[${channelName}] รีเซ็ตเฉพาะระดับ V=${highestResetV} ม. ซึ่งไม่สูงกว่า ${CONFIG.TELEGRAM_FALL_MESSAGE_STOP_BELOW_V} ม.` +
        ` → ไม่ส่งข้อความน้ำลดลง (ปลอดภัยแล้ว)`
      );
    }
  }

  return changed;
}

// ------------------------- ฟังก์ชันหลัก -------------------------------
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
    `ข้อมูล ณ ${item.waterlevel_datetime} | diff_wl_bank=${item.diff_wl_bank} ` +
    `(${String(item.diff_wl_bank_text).trim()}) → V = ${formatV(V)} ม.`
  );

  const telegramChanged = await processLadder(
    'Telegram', TELEGRAM_LEVELS, state.telegram, stationName, item, V,
    sendTelegramMessage, sendTelegramMessage   // อาร์กิวเมนต์สุดท้าย = ส่งข้อความน้ำลดลง
  );
  const lineChanged = await processLadder(
    'LINE', LINE_LEVELS, state.line, stationName, item, V, sendLineMessage
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
