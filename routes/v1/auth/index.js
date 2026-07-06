const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { loginUser, getUserInfo, refreshToken, logoutUser } = require('../../../services/authService');

/**
 * POST /api/v1/auth/login
 * Login endpoint - no token required
 */
router.post('/login', async (req, res) => {
	try {
		const { username, password } = req.body;

		// Validation
		if (!username || !password) {
			return res.status(400).json({
				status: 'error',
				message: 'Username dan password wajib diisi'
			});
		}

		// Get IP and user agent
		const ip = req.ip || req.connection.remoteAddress || 'unknown';
		const userAgent = req.get('user-agent') || 'Unknown';

		// Perform login
		const result = await loginUser(username, password, ip, userAgent);

		return res.status(200).json({
			status: 'success',
			message: 'Login berhasil',
			data: result
		});
	} catch (error) {
		const status = error.status || 500;
		const message = error.message || 'Terjadi kesalahan pada server';

		return res.status(status).json({
			status: 'error',
			message
		});
	}
});

/**
 * GET /api/v1/auth/me
 * Get current user info - requires valid token
 */
router.get('/me', async (req, res) => {
	try {
		// Token already verified by verifyToken middleware in app.js
		// req.user contains the decoded token data
		const userData = req.user;

		if (!userData || !userData.username) {
			return res.status(401).json({
				status: 'error',
				message: 'Invalid token data'
			});
		}

		// Get user ID from username
		const pool = require('../../../config/db');
		const [users] = await pool.query(
			'SELECT ID FROM sysuser WHERE USERNAME = ? LIMIT 1',
			[userData.username]
		);

		if (users.length === 0) {
			return res.status(404).json({
				status: 'error',
				message: 'User not found'
			});
		}

		const userId = users[0].ID;

		// Get full user info
		const userInfo = await getUserInfo(userId);

		return res.status(200).json({
			status: 'success',
			data: userInfo
		});
	} catch (error) {
		const status = error.status || 500;
		const message = error.message || 'Terjadi kesalahan pada server';

		return res.status(status).json({
			status: 'error',
			message
		});
	}
});

/**
 * POST /api/v1/auth/refresh
 * Refresh JWT token - accepts expired tokens
 */
router.post('/refresh', async (req, res) => {
	try {
		const authHeader = req.headers['authorization'];
		const token = authHeader && authHeader.split(' ')[1];

		if (!token) {
			return res.status(401).json({
				status: 'error',
				message: 'No token provided'
			});
		}

		// Decode token (allow expired)
		let decoded;
		try {
			decoded = jwt.verify(token, process.env.JWT_SECRET, { 
				algorithms: ['HS256'],
				ignoreExpiration: true // Allow expired tokens for refresh
			});
		} catch (error) {
			return res.status(403).json({
				status: 'error',
				message: 'Invalid token'
			});
		}

		if (!decoded.data) {
			return res.status(403).json({
				status: 'error',
				message: 'Invalid token structure'
			});
		}

		// Verify user still exists and is active
		const pool = require('../../../config/db');
		const [users] = await pool.query(
			'SELECT IS_ACTIVE, IS_BLOCKED FROM sysuser WHERE USERNAME = ? LIMIT 1',
			[decoded.data.username]
		);

		if (users.length === 0) {
			return res.status(404).json({
				status: 'error',
				message: 'User not found'
			});
		}

		if (users[0].IS_ACTIVE === 0 || users[0].IS_BLOCKED === 1) {
			return res.status(403).json({
				status: 'error',
				message: 'Account is inactive or blocked'
			});
		}

		// Generate new token
		const newToken = refreshToken(decoded.data);

		return res.status(200).json({
			status: 'success',
			data: {
				token: newToken,
				expires_in: 1800 // 30 minutes in seconds
			}
		});
	} catch (error) {
		return res.status(500).json({
			status: 'error',
			message: error.message || 'Terjadi kesalahan pada server'
		});
	}
});

/**
 * POST /api/v1/auth/logout
 * Logout endpoint - requires valid token
 * Invalidates the current session for account switching
 */
router.post('/logout', async (req, res) => {
	try {
		// Token already verified by verifyToken middleware (from app.js for /me endpoint)
		// But since this is under /auth which bypasses verifyToken, we need to manually verify
		const authHeader = req.headers['authorization'];
		const token = authHeader && authHeader.split(' ')[1];

		if (!token) {
			return res.status(401).json({
				status: 'error',
				message: 'Token tidak ditemukan'
			});
		}

		// Decode and verify token
		let decoded;
		try {
			decoded = jwt.verify(token, process.env.JWT_SECRET, { 
				algorithms: ['HS256']
			});
		} catch (error) {
			return res.status(401).json({
				status: 'error',
				message: 'Token tidak valid atau sudah kadaluarsa'
			});
		}

		if (!decoded.data || !decoded.data.username) {
			return res.status(401).json({
				status: 'error',
				message: 'Data token tidak valid'
			});
		}

		// Get user ID from username
		const pool = require('../../../config/db');
		const [users] = await pool.query(
			'SELECT ID FROM sysuser WHERE USERNAME = ? LIMIT 1',
			[decoded.data.username]
		);

		if (users.length === 0) {
			return res.status(404).json({
				status: 'error',
				message: 'User tidak ditemukan'
			});
		}

		const userId = users[0].ID;

		// Perform logout (invalidate session)
		const result = await logoutUser(userId, 'User logout - account switching');

		return res.status(200).json({
			status: 'success',
			message: result.message,
			data: {
				logged_out: true
			}
		});
	} catch (error) {
		const status = error.status || 500;
		const message = error.message || 'Terjadi kesalahan pada server';

		return res.status(status).json({
			status: 'error',
			message
		});
	}
});

module.exports = router;
