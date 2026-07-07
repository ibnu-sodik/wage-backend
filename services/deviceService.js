const pool = require('../config/db');

/**
 * Check device exist
 * @param {string} deviceId
 * @param {string} userId
 * @returns {Promise<boolean>}
 */

async function checkDeviceExist(deviceId, userId) {
  const query = 'SELECT COUNT(*) AS count FROM tdvc WHERE ID = ? AND USER_ID = ?';
  const [rows] = await pool.execute(query, [deviceId, userId]);
  return rows[0].count > 0;
}

module.exports = {
  checkDeviceExist,
};