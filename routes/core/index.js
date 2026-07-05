const express = require('express');
const router = express.Router();
const fs = require('fs');
const { getSession, buildSessionPath } = require('../../services/sessionManager');

// Session debug (utility / diagnostic only)
router.get('/session-debug', (req, res) => {
	const accountId = req.query.account;
	const userId = req.query.userId || null;
	if (!accountId) return res.status(400).json({ status: 'error', message: 'account parameter required' });
	if (!userId) return res.status(400).json({ status: 'error', message: 'userId parameter required' });
	const session = getSession(accountId, userId);
	const sessionPath = buildSessionPath(accountId, userId);
	const exists = fs.existsSync(sessionPath);
	const authFiles = exists ? fs.readdirSync(sessionPath).filter(f => f.endsWith('.json')).length : 0;
	if (!session) return res.json({ account: accountId, registered: exists, active: false, authFiles, message: 'No active session in memory' });
	res.json({ account: accountId, registered: exists, active: true, connected: session.connected, hasQR: !!session.qr, whatsapp_number: session.whatsapp_number, authFiles, recentEvents: session.recentEvents || [] });
});

module.exports = router;