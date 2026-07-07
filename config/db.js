const mysql = require('mysql2/promise');

// Uses environment variables if provided; fallback to defaults.
// Set in .env: DB_HOST, DB_USER, DB_PASS, DB_NAME
const pool = mysql.createPool({
	host: process.env.DB_HOST,
	user: process.env.DB_USER,
	password: process.env.DB_PASS,
	database: process.env.DB_NAME,
	waitForConnections: true,
	connectionLimit: parseInt(process.env.DB_POOL_LIMIT),
	queueLimit: 0,
	timezone: '+07:00' // Set timezone for JavaScript Date serialization
});

// Set MySQL session timezone to match PHP/CodeIgniter (Asia/Jakarta/WIB)
// This ensures NOW() returns WIB time, not UTC
// The 'connection' event fires when a new underlying connection is created
pool.on('connection', function (connection) {
  connection.query("SET time_zone = '+07:00'", function (err) {
    if (err) {
      console.error('[DB] Failed to set session timezone:', err.message);
    } else {
      console.log('[DB] MySQL session timezone set to +07:00 (WIB)');
    }
  });
});

module.exports = pool;
