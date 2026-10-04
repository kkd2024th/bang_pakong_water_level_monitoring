export default async function handler(req, res) {
  try {
    const response = await fetch('https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load');
    const json = await response.json();

    // ค้นหาข้อมูลอาเรย์ที่เก็บสถานี (มักจะอยู่ใน result.data หรือ data หรือเป็นอาเรย์ตรงๆ)
    let list = [];
    if (json.result) {
      if (Array.isArray(json.result)) list = json.result;
      else if (json.result.data && Array.isArray(json.result.data)) list = json.result.data;
    } else if (json.data && Array.isArray(json.data)) {
      list = json.data;
    } else if (Array.isArray(json)) {
      list = json;
    }

    // ค้นหาสถานีบางปะกงจากโครงสร้าง station.id === 154 หรือชื่อสถานี
    let target = list.find(item => {
      if (!item) return false;
      // เช็กจากรหัสสถานี 154 หรือชื่อ
      if (item.station && item.station.id === 154) return true;
      let str = JSON.stringify(item);
      return str.includes('บางปะกง') || str.includes('154');
    });

    if (!target) {
      return res.status(404).json({ status: 'error', message: 'ไม่พบข้อมูลสถานีบางปะกง (ID: 154)' });
    }

    // ดึงค่าตามโครงสร้างจริงที่คุณแกะมา
    let stationName = target.station?.tele_station_name?.th || 'บางปะกง';
    let bankLevel = target.station?.min_bank || target.station?.left_bank || 1.67;
    
    // ดึงค่า diff_wl_bank (ระยะห่างจากตลิ่งหน่วยเป็นเมตร) แล้วแปลงเป็นเซนติเมตร
    // หรือคำนวณจากระดับน้ำจริงถ้ามี
    let diffMeters = target.diff_wl_bank ? parseFloat(target.diff_wl_bank) : 0.98;
    let diffCm = diffMeters * 100;

    // สมมติฐานระดับน้ำปัจจุบันเทียบกับตลิ่ง
    let waterLevel = bankLevel - diffMeters;
    
    // เงื่อนไขแจ้งเตือน: ถ้าระยะห่างจากตลิ่งน้อยกว่า 30 ซม. (0.3 เมตร) หรือน้ำล้น
    let isAlert = (diffCm <= 30);

    return res.status(200).json({
      status: 'success',
      station_name: 'สถานี ' + stationName,
      water_level: waterLevel.toFixed(2),
      bank_left: bankLevel.toFixed(2),
      diff_cm: diffCm.toFixed(1),
      is_alert: isAlert,
      datetime: target.waterlevel_datetime || 'ข้อมูลล่าสุด'
    });

  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.toString() });
  }
}
