require('dotenv').config();
const express = require('express');
const cors = require('cors');

const routes = require('./routes');
const routeDevice = require('./routes/device');
const routeMessage = require('./routes/message');

const crypto = require('crypto');
global.crypto = crypto; // ensure crypto available for baileys environment

const { verifyToken } = require('./utils/token')

function createApp() {
	const app = express();
	app.use(cors());

	app.use(express.json());
	app.use(express.urlencoded({ extended: true }));

	// Mount routes at root (backwards compatibility) and /api (preferred public path)
	app.use('/', routes);
	app.use('/api', routes);

	app.use('/device', verifyToken, routeDevice);
	app.use('/api/device', verifyToken, routeDevice);

	app.use('/message', verifyToken, routeMessage);
	app.use('/api/message', verifyToken, routeMessage);

	// Lightweight health endpoint (works at /health and /api/health)
	app.get(['/health', '/api/health'], (req, res) => {
		res.json({
			status: 'ok',
			timezone: process.env.TZ,
			utcTime: new Date().toISOString(),
			realTime: new Date().toLocaleString('id-ID', { timeZone: process.env.TZ })
		});
	});
	return app;
}

module.exports = { createApp };
