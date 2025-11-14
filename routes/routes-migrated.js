

// Register device
router.post('/register-device', (req, res) => {
	const { account, userId } = req.body;
	if (!account) return res.status(400).json({ status: 'error', message: 'account ID required' });
	const sessionPath = buildSessionPath(account, userId);
	if (fs.existsSync(sessionPath)) return res.json({ status: 'exists', message: 'Device already registered', account, userId });
	fs.mkdirSync(sessionPath, { recursive: true });
	res.json({ status: 'registered', message: 'Device folder created', account, userId });
});

// Status device
router.get('/status-device', async (req, res) => {
	const accountId = req.query.account || 'default';
	const userId = req.query.userId || null;
	const sessionPath = buildSessionPath(accountId, userId);
	if (!fs.existsSync(sessionPath)) return res.status(404).json({ status: 'not_registered', message: 'Device not registered', account: accountId });
	const session = getSession(accountId, userId);
	if (!session) {
		// Folder ada tapi belum / sudah logout: jangan auto start supaya tidak langsung buka koneksi WA lagi.
		return res.json({ account: accountId, status: 'not_connected', whatsapp_number: '' });
	}
	return res.json({ account: accountId, status: session.connected ? 'connected' : 'not_connected', whatsapp_number: session.whatsapp_number || '' });
});

// Send simple message
router.post('/send-message', async (req, res) => {
	const { account, to, message, userId } = req.body;
	const session = await startSession(account, userId);
	if (!session.connected) return res.status(400).json({ status: 'error', message: 'Device not connected' });
	try { await session.socket.sendMessage(`${to}@s.whatsapp.net`, { text: message }); return res.json({ status: 'sent' }); }
	catch (e) { return res.status(500).json({ status: 'error', message: e.message }); }
});
