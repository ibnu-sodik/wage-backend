const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const { buildSessionPath, getSession, startPairingSession, getPairingSession } = require('../../../services/sessionManager');

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

// Batch status check for multiple devices
router.post('/batch-status', async (req, res) => {
	const { accounts, userId } = req.body;

	if (!Array.isArray(accounts) || accounts.length === 0) {
		return res.status(400).json({
			status: 'error',
			message: 'accounts array is required and must not be empty'
		});
	}

	if (!userId) {
		return res.status(400).json({
			status: 'error',
			message: 'userId is required'
		});
	}

	const results = {};

	for (const accountId of accounts) {
		const sessionPath = buildSessionPath(accountId, userId);

		try {
			const stats = await fs.stat(sessionPath);
			if (!stats.isDirectory()) {
				results[accountId] = {
					status: 'not_registered',
					whatsapp_number: ''
				};
				continue;
			}

			const session = getSession(accountId, userId);
			if (!session) {
				results[accountId] = {
					status: 'not_connected',
					whatsapp_number: ''
				};
			} else {
				results[accountId] = {
					status: session.connected ? 'connected' : 'not_connected',
					whatsapp_number: session.whatsapp_number || ''
				};
			}
		} catch (error) {
			if (error.code === 'ENOENT') {
				results[accountId] = {
					status: 'not_registered',
					whatsapp_number: ''
				};
			} else {
				console.error(`Error checking status for account ${accountId}:`, error);
				results[accountId] = {
					status: 'error',
					whatsapp_number: ''
				};
			}
		}
	}

	return res.json(results);
});

// Pairing code: initiate without QR scan
router.post('/request-pairing-code', async (req, res) => {
	const { account, userId, phoneNumber } = req.body;

	if (!account) {
		return res.status(400).json({
			status: 'error', message: 'account ID is required'
		});
	}

	if (!userId) {
		return res.status(400).json({
			status: 'error', message: 'user ID is required'
		});
	}

	if (!phoneNumber) {
		return res.status(400).json({
			status: 'error', message: 'phoneNumber is required (e.g. 6281234567890)'
		});
	}

	// Validate phone format
	const cleanPhone = phoneNumber.replace(/\D/g, '');
	if (!cleanPhone.startsWith('62') || cleanPhone.length < 10) {
		return res.status(400).json({
			status: 'error',
			message: 'Invalid phone number. Must start with 62 (Indonesia) and be at least 10 digits'
		});
	}

	try {
		const result = await startPairingSession(account, userId, cleanPhone);
		return res.json({
			status: result.status,
			account,
			pairingCode: result.code || null,
			message: result.status === 'pairing_code_sent'
				? 'Pairing code generated. Open WhatsApp → Linked Devices → Link with phone number and enter the code.'
				: result.status === 'already_connected'
					? 'Device already connected via WhatsApp'
					: result.status === 'pending'
						? 'Pairing already in progress, code is still valid'
						: 'Unexpected status'
		});
	} catch (error) {
		console.error('Error requesting pairing code:', error);
		return res.status(500).json({
			status: 'error',
			message: error.message || 'Failed to request pairing code',
			account
		});
	}
});

// Check status of a pending pairing code session
router.get('/pairing-code-status', async (req, res) => {
	const account = req.query.account;
	const userId = req.query.userId;

	if (!account) {
		return res.status(400).json({ status: 'error', message: 'account ID is required' });
	}
	if (!userId) {
		return res.status(400).json({ status: 'error', message: 'user ID is required' });
	}

	const session = getSession(account, userId);
	const pairing = getPairingSession(account, userId);

	if (session?.connected) {
		return res.json({
			status: 'connected',
			account,
			whatsapp_number: session.whatsapp_number || ''
		});
	}

	if (pairing?.code) {
		return res.json({
			status: 'pairing_pending',
			account,
			pairingCode: pairing.code,
			message: 'Waiting for user to enter pairing code in WhatsApp'
		});
	}

	return res.json({
		status: 'not_found',
		account,
		message: 'No active pairing session found. Request a new pairing code.'
	});
});

module.exports = router;
