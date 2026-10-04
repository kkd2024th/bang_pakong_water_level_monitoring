export default async function handler(req, res) {
  try {
    // ใช้ API endpoint V3 ที่ถูกต้อง
    const response = await fetch('https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load');
    const json = await response.json();

    // โครงสร้างของ API v3 มักจะเก็บข้อมูลไว้ใน data หรือ result
    let stations = json.data || json.result || [];
    
    // ค้นหาสถานีที่มีคำว่า "บางปะกง" ในชื่อสถานี (เช่น station_name)
    let targetStation = stations.find(s => {
      let name = s.station_name || s.name || '';
      // ค้นหาภาษาไทยหรืออังกฤษ
      return name.includes('บางปะกง') || name.toLowerCase().includes('bangpakong');
    });

    if (!targetStation) {
      return res.status(404).json({ status: 'error', message: 'ไม่พบข้อมูลสถานีบางปะกงจาก API v3' });
    }

    // ดึงค่าระดับน้ำและระดับตลิ่งตามโครงสร้างของ API v3
    // (ปรับชื่อฟิลด์ตามข้อมูลจริงที่ได้จาก API)
    let waterLevel = targetStation.water_level || targetStation.tele_water_level || 0;
    let bankLevel = targetStation.bank_left || targetStation.bank || 0;
    
    let diffCm = (bankLevel - waterLevel) * 100;
    let isAlert = (diffCm <= 30 || waterLevel >= bankLevel);

    return res.status(200).json({
      status: 'success',
      station_name: targetStation.station_name || 'สถานีบางปะกง',
      water_level: waterLevel,
      bank_left: bankLevel,
      diff_cm: diffCm.toFixed(1),
      is_alert: isAlert
    });

  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.toString() });
  }
}
