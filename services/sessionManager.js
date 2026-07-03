const {
	default: makeWASocket,
	useMultiFileAuthState,
	DisconnectReason,
	fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode");
const P = require("pino");

const sessionPromises = {};

const SESSIONS_DIR = path.join(__dirname, "..", "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const sessions = {};

// Store pairing code sessions (phone → pairing code string)
const pairingSessions = {};

// Random browser fingerprints to avoid detection
const BROWSER_FINGERPRINTS = [
	["Chrome (Windows)", "Chrome", "120.0.6099.217"],
	["Chrome (Mac)", "Chrome", "120.0.6099.217"],
	["Firefox (Windows)", "Firefox", "121.0"],
	["Firefox (Mac)", "Firefox", "121.0"],
	["Safari (Mac)", "Safari", "17.2"],
	["Edge (Windows)", "Edge", "120.0.2210.91"]
];

function getRandomBrowser() {
	return BROWSER_FINGERPRINTS[Math.floor(Math.random() * BROWSER_FINGERPRINTS.length)];
}

const RECONNECT_BASE_DELAY = parseInt(process.env.WA_RECONNECT_BASE_DELAY) || 30000;
const MAX_RECONNECT_RETRIES = parseInt(process.env.WA_MAX_RETRIES) || 5;

function buildSessionKey(accountId, userId) {
	return userId ? `${userId}::${accountId}` : accountId;
}

function buildSessionPath(accountId, userId) {
	return userId ? path.join(SESSIONS_DIR, userId, accountId) : path.join(SESSIONS_DIR, accountId);
}

function debounce(fn, delay) {
	let timeout;
	return (...args) => {
		clearTimeout(timeout);
		timeout = setTimeout(() => fn(...args), delay);
	};
}

async function startSession(accountId, userId, retryCount = 0) {
	const sessionKey = buildSessionKey(accountId, userId);

	if (sessions[sessionKey]?.socket) return sessions[sessionKey];

	if (sessionPromises[sessionKey]) {
		return sessionPromises[sessionKey];
	}

	sessionPromises[sessionKey] = (async () => {
		const sessionPath = buildSessionPath(accountId, userId);
		if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

		const { state: authState, saveCreds } = await useMultiFileAuthState(sessionPath);
		const debouncedSave = debounce(saveCreds, 500);

		let versionInfo = await fetchLatestBaileysVersion().catch(() => null);

		const sock = makeWASocket({
			auth: authState,
			logger: P({ level: "silent" }),
			printQRInTerminal: false,
			browser: getRandomBrowser(),
			version: versionInfo?.version
		});

		sessions[sessionKey] = {
			socket: sock,
			connected: false,
			qr: null,
			lastQr: null,
			whatsapp_number: null,
			sessionPath,
			accountId,
			userId,
			sessionKey,
			retryCount
		};

		sock.ev.on("creds.update", debouncedSave);

		sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
			if (qr && !sessions[sessionKey].connected) {
				if (sessions[sessionKey].lastQr !== qr) {
					sessions[sessionKey].qr = await qrcode.toDataURL(qr);
					sessions[sessionKey].lastQr = qr;
				}
			}

			if (connection === "open") {
				const number = sock.user.id.split(":")[0];
				Object.assign(sessions[sessionKey], {
					connected: true,
					qr: null,
					whatsapp_number: number
				});
				console.log(`[WA][${sessionKey}] Connected as ${number}`);
			}

			if (connection === "close") {
				const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.reason;
				console.log(`[WA][${sessionKey}] Connection closed: ${code}`);
				// Mark disconnected immediately so in-flight send requests get 'not connected'
				if (sessions[sessionKey]) sessions[sessionKey].connected = false;

				// Treat explicit 401 (HTTP unauthorized) the same as logged out
				if (code === DisconnectReason.loggedOut || code === 401) {
					console.log(`[WA][${sessionKey}] Logged out. Removing credential JSON files and requiring QR scan.`);
					try {
						// NOTE: purgeSessionCredentials removes .json credential files in the session folder
						// NOTE: by default it preserves `store.json` unless removeStore = true
						await purgeSessionCredentials(accountId, { removeStore: false, userId });
						console.log(`[WA][${sessionKey}] Credential JSON files removed from ${sessionPath}`);
					} catch (e) {
						console.log(`[WA][${sessionKey}] Failed to purge credentials: ${e && e.message ? e.message : e}`);
					}

					delete sessions[sessionKey];
					return;
				}

				const shouldReconnect = [
					DisconnectReason.restartRequired,
					DisconnectReason.timedOut,
					DisconnectReason.connectionLost,
					408,
					503
				].includes(code);

			if (shouldReconnect) {
				const retryCount = (sessions[sessionKey] && sessions[sessionKey].retryCount) || 0;
				if (retryCount >= MAX_RECONNECT_RETRIES) {
					console.log(`[WA][${sessionKey}] Max reconnect retries (${MAX_RECONNECT_RETRIES}) reached. Logging out.`);
					try {
						await purgeSessionCredentials(accountId, { removeStore: false, userId });
					} catch (e) {}
					delete sessions[sessionKey];
					return;
				}
				const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, retryCount), 600000);
				console.log(`[WA][${sessionKey}] Reconnecting in ${delay}ms (attempt ${retryCount + 1}/${MAX_RECONNECT_RETRIES})...`);
				delete sessions[sessionKey];
				startSession(accountId, userId, retryCount + 1);
			}
			}
		});

		// ANCHOR: Log incoming message upserts (concise summary) to help diagnose decryption errors
		sock.ev.on('messages.upsert', (m) => {
			try {
				const msgs = m.messages || [];
				for (const msg of msgs) {
					const remote = msg.key && msg.key.remoteJid ? msg.key.remoteJid : '<unknown>';
					const id = msg.key && msg.key.id ? msg.key.id : '<no-id>';
					const t = msg.messageTimestamp || (msg.message && msg.message.timestamp) || Date.now();
					console.log(`[WA][MSG] upsert — session=${sessionKey} remote=${remote} id=${id} ts=${new Date(t * 1000).toISOString()}`);
				}
			} catch (e) {
				// NOTE: Don't let logging break session flow
			}
		});

		return sessions[sessionKey];
	})();

	try {
		const session = await sessionPromises[sessionKey];
		return session;
	} finally {
		delete sessionPromises[sessionKey];
	}
}

function getSession(accountId, userId) {
	return sessions[buildSessionKey(accountId, userId)];
}

function getAllSessions() {
	return sessions;
}

async function removeSession(accountId, { userId = null, deleteFolder = false } = {}) {
	const sessionKey = buildSessionKey(accountId, userId);
	const sess = sessions[sessionKey];

	if (!sess) {
		if (deleteFolder) {
			const sessionPath = buildSessionPath(accountId, userId);
			if (fs.existsSync(sessionPath)) {
				fs.rmSync(sessionPath, { recursive: true, force: true });
			}
		}
		return false;
	}

	try {
		if (typeof sess.socket.logout === 'function') {
			await sess.socket.logout().catch(() => { });
		}
	} catch (e) { }

	try {
		if (typeof sess.socket.end === 'function') {
			await sess.socket.end().catch(() => { });
		}
	} catch (e) { }

	try {
		if (sess.socket.ws && typeof sess.socket.ws.close === 'function') {
			sess.socket.ws.close();
		}
	} catch (e) { }

	delete sessions[sessionKey];

	if (deleteFolder) {
		const sessionPath = sess.sessionPath || buildSessionPath(accountId, userId);
		if (sessionPath && fs.existsSync(sessionPath)) {
			fs.rmSync(sessionPath, { recursive: true, force: true });
		}
	}

	return true;
}

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

/**
 * Start a session using pairing code (no QR scan needed).
 * Phone number must be in international format without '+' (e.g. "6281234567890")
 */
async function startPairingSession(accountId, userId, phoneNumber) {
	const sessionKey = buildSessionKey(accountId, userId);

	// Already connected
	if (sessions[sessionKey]?.connected) return { status: 'already_connected', session: sessions[sessionKey] };

	// Already waiting for pairing code
	if (pairingSessions[sessionKey]?.code) {
		return { status: 'pending', code: pairingSessions[sessionKey].code };
	}

	const sessionPath = buildSessionPath(accountId, userId);
	if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

	// Clean stale credentials from previous attempts to avoid Connection Closed
	const existingFiles = fs.readdirSync(sessionPath);
	for (const f of existingFiles) {
		if (f.endsWith('.json') && f !== 'store.json') {
			try { fs.rmSync(path.join(sessionPath, f), { force: true }); } catch {}
		}
	}

	const { state: authState, saveCreds } = await useMultiFileAuthState(sessionPath);
	const debouncedSave = debounce(saveCreds, 500);
	const versionInfo = await fetchLatestBaileysVersion().catch(() => null);

	const sock = makeWASocket({
		auth: authState,
		logger: P({ level: 'silent' }),
		printQRInTerminal: false,
		browser: getRandomBrowser(),
		version: versionInfo?.version
	});

	pairingSessions[sessionKey] = { socket: sock, code: null, phoneNumber };
	sessions[sessionKey] = {
		socket: sock,
		connected: false,
		qr: null,
		lastQr: null,
		whatsapp_number: null,
		sessionPath,
		accountId,
		userId,
		sessionKey,
		retryCount: 0
	};

	sock.ev.on('creds.update', debouncedSave);

	// Wait for underlying WebSocket to be connected (not session authenticated)
	const wsReady = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('WebSocket ready timeout')), 15000);
		
		const checkReady = () => {
			if (sock.ws && sock.ws.readyState === 1) { // WebSocket.OPEN
				clearTimeout(timeout);
				resolve();
			}
		};
		
		checkReady();
		
		if (sock.ws) {
			sock.ws.on('open', () => {
				clearTimeout(timeout);
				resolve();
			});
			sock.ws.on('error', (err) => {
				clearTimeout(timeout);
				reject(new Error(`WebSocket error: ${err.message}`));
			});
			sock.ws.on('close', () => {
				clearTimeout(timeout);
				reject(new Error('WebSocket closed before open'));
			});
		}
	});

	// Request pairing code after socket is ready (not yet registered)
	let code = null;
	try {
		// Wait for WS to open
		await wsReady;

		// Baileys requires calling requestPairingCode only when not already registered
		if (!authState.creds.registered) {
			// Normalize: strip non-digits
			const cleanPhone = phoneNumber.replace(/\D/g, '');
			code = await sock.requestPairingCode(cleanPhone);
			pairingSessions[sessionKey].code = code;
		} else {
			// Already registered — just start normal session
			delete pairingSessions[sessionKey];
			return startSession(accountId, userId);
		}
	} catch (e) {
		delete sessions[sessionKey];
		delete pairingSessions[sessionKey];
		throw new Error(`Failed to request pairing code: ${e.message}`);
	}

	sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
		if (connection === 'open') {
			const number = sock.user.id.split(':')[0];
			Object.assign(sessions[sessionKey], { connected: true, qr: null, whatsapp_number: number });
			delete pairingSessions[sessionKey];
			console.log(`[WA][PAIR][${sessionKey}] Connected as ${number}`);
		}
		if (connection === 'close') {
			const closeCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.reason;
			if (sessions[sessionKey]) sessions[sessionKey].connected = false;
			if (closeCode === DisconnectReason.loggedOut || closeCode === 401) {
				await purgeSessionCredentials(accountId, { removeStore: false, userId }).catch(() => {});
				delete sessions[sessionKey];
				delete pairingSessions[sessionKey];
			}
		}
	});

	sock.ev.on('messages.upsert', (m) => {
		try {
			for (const msg of (m.messages || [])) {
				const remote = msg.key?.remoteJid ?? '<unknown>';
				console.log(`[WA][PAIR][MSG] session=${sessionKey} remote=${remote}`);
			}
		} catch {}
	});

	return { status: 'pairing_code_sent', code };
}

function getPairingSession(accountId, userId) {
	return pairingSessions[buildSessionKey(accountId, userId)] || null;
}

module.exports = {
	startSession,
	startPairingSession,
	getPairingSession,
	getSession,
	getAllSessions,
	removeSession,
	SESSIONS_DIR,
	buildSessionKey,
	buildSessionPath,
	emptySessionFolder,
	purgeSessionCredentials
};
