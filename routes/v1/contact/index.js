const express = require('express');
const router = express.Router();
const { getSession } = require('../../../services/sessionManager');

// Get contacts from device session
router.get('/', async (req, res) => {
	const accountId = req.query.account;
	const userId = req.query.userId || null;
	const session = getSession(accountId, userId);
	if (!accountId || !session) return res.status(400).json({ status: false, message: 'Session tidak ditemukan atau belum terkoneksi' });
	try {
		const contacts = Object.values(session.store.contacts)
			.filter(c => c.id && !c.id.includes('broadcast'))
			.map(c => ({ waId: c.id, name: c.name || c.notify || 'Tanpa Nama' }));
		res.json({ status: true, total: contacts.length, contacts });
	} catch (e) { res.status(500).json({ status: false, message: 'Gagal mengambil kontak', error: e.toString() }); }
});

module.exports = router;