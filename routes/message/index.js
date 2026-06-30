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

		const send = await session.socket.sendMessage(
			`${normalizedReceiver}@s.whatsapp.net`,
			{ text: message }
		);

	await db.query(
		'UPDATE user_subscription_usage SET MESSAGE_PER_DAY = CASE WHEN LAST_MESSAGE_DATE IS NULL OR LAST_MESSAGE_DATE = CURDATE() THEN MESSAGE_PER_DAY + 1 ELSE 1 END, LAST_MESSAGE_DATE = CURDATE() WHERE USER_ID = ?',
		[userId]
	);

		return res.status(200).json({
			status: 'success',
			message: 'Message sent',
			receiver: normalizedReceiver,
			messageId: send.key.id,
			delivery_at: send.messageTimestamp.low,
		});

	} catch (e) {
		return res.status(500).json({
			status: 'error',
			message: e.message || 'Unknown error',
			detail: e?.data || e?.reason || null
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
			'SELECT TEMP_TYPE, TEMP_FILE, TEMP_MESSAGE, TEMP_BUTTONS FROM temptbl WHERE ID = ? AND USER_ID = ?',
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
			'SELECT CONTACT_NAME, CONTACT_NUMBER, DEVICE_NAME FROM bcdt WHERE ID = ? AND NOKEY = ? AND USER_ID = ?',
			[broadcast_id, nokey, user_id]
		);
		if (!receiverRows.length) {
			return res.status(404).json({ status: 'failed', message: 'Receiver data not found', broadcast_id, template_id, receiver });
		}

		const [senderRows] = await db.query(
			"SELECT CONCAT(FIRST_NAME,' ', LAST_NAME) AS FULLNAME, EMAIL FROM sysuser WHERE ID = ?",
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

	await db.query(
		'UPDATE user_subscription_usage SET MESSAGE_PER_DAY = CASE WHEN LAST_MESSAGE_DATE IS NULL OR LAST_MESSAGE_DATE = CURDATE() THEN MESSAGE_PER_DAY + 1 ELSE 1 END, LAST_MESSAGE_DATE = CURDATE() WHERE USER_ID = ?',
		[user_id]
	);

		return res.json({
			status: 'sent',
			messageId: broadcast.key.id,
			delivery_at: broadcast.messageTimestamp.low,
			broadcast_id,
			template_id,
			receiver
		})
	} catch (e) {
		console.error('Error send-broadcast:', e);
		return res.status(500).json({
			status: 'failed',
			message: e.message || 'Failed to send message',
			broadcast_id,
			template_id,
			receiver
		});
	}
});

router.post('/send-bulk', async (req, res) => {
	const { account, receiver, message, user_id } = req.body;

	if (!account) return res.status(400).json({ status: 'error', message: 'account ID is required' });
	if (!receiver) return res.status(400).json({ status: 'error', message: 'receiver number is required' });
	if (!message) return res.status(400).json({ status: 'error', message: 'message is required' });
	if (!user_id) return res.status(400).json({ status: 'error', message: 'user ID is required' });

	const normalizedReceiver = normalizeNumber(receiver);

	try {
		const session = await startSession(account, user_id);

		if (!session || !session.socket) {
			return res.status(500).json({ status: 'error', message: 'Failed to start session' });
		}

		if (!session.connected) {
			return res.status(400).json({ status: 'error', message: 'Device not connected' });
		}

		const bulk = await session.socket.sendMessage(
			`${normalizedReceiver}@s.whatsapp.net`,
			{ text: message }
		);

	await db.query(
		'UPDATE user_subscription_usage SET MESSAGE_PER_DAY = CASE WHEN LAST_MESSAGE_DATE IS NULL OR LAST_MESSAGE_DATE = CURDATE() THEN MESSAGE_PER_DAY + 1 ELSE 1 END, LAST_MESSAGE_DATE = CURDATE() WHERE USER_ID = ?',
		[user_id]
	);

		return res.json({
			status: 'sent',
			messageId: bulk.key.id,
			delivery_at: bulk.messageTimestamp.low,
			account,
			receiver
		});

	} catch (e) {
		console.error('Error send-bulk:', e);
		return res.status(500).json({
			status: 'failed',
			message: e.message || 'Failed to send message',
			account,
			receiver
		});
	}
})

function normalizeNumber(num) {
	const clean = num.replace(/\D/g, '');
	if (clean.startsWith('62')) return clean;
	if (clean.startsWith('0')) return '62' + clean.slice(1);
	return '62' + clean;
}

module.exports = router;
