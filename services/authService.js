const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

/**
 * Check rate limit for login attempts
 * @param {string} ip - IP address
 * @param {string} username - Username or email
 * @returns {Promise<boolean>} - true if under limit, false if exceeded
 */
async function checkRateLimit(ip, username) {
	const lockoutTime = 1200; // 20 minutes in seconds
	const maxAttempts = 5;

	const [rows] = await pool.query(
		`SELECT COUNT(*) as attempts 
		FROM login_attempts 
		WHERE (ip_address = ? OR login = ?) 
		AND time > UNIX_TIMESTAMP(DATE_SUB(NOW(), INTERVAL ? SECOND))`,
		[ip, username, lockoutTime]
	);

	return rows[0].attempts < maxAttempts;
}

/**
 * Record a failed login attempt
 * @param {string} ip - IP address
 * @param {string} username - Username or email
 */
async function recordFailedAttempt(ip, username) {
	await pool.query(
		'INSERT INTO login_attempts (ip_address, login, time) VALUES (?, ?, UNIX_TIMESTAMP())',
		[ip, username]
	);
}

/**
 * Clear login attempts after successful login
 * @param {string} ip - IP address
 * @param {string} username - Username or email
 */
async function clearAttempts(ip, username) {
	await pool.query(
		'DELETE FROM login_attempts WHERE ip_address = ? OR login = ?',
		[ip, username]
	);
}

/**
 * Generate JWT token
 * @param {object} userData - User data to encode in token
 * @returns {string} - JWT token
 */
function generateToken(userData) {
	const payload = {
		iss: 'wage-backend',
		iat: Math.floor(Date.now() / 1000),
		exp: Math.floor(Date.now() / 1000) + 1800, // 30 minutes
		data: {
			first_name: userData.first_name,
			last_name: userData.last_name,
			username: userData.username,
			email: userData.email
		}
	};

	return jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256' });
}

/**
 * Refresh JWT token
 * @param {object} decodedData - Decoded token data
 * @returns {string} - New JWT token
 */
function refreshToken(decodedData) {
	return generateToken({
		first_name: decodedData.first_name,
		last_name: decodedData.last_name,
		username: decodedData.username,
		email: decodedData.email
	});
}

/**
 * Get user roles
 * @param {number} userId - User ID
 * @returns {Promise<Array>} - Array of user roles
 */
async function getUserRoles(userId) {
	const [rows] = await pool.query(
		`SELECT r.ID as ROLEID, r.CODE as ROLECODE, r.NAME as ROLENAME
		FROM user_role ur
		JOIN role r ON ur.ROLE_ID = r.ID
		WHERE ur.USER_ID = ? AND ur.IS_ACTIVE = 1`,
		[userId]
	);
	return rows;
}

/**
 * Get user menu permissions
 * @param {number} userId - User ID
 * @returns {Promise<Array>} - Array of menu permissions
 */
async function getUserMenuPermissions(userId) {
	const [rows] = await pool.query(
		`SELECT DISTINCT m.ID as MENUID, m.NAME as MENUNAME, m.URL as MENUURL,
		rp.CAN_VIEW, rp.CAN_CREATE, rp.CAN_UPDATE, rp.CAN_DELETE
		FROM user_role ur
		JOIN role_permission rp ON ur.ROLE_ID = rp.ROLE_ID
		JOIN menu m ON rp.MENU_ID = m.ID
		WHERE ur.USER_ID = ? AND ur.IS_ACTIVE = 1 AND rp.IS_ACTIVE = 1`,
		[userId]
	);
	return rows;
}

/**
 * Record login history
 * @param {object} userData - User data
 * @param {string} ip - IP address
 * @param {string} userAgent - User agent string
 */
async function recordLoginHistory(userData, ip, userAgent) {
	await pool.query(
		`INSERT INTO user_login_history (USER_ID, IP_ADDRESS, USER_AGENT, LOGIN_AT) 
		VALUES (?, ?, ?, NOW())`,
		[userData.USERID, ip, userAgent || 'API Client']
	);
}

/**
 * Login user
 * @param {string} username - Username or email
 * @param {string} password - Password
 * @param {string} ip - IP address
 * @param {string} userAgent - User agent string
 * @returns {Promise<object>} - Login result with token and user data
 */
async function loginUser(username, password, ip, userAgent) {
	// Check rate limit
	const underLimit = await checkRateLimit(ip, username);
	if (!underLimit) {
		throw {
			status: 429,
			message: 'Terlalu banyak percobaan login yang gagal. Akun/IP diblokir sementara. Silakan coba lagi dalam 20 menit.'
		};
	}

	// Query user
	const [users] = await pool.query(
		`SELECT ID as USERID, FIRST_NAME, LAST_NAME, USERNAME, EMAIL, PASSWORD, 
		IS_ACTIVE, IS_BLOCKED, TELEGRAM_CHAT_ID, PHOTO_URL, PHOTO_FILE
		FROM sysuser 
		WHERE (USERNAME = ? OR EMAIL = ?) 
		LIMIT 1`,
		[username, username]
	);

	if (users.length === 0) {
		await recordFailedAttempt(ip, username);
		throw {
			status: 400,
			message: 'Username/ Email tidak terdaftar.'
		};
	}

	const user = users[0];

	// Check if user is active
	if (user.IS_ACTIVE === 0) {
		throw {
			status: 403,
			message: 'Akun Anda belum aktif. Silakan cek file pada email masuk Anda untuk aktivasi akun.'
		};
	}

	// Check if user is blocked
	if (user.IS_BLOCKED === 1) {
		throw {
			status: 403,
			message: 'Akun Anda diblokir.'
		};
	}

	// Verify password
	const passwordMatch = await bcrypt.compare(password, user.PASSWORD);
	if (!passwordMatch) {
		await recordFailedAttempt(ip, username);
		throw {
			status: 400,
			message: 'Password yang anda masukkan salah.'
		};
	}

	// Clear login attempts
	await clearAttempts(ip, username);

	// Check if password needs rehash (cost factor changed)
	const needsRehash = bcrypt.getRounds(user.PASSWORD) !== 10;
	if (needsRehash) {
		const newHash = await bcrypt.hash(password, 10);
		await pool.query('UPDATE sysuser SET PASSWORD = ? WHERE ID = ?', [newHash, user.USERID]);
	}

	// Generate JWT token
	const token = generateToken({
		first_name: user.FIRST_NAME,
		last_name: user.LAST_NAME,
		username: user.USERNAME,
		email: user.EMAIL
	});

	// Get user roles and permissions
	const roles = await getUserRoles(user.USERID);
	const permissions = await getUserMenuPermissions(user.USERID);

	// Get highest role code (for backward compatibility)
	const roleCodes = roles.map(r => r.ROLECODE);
	const access = roleCodes.length > 0 ? Math.min(...roleCodes) : 999;

	// Mark all pending session_invalidation as processed
	await pool.query(
		'UPDATE session_invalidation SET PROCESSED_AT = NOW() WHERE USER_ID = ? AND PROCESSED_AT IS NULL',
		[user.USERID]
	);

	// Record login history
	await recordLoginHistory(user, ip, userAgent);

	return {
		token,
		user: {
			user_id: user.USERID,
			first_name: user.FIRST_NAME,
			last_name: user.LAST_NAME,
			username: user.USERNAME,
			email: user.EMAIL,
			telegram_chat_id: user.TELEGRAM_CHAT_ID,
			photo_url: user.PHOTO_URL,
			photo_file: user.PHOTO_FILE,
			roles,
			menu_permissions: permissions,
			access
		}
	};
}

/**
 * Get user info from database
 * @param {number} userId - User ID
 * @returns {Promise<object>} - User info with roles and permissions
 */
async function getUserInfo(userId) {
	const [users] = await pool.query(
		`SELECT ID as USERID, FIRST_NAME, LAST_NAME, USERNAME, EMAIL, 
		TELEGRAM_CHAT_ID, PHOTO_URL, PHOTO_FILE, IS_ACTIVE, IS_BLOCKED
		FROM sysuser 
		WHERE ID = ? 
		LIMIT 1`,
		[userId]
	);

	if (users.length === 0) {
		throw {
			status: 404,
			message: 'User not found'
		};
	}

	const user = users[0];

	// Check if user is still active
	if (user.IS_ACTIVE === 0 || user.IS_BLOCKED === 1) {
		throw {
			status: 403,
			message: 'Account is inactive or blocked'
		};
	}

	// Get user roles and permissions
	const roles = await getUserRoles(user.USERID);
	const permissions = await getUserMenuPermissions(user.USERID);

	// Get highest role code
	const roleCodes = roles.map(r => r.ROLECODE);
	const access = roleCodes.length > 0 ? Math.min(...roleCodes) : 999;

	// Check session invalidation
	const [invalidations] = await pool.query(
		`SELECT ID, REASON, CREATED_AT 
		FROM session_invalidation 
		WHERE USER_ID = ? AND PROCESSED_AT IS NULL 
		ORDER BY CREATED_AT DESC 
		LIMIT 1`,
		[user.USERID]
	);

	let sessionStatus = 'valid';
	let invalidationReason = null;

	if (invalidations.length > 0) {
		// Mark as processed
		await pool.query(
			'UPDATE session_invalidation SET PROCESSED_AT = NOW() WHERE ID = ?',
			[invalidations[0].ID]
		);
		sessionStatus = 'invalidated';
		invalidationReason = invalidations[0].REASON;
	}

	return {
		valid: true,
		session_status: sessionStatus,
		invalidation_reason: invalidationReason,
		user: {
			user_id: user.USERID,
			first_name: user.FIRST_NAME,
			last_name: user.LAST_NAME,
			username: user.USERNAME,
			email: user.EMAIL,
			telegram_chat_id: user.TELEGRAM_CHAT_ID,
			photo_url: user.PHOTO_URL,
			photo_file: user.PHOTO_FILE,
			roles,
			menu_permissions: permissions,
			access
		}
	};
}

/**
 * Logout user (invalidate session for account switching)
 * @param {number} userId - User ID
 * @param {string} reason - Reason for logout (optional)
 * @returns {Promise<object>} - Logout result
 */
async function logoutUser(userId, reason = 'User logout') {
	// Insert session invalidation record
	await pool.query(
		`INSERT INTO session_invalidation (USER_ID, REASON, CREATED_AT) 
		VALUES (?, ?, NOW())`,
		[userId, reason]
	);

	return {
		success: true,
		message: 'Logout berhasil. Sesi Anda telah dibatalkan.'
	};
}

module.exports = {
	loginUser,
	getUserInfo,
	generateToken,
	refreshToken,
	logoutUser
};
