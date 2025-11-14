const {
	default: makeWASocket,
	useMultiFileAuthState,
	DisconnectReason,
	makeInMemoryStore,
	fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const P = require('pino');

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const sessions = {}; // in-memory session map keyed by sessionKey (userId::accountId or accountId)

function buildSessionKey(accountId, userId) {
	return userId ? `${userId}::${accountId}` : accountId;
}

function buildSessionPath(accountId, userId) {
	return userId ? path.join(SESSIONS_DIR, userId, accountId) : path.join(SESSIONS_DIR, accountId);
}

async function startSession(accountId, userId) {
	const sessionKey = buildSessionKey(accountId, userId);
	if (sessions[sessionKey]) return sessions[sessionKey];

	const sessionPath = buildSessionPath(accountId, userId);
	const storeFilePath = path.join(sessionPath, 'store.json');

	if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

	const sessionStore = makeInMemoryStore({});
	if (fs.existsSync(storeFilePath)) {
		try { sessionStore.readFromFile(storeFilePath); } catch (e) { console.warn('[STORE] read error', accountId, e.message); }
	}
	const persistInterval = setInterval(() => {
		try { sessionStore.writeToFile(storeFilePath); } catch { }
	}, 10_000);

	const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

	let versionInfo;
	try { versionInfo = await fetchLatestBaileysVersion(); } catch (e) { console.warn('[WA] version fetch failed', e.message); }

	const sock = makeWASocket({
		version: versionInfo?.version,
		auth: state,
		logger: P({ level: 'silent' }),
		printQRInTerminal: true,
		browser: ['Ubuntu', 'Chrome', '22.04'],
		store: sessionStore
	});

	sessionStore.bind(sock.ev);

	sessions[sessionKey] = {
		socket: sock,
		qr: null,
		connected: false,
		whatsapp_number: null,
		store: sessionStore,
		recentEvents: [],
		persistInterval,
		sessionPath,
		storeFilePath,
		accountId,
		userId: userId || null,
		sessionKey
	};

	sock.ev.on('connection.update', async update => {
		const ts = new Date().toISOString();
		const { connection, lastDisconnect, qr } = update;

		// Throttle repetitive QR-only logs: Baileys memancarkan event berkala dengan hanya field qr (connection undefined)
		try {
			const sess = sessions[sessionKey];
			if (sess) {
				if (!sess._logState) sess._logState = { lastConn: null, lastQrSig: null, lastLogTime: 0 };
				const st = sess._logState;
				let shouldLog = false;
				let logType = 'generic';
				// If connection field present & changed
				if (typeof connection !== 'undefined' && connection !== st.lastConn) {
					shouldLog = true; logType = 'connection-change'; st.lastConn = connection;
				}
				// If only QR arrives (connection undefined) we log only when QR actually changes (signature diff)
				if (!shouldLog && qr) {
					// Use a short signature of QR (panjang dataurl besar) -> ambil 32 char terakhir
					const sig = qr.slice(-32);
					if (sig !== st.lastQrSig) {
						shouldLog = true; logType = 'qr-new'; st.lastQrSig = sig;
					}
				}
				// Rate limit: minimal 1s antar log kecuali connection-change
				if (shouldLog && logType !== 'connection-change' && (Date.now() - st.lastLogTime) < 1000) {
					shouldLog = false; // terlalu cepat, skip
				}
				if (shouldLog && process.env.QUIET_QR_LOGS !== '1') {
					console.log(`[WA][${ts}][${sessionKey}] connection.update (${logType}) =>`, {
						connection,
						hasQR: !!qr,
						lastDisconnectReason: lastDisconnect?.error?.output?.statusCode || lastDisconnect?.reason,
					});
					st.lastLogTime = Date.now();
				}
			}
		} catch (e) { /* ignore logging errors */ }

		try {
			const evtSummary = {
				ts,
				connection,
				hasQR: !!qr,
				reason: lastDisconnect?.error?.output?.statusCode || lastDisconnect?.reason || null
			};
			const arr = sessions[sessionKey].recentEvents;
			arr.push(evtSummary);
			if (arr.length > 25) arr.shift();
		} catch { }

		if (qr) {
			try {
				sessions[sessionKey].qr = await qrcode.toDataURL(qr);
				sessions[sessionKey].connected = false;
			} catch (e) { console.error('[QR] generate error', accountId, e.message); }
		}
		if (connection === 'open') {
			const whatsappNumber = sock.user.id.split(':')[0];
			Object.assign(sessions[sessionKey], { connected: true, qr: null, whatsapp_number: whatsappNumber });
		}
		if (connection === 'close') {
			const discCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.reason;
			const shouldReconnect = discCode !== DisconnectReason.loggedOut;
			if (sessions[sessionKey]) {
				Object.assign(sessions[sessionKey], { connected: false, qr: null, whatsapp_number: null });
			}
			if (shouldReconnect && sessions[sessionKey]) {
				setTimeout(() => {
					if (sessions[sessionKey]) { // only if not manually removed
						delete sessions[sessionKey];
						startSession(accountId, userId);
					}
				}, 2000);
			}
		}
	});

	sock.ev.on('creds.update', saveCreds);

	return sessions[sessionKey];
}

function getSession(accountId, userId) { return sessions[buildSessionKey(accountId, userId)]; }
function getAllSessions() { return sessions; }

/**
 * Remove session from memory and optionally delete its folder.
 * Ensures interval cleared before folder deletion to avoid EPERM on Windows.
 * @param {string} accountId
 * @param {object} [opts]
 * @param {boolean} [opts.deleteFolder=false]
 * @returns {Promise<boolean>} success
 */
async function removeSession(accountId, opts = {}) {
	const { deleteFolder = false, userId = null } = opts;
	const sessionKey = buildSessionKey(accountId, userId);
	const sess = sessions[sessionKey];
	if (!sess) return false;
	if (sess.persistInterval) {
		try { clearInterval(sess.persistInterval); } catch { }
	}
	// Attempt graceful socket logout if still connected
	try {
		if (sess.socket?.ws?.readyState === 1) {
			try { await sess.socket.logout(); } catch { }
		}
		try { sess.socket.ev.removeAllListeners(); } catch { }
		try { if (sess.socket?.ws) sess.socket.ws.close(); } catch { }
		try { if (sess.socket?.end) sess.socket.end(); } catch { }
		try { if (sess.socket?.destroy) sess.socket.destroy(); } catch { }
	} catch { }

	const sessionPath = sess.sessionPath;
	delete sessions[sessionKey];

	if (deleteFolder && sessionPath) {
		await deleteFolderWithRetry(sessionPath);
	}
	return true;
}

async function deleteFolderWithRetry(folderPath, attempts = 3, delayMs = 300) {
	for (let i = 0; i < attempts; i++) {
		try {
			if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true });
			return true;
		} catch (e) {
			if (i === attempts - 1) {
				console.warn('[SESSION][DELETE] gagal hapus folder', folderPath, e.message);
				return false;
			}
			await new Promise(r => setTimeout(r, delayMs));
		}
	}
}

/**
 * Purge authentication credential JSON files so that session must re-login.
 * Keeps store.json by default (unless removeStore=true).
 */
async function purgeSessionCredentials(accountId, { removeStore = false, userId = null } = {}) {
	const sessionPath = buildSessionPath(accountId, userId);
	if (!fs.existsSync(sessionPath)) return { purged: 0, message: 'session folder missing' };
	let purged = 0;
	for (const f of fs.readdirSync(sessionPath)) {
		if (f === 'store.json' && !removeStore) continue;
		if (f.endsWith('.json')) {
			try { fs.rmSync(path.join(sessionPath, f), { force: true }); purged++; } catch { }
		}
	}
	return { purged, message: 'credential files removed', removeStore };
}

/**
 * Empty (bersihkan) seluruh isi folder session (file & subfolder) tanpa menghapus folder induknya.
 * Berguna untuk memastikan sesi benar-benar fresh (butuh QR baru) namun folder tetap ada agar dianggap "registered".
 */
function emptySessionFolder(accountId, userId = null) {
	const sessionPath = buildSessionPath(accountId, userId);
	if (!fs.existsSync(sessionPath)) return { removed: 0, message: 'folder not found' };
	let removed = 0;
	for (const entry of fs.readdirSync(sessionPath)) {
		try {
			fs.rmSync(path.join(sessionPath, entry), { recursive: true, force: true });
			removed++;
		} catch { }
	}
	return { removed, message: 'session folder emptied' };
}

module.exports = { startSession, getSession, getAllSessions, removeSession, purgeSessionCredentials, emptySessionFolder, SESSIONS_DIR, buildSessionKey, buildSessionPath };
