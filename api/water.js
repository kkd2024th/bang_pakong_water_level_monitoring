export default async function handler(req, res) {
  try {
    const response = await fetch('https://api.thaiwater.net/v1/api/tele_water_info');
    const json = await response.json();

    let stations = json.result || json.data || [];
    let targetStation = stations.find(s => s.station_name && s.station_name.includes('บางปะกง'));

    if (!targetStation) {
      return res.status(404).json({ status: 'error', message: 'ไม่พบข้อมูลสถานีบางปะกง' });
    }

    let waterLevel = targetStation.water_level || 0;
    let bankLevel = targetStation.bank_left || 0;
    let diffCm = (bankLevel - waterLevel) * 100;
    let isAlert = (diffCm <= 30 || waterLevel >= bankLevel);

    return res.status(200).json({
      status: 'success',
      station_name: targetStation.station_name,
      water_level: waterLevel,
      bank_left: bankLevel,
      diff_cm: diffCm.toFixed(1),
      is_alert: isAlert
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.toString() });
  }
}
