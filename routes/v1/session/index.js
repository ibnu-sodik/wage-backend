const express = require('express');
const router = express.Router();
const fs = require('fs');
const { getSession, removeSession, purgeSessionCredentials, emptySessionFolder, buildSessionPath } = require('../../../services/sessionManager');

// Logout
router.post('/logout', async (req, res) => {
	const { account, userId, fullRemove } = req.body;

	if (!account) return res.status(400).json({ status: 'error', message: 'account ID is required' });
	if (!userId) return res.status(400).json({ status: 'error', message: 'user ID is required' });


	const doDeleteFolder =
		fullRemove === true ||
		fullRemove === 'true' ||
		fullRemove === 1 ||
		fullRemove === '1';

	const sessionPath = buildSessionPath(account, userId);
	const session = getSession(account, userId);
	const folderExists = fs.existsSync(sessionPath);

	if (!session && !folderExists) {
		return res.json({
			status: 'already_logged_out',
			account,
			folderRemoved: false,
			emptied: null,
			message: 'Session and folder already removed previously'
		});
	}

	let folderRemoved = false;
	let emptied = null;

	try {
		// NOTE: 1. Kalau ada session aktif → logout dulu
		if (session) {
			await removeSession(account, { deleteFolder: doDeleteFolder, userId });

			if (doDeleteFolder) {
				// removeSession sudah menghapus folder (kalau sess.sessionPath dipakai)
				folderRemoved = true;
			}
		} else {
			// Tidak ada session di memory
			if (doDeleteFolder && folderExists) {
				// Hapus folder langsung kalau diminta fullRemove
				fs.rmSync(sessionPath, { recursive: true, force: true });
				folderRemoved = true;
			}
		}

		// NOTE: 2. Kalau TIDAK fullRemove → kosongkan isi folder saja
		// NOTE: baik ada session atau tidak, selama foldernya ada.
		if (!doDeleteFolder) {
			emptied = emptySessionFolder(account, userId);
			// pastikan fungsi ini menghapus isi folder
		}

	} catch (e) {
		console.error('[ERROR] Logout failure', account, e);
		return res.status(500).json({
			status: 'error',
			message: e.message || 'Failed during logout',
			account
		});
	}

	return res.json({
		status: 'logged_out',
		account,
		folderRemoved,
		emptied,
		message: doDeleteFolder
			? (folderRemoved
				? 'Session logged out and folder deleted'
				: 'Session logged out, but folder was already missing')
			: (emptied?.message || 'Session logged out and folder contents cleared')
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