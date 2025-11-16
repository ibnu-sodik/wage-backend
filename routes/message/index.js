const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { startSession } = require('../../services/sessionManager');
const { sendTemplatedMessage } = require('../../services/messageService');

router.post('/send', async (req, res) => {
	const { account, receiver, message, userId } = req.body;

	if (!account) return res.status(400).json({ status: 'error', message: 'account ID is required' });
	if (!receiver) return res.status(400).json({ status: 'error', message: 'receiver number is required' });
	if (!userId) return res.status(400).json({ status: 'error', message: 'user ID is required' });

	const normalizedReceiver = normalizeNumber(receiver);

	try {
		const session = await startSession(account, userId);

		if (!session || !session.socket) {
			return res.status(500).json({ status: 'error', message: 'Failed to start session' });
		}

		if (!session.connected) {
			return res.status(400).json({ status: 'error', message: 'Device not connected' });
		}

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

router.post('/send-broadcast', async (req, res) => {
	const { broadcast_id, nokey, account, receiver, template_id, user_id } = req.body

	if (!broadcast_id) return res.status(400).json({ status: 'error', message: 'broadcast ID is required' });
	if (!nokey) return res.status(400).json({ status: 'error', message: 'nokey is required' })
	if (!account) return res.status(400).json({ status: 'error', message: 'account ID is required' });
	if (!receiver) return res.status(400).json({ status: 'error', message: 'receiver number is required' });
	if (!template_id) return res.status(400).json({ status: 'error', message: 'template ID is required' });
	if (!user_id) return res.status(400).json({ status: 'error', message: 'user ID is required' });

	try {
		const session = await startSession(account, user_id);

		if (!session || !session.socket) {
			return res.status(500).json({ status: 'error', message: 'Failed to start session' });
		}

		if (!session.connected) {
			return res.status(400).json({ status: 'error', message: 'Device not connected' });
		}

		const [templateRows] = await db.query(
			'SELECT TEMP_TYPE, TEMP_FILE, TEMP_MESSAGE, TEMP_BUTTONS FROM TEMPTBL WHERE ID = ? AND USER_ID = ?',
			[template_id, user_id]
		);
		if (!templateRows.length) {
			return res.status(404).json({
				status: 'failed',
				message: 'Template not found',
				broadcast_id,
				template_id,
				receiver
			});
		}

		const [receiverRows] = await db.query(
			'SELECT CONTACT_NAME, CONTACT_NUMBER, DEVICE_NAME FROM BCDT WHERE ID = ? AND NOKEY = ? AND USER_ID = ?',
			[broadcast_id, nokey, user_id]
		);
		if (!receiverRows.length) {
			return res.status(404).json({ status: 'failed', message: 'Receiver data not found', broadcast_id, template_id, receiver });
		}

		const [senderRows] = await db.query(
			"SELECT CONCAT(FIRST_NAME,' ', LAST_NAME) AS FULLNAME, EMAIL FROM SYSUSER WHERE ID = ?",
			[user_id]
		);
		if (!senderRows.length) {
			return res.status(404).json({ status: 'failed', message: 'Sender data not found', broadcast_id, template_id, receiver });
		}

		const broadcast = await sendTemplatedMessage({
			session,
			templateRow: templateRows[0],
			receiverRow: receiverRows[0],
			senderRow: senderRows[0],
			receiver,
			templateType: templateRows[0].TEMP_TYPE
		});
		return res.json({
			status: 'sent',
			messageId: broadcast.key.id,
			broadcast_id,
			template_id,
			receiver
		})
	} catch (error) {
		console.error('Error send-broadcast:', error);
		return res.status(500).json({
			status: 'failed',
			message: error.message || 'Failed to send message',
			broadcast_id,
			template_id,
			receiver
		});
	}
});

function normalizeNumber(num) {
	return num.replace(/\D/g, '').replace(/^0/, '62');
}

module.exports = router;
