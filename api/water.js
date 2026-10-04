export default async function handler(req, res) {
  try {
    const response = await fetch('https://api.thaiwater.net/v1/api/tele_water_info');
    const json = await response.json();

    // แปลงข้อมูลทั้งหมดให้อยู่ในรูปแบบข้อความ เพื่อค้นหาว่าสถานี "บางปะกง" อยู่ในโครงสร้างไหน
    let stations = json.result || json.data || json;
    
    // ถ้าข้อมูลไม่ได้เป็น Array ให้พยายามแกะหา Array ข้างใน
    if (!Array.isArray(stations)) {
      return res.status(200).json({ status: 'debug', raw_keys: Object.keys(json), sample: json });
    }

    // ค้นหาสถานีที่มีคำว่า "บางปะกง"
    let targetStation = stations.find(s => {
      let str = JSON.stringify(s);
      return str.includes('บางปะกง');
    });

    if (!targetStation) {
      return res.status(404).json({ 
        status: 'error', 
        message: 'ไม่พบคำว่า บางปะกง ใน API',
        total_stations: stations.length,
        first_station_sample: stations[0] || null
      });
    }

    // ส่งข้อมูลสถานีที่เจอว์กลับมาดูโครงสร้างฟิลด์ชัดๆ
    return res.status(200).json({
      status: 'success_debug',
      found_station: targetStation
    });

  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.toString() });
  }
}
