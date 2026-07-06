require('dotenv').config();
const express = require('express');
const cors = require('cors');

const v1Routes = require('./routes/v1');
const authRoutes = require('./routes/v1/auth');

const crypto = require('crypto');
global.crypto = crypto; // ensure crypto available for baileys environment

const { verifyToken } = require('./utils/token')

// Global IP-based rate limiter: max 60 requests/minute per IP (no extra deps)
const _ipHits = new Map();
const GLOBAL_RATE_LIMIT = parseInt(process.env.GLOBAL_RATE_LIMIT_PER_MINUTE) || 60;
function ipRateLimiter(req, res, next) {
	const ip = req.ip || req.connection.remoteAddress || 'unknown';
	const now = Date.now();
	const windowStart = now - 60000;
	const hits = (_ipHits.get(ip) || []).filter(t => t > windowStart);
	hits.push(now);
	_ipHits.set(ip, hits);
	if (hits.length > GLOBAL_RATE_LIMIT) {
		return res.status(429).json({ status: 'error', message: 'Too many requests. Please slow down.' });
	}
	next();
}

function createApp() {
	const app = express();
	app.use(cors());
	app.use(ipRateLimiter);

	app.use(express.json());
	app.use(express.urlencoded({ extended: true }));

	// Auth routes MUST be registered BEFORE the general /api/v1 route
	// This ensures auth endpoints bypass the verifyToken middleware
	app.use('/api/v1/auth', authRoutes);

	// API v1 routes (all other endpoints require authentication)
	app.use('/api/v1', verifyToken, v1Routes);

	// Start background scheduler (if enabled)
	try {
		const { startScheduler } = require('./services/schedulerService');
		startScheduler();
	} catch (e) {
		console.warn('Scheduler failed to start:', e.message);
	}
	return app;
}

module.exports = { createApp };
