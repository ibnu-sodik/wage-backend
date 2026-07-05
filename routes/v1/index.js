const express = require('express');
const router = express.Router();

// Mount core routes (session, logout, contacts, etc.)
const coreRoutes = require('../core');
router.use('/', coreRoutes);

// Mount device routes
const deviceRoutes = require('./device');
router.use('/device', deviceRoutes);

// Mount message routes
const messageRoutes = require('./message');
router.use('/message', messageRoutes);

// Health endpoint for v1
router.get('/health', (req, res) => {
	res.json({
		status: 'ok',
		version: 'v1',
		timezone: process.env.TZ,
		utcTime: new Date().toISOString(),
		realTime: new Date().toLocaleString('id-ID', { timeZone: process.env.TZ })
	});
});

module.exports = router;