export default async function handler(req, res) {
  try {
    // ดึงข้อมูลจาก API v3 ของคลังข้อมูลน้ำแห่งชาติ
    const response = await fetch('https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load');
    const json = await response.json();

    // ค้นหาข้อมูลสถานีจากโครงสร้างของ API v3
    // (ตรวจสอบทุกอาเรย์ที่อาจเก็บข้อมูลสถานี เช่น result, data หรือภาพรวม)
    let stations = [];
    if (json.result) {
      if (Array.isArray(json.result)) stations = json.result;
      else if (json.result.data && Array.isArray(json.result.data)) stations = json.result.data;
    } else if (json.data && Array.isArray(json.data)) {
      stations = json.data;
    } else if (Array.isArray(json)) {
      stations = json;
    }

    // ค้นหาสถานีที่มีคำว่า "บางปะกง" ทั้งชื่อไทยหรืออังกฤษ
    let targetStation = null;
    
    // วนลูปหาในทุกระดับชั้นข้อมูล
    const searchInObject = (obj) => {
      if (!obj || typeof obj !== 'object') return false;
      let str = JSON.stringify(obj);
      return str.includes('บางปะกง') || str.toLowerCase().includes('bangpakong');
    };

    // หากลุ่มข้อมูลที่เป็นสถานีโดยตรงก่อน
    targetStation = stations.find(s => searchInObject(s));

    // ถ้ายังไม่เจอ ลองกระจายหาในทุก Key ของ JSON หลัก
    if (!targetStation) {
      for (let key in json) {
        if (Array.isArray(json[key])) {
          let found = json[key].find(item => searchInObject(item));
          if (found) {
            targetStation = found;
            break;
          }
        }
      }
    }

    if (!targetStation) {
      return res.status(404).json({ 
        status: 'error', 
        message: 'ไม่พบสถานีบางปะกงในระบบ API v3' 
      });
    }

    // ดึงค่าระดับน้ำ (Water Level) และระดับตลิ่ง (Bank Level) 
    // รองรับฟิลด์หลากหลายรูปแบบที่ API อาจใช้
    let waterLevel = targetStation.water_level || targetStation.tele_water_level || targetStation.wl || 0;
    let bankLevel = targetStation.bank_left || targetStation.bank_right || targetStation.bank || 2.50;
    
    // คำนวณระยะห่างจากตลิ่งเป็นเซนติเมตร
    let diffCm = (bankLevel - waterLevel) * 100;
    let isAlert = (diffCm <= 30 || waterLevel >= bankLevel);

    return res.status(200).json({
      status: 'success',
      source: 'HII API v3 (Real Data)',
      station_name: targetStation.station_name || targetStation.name || 'สถานีบางปะกง',
      water_level: Number(waterLevel).toFixed(2),
      bank_left: Number(bankLevel).toFixed(2),
      diff_cm: diffCm.toFixed(1),
      is_alert: isAlert
    });

  } catch (error) {
    return res.status(500).json({ 
      status: 'error', 
      message: 'ไม่สามารถเชื่อมต่อ API ได้: ' + error.toString() 
    });
  }
}
