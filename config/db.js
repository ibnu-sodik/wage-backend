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
	queueLimit: 0
});

module.exports = pool;
