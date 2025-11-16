const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../config/db');
const { startSession, getSession, removeSession, purgeSessionCredentials, emptySessionFolder, SESSIONS_DIR, buildSessionPath } = require('../services/sessionManager');
const { sendTemplatedMessage } = require('../services/messageService');
const { applyPlaceholders } = require('../utils/template');

// Generate QR New
router.get("/generate-qr", async (req, res) => {
	const accountId = req.query.account || "default";
	const userId = req.query.userId || null;

	const sessionPath = buildSessionPath(accountId, userId);

	// Pastikan device sudah pernah didaftarkan
	if (!fs.existsSync(sessionPath)) {
		return res.status(404).json({
			status: "device_not_registered",
			message: "Folder session tidak ditemukan. Harus register device terlebih dahulu.",
			account: accountId
		});
	}

	// Ambil atau buat session
	let session = getSession(accountId, userId) || await startSession(accountId, userId);

	/** Sudah connect */
	if (session.connected) {
		return res.json({
			status: "connected",
			account: accountId,
			whatsapp_number: session.whatsapp_number
		});
	}

	/** Jika QR sudah tersedia, kirim langsung */
	if (session.qr) {
		return res.json({
			status: "need_qr",
			account: accountId,
			qr: session.qr
		});
	}

	/**
	 * Tunggu QR muncul → up to 30s
	 * Tidak agresif, 500ms interval
	 */
	const waitUntil = Date.now() + 30_000;

	while (Date.now() < waitUntil) {
		session = getSession(accountId, userId);

		if (!session) break; // Session hilang? exit

		if (session.connected) {
			return res.json({
				status: "connected",
				account: accountId,
				whatsapp_number: session.whatsapp_number
			});
		}

		if (session.qr) {
			return res.json({
				status: "need_qr",
				account: accountId,
				qr: session.qr
			});
		}

		await new Promise(r => setTimeout(r, 500));
	}

	return res.json({
		status: "waiting",
		message: "QR belum tersedia. Coba ulangi request.",
		account: accountId
	});
});

// Batch broadcast simple (plain text template only)
router.post('/broadcast-message', async (req, res) => {
	const broadcasts = req.body.broadcasts;
	if (!Array.isArray(broadcasts) || !broadcasts.length) return res.status(400).json({ status: 'error', message: 'No data to broadcast' });
	const results = [];
	for (const item of broadcasts) {
		const { sender, receiver, template, userid } = item;
		const session = await startSession(sender, userid);
		if (!session.connected) { results.push({ receiver, status: 'failed', message: 'Sender not connected' }); continue; }
		try {
			const [rows] = await db.query('SELECT TEMP_MESSAGE FROM TEMPTBL WHERE ID = ?', [template]);
			if (!rows.length) { results.push({ receiver, status: 'failed', message: 'Template not found' }); continue; }
			await session.socket.sendMessage(`${receiver}@s.whatsapp.net`, { text: rows[0].TEMP_MESSAGE });
			results.push({ receiver, status: 'success', message: 'Sent' });
		} catch (err) { results.push({ receiver, status: 'failed', message: err.message }); }
	}
	res.json({ status: 'completed', results });
});

// Batch bulk message
router.post('/send-bulk-message', async (req, res) => {
	const { sender, receiver, message, userid } = req.body;
	const session = await startSession(sender, userid);
	if (!session.connected) return res.status(400).json({ status: 'error', message: 'Device not connected' });
	try {
		const sentMsg = await session.socket.sendMessage(`${receiver}@s.whatsapp.net`, { text: message });
		return res.json({ receiver, status: 'sent', messageId: sentMsg.key.id });
	} catch (e) {
		return res.status(500).json({ receiver, status: 'failed', message: e.message });
	}
});

// Contacts
router.get('/get-contacts', async (req, res) => {
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

// Session debug
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

// Logout
router.post('/logout', async (req, res) => {
	const { account, full, deleteFolder, userId } = req.body;
	if (!account) return res.status(400).json({ status: 'error', message: 'Account ID required' });
	const sessionPath = buildSessionPath(account, userId);
	const folderExists = fs.existsSync(sessionPath);
	if (!folderExists) return res.status(404).json({ status: 'error', message: 'Device folder not found (already unregistered)', account });

	const doDeleteFolder = full === true || deleteFolder === true; // explicit full removal
	const session = getSession(account, userId);
	let emptied = null;
	try {
		if (session) {
			await removeSession(account, { deleteFolder: doDeleteFolder, userId });
		} else if (doDeleteFolder) {
			// no active session but full deletion requested
			try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (e) { return res.status(500).json({ status: 'error', message: 'Failed to remove folder', account }); }
		}
		if (!doDeleteFolder) {
			// Hanya kosongkan isi folder (hapus semua file & subfolder) sesuai permintaan user
			emptied = emptySessionFolder(account, userId);
		}
	} catch (e) {
		console.error('[ERROR] Logout failure', account, e);
		return res.status(500).json({ status: 'error', message: e.message || 'Failed during logout', account });
	}

	return res.json({
		status: 'logged_out',
		account,
		folderRemoved: !!doDeleteFolder,
		emptied: !doDeleteFolder ? emptied : null,
		message: doDeleteFolder ? 'Session & folder deleted' : 'Session logged out and folder contents cleared'
	});
});

// Purge session credentials explicitly (without logging out active session)
router.post('/purge-session', async (req, res) => {
	const { account, removeStore, userId } = req.body;
	if (!account) return res.status(400).json({ status: 'error', message: 'Account ID required' });
	const session = getSession(account, userId);
	if (session && session.connected) return res.status(400).json({ status: 'error', message: 'Disconnect / logout first before purging', account });
	try {
		const result = await purgeSessionCredentials(account, { removeStore: !!removeStore, userId });
		return res.json({ status: 'purged', account, ...result });
	} catch (e) {
		return res.status(500).json({ status: 'error', message: e.message || 'Failed to purge credentials', account });
	}
});

module.exports = router;
