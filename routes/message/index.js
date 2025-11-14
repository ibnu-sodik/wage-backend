const express = require('express');
const router = express.Router();
const { startSession } = require('../../services/sessionManager');

router.post('/send', async (req, res) => {
	const { account, receiver, message, userId } = req.body;

	if (!account) return res.status(400).json({ status: 'error', message: 'account ID is required' });
	if (!receiver) return res.status(400).json({ status: 'error', message: 'receiver number is required' });
	if (!userId) return res.status(400).json({ status: 'error', message: 'user ID is required' });

	const session = await startSession(account, userId);

	if (!session || !session.socket) {
		return res.status(500).json({ status: 'error', message: 'Failed to start session' });
	}

	if (!session.connected) {
		return res.status(400).json({ status: 'error', message: 'Device not connected' });
	}

	const normalizedReceiver = normalizeNumber(receiver);

	try {
		await session.socket.sendMessage(
			`${normalizedReceiver}@s.whatsapp.net`,
			{ text: message }
		);

		return res.status(200).json({
			status: 'success',
			message: 'Message sent',
			receiver: normalizedReceiver
		});

	} catch (error) {
		return res.status(500).json({
			status: 'error',
			message: error.message || 'Unknown error',
			detail: error?.data || error?.reason || null
		});
	}

});

function normalizeNumber(num) {
	return num.replace(/\D/g, '').replace(/^0/, '62');
}

module.exports = router;
