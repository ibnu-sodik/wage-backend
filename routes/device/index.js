const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const { buildSessionPath, getSession } = require('../../services/sessionManager');

router.post('/register', async (req, res) => {
	const { account, userId } = req.body;

	if (!account) {
		return res.status(400).json({
			status: 'error', message: 'account ID is required'
		})
	}

	if (!userId) {
		return res.status(400).json({
			status: 'error', message: 'user ID is required'
		})
	}

	const sessionPath = buildSessionPath(account, userId);

	try {
		try {
			const stats = await fs.stat(sessionPath);

			if (stats.isDirectory()) {
				return res.json({
					account,
					status: 'exists',
					message: 'Device already registered',
				});
			}
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}

		await fs.mkdir(sessionPath, { recursive: true });

		return res.json({
			account,
			status: 'registered',
			message: 'Device folder created',
		});
	} catch (error) {
		console.error('Error creating device folder:', error);
		return res.status(500).json({
			status: 'error',
			message: 'Failed to create device folder',
			error: error.message
		});
	}
});

router.get('/check-status', async (req, res) => {
	const account = req.query.account;
	const userId = req.query.userId;

	if (!account) {
		return res.status(400).json({
			status: 'error', message: 'account ID is required'
		})
	}

	if (!userId) {
		return res.status(400).json({
			status: 'error', message: 'user ID is required'
		})
	}

	const sessionPath = buildSessionPath(account, userId);

	try {
		const stats = await fs.stat(sessionPath);
		if (!stats.isDirectory()) {
			return res.status(404).json({
				account,
				status: 'not_registered',
				message: 'Device not registered',
			});
		}

		const session = getSession(account, userId);
		if (!session) {
			return res.json({
				account,
				status: 'not_connected',
				whatsapp_number: ''
			});
		}

		return res.json({
			account,
			status: session.connected ? 'connected' : 'not_connected',
			whatsapp_number: session.whatsapp_number || ''
		});
	} catch (error) {
		if (error.code === 'ENOENT') {
			return res.status(404).json({
				account,
				status: 'not_registered',
				message: 'Device not registered'
			});
		}

		console.error('Error checking device status:', error);
		return res.status(500).json({ status: 'error', message: 'Internal server error' });
	}

});

module.exports = router;
