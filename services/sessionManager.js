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

async function startSession(accountId, userId) {
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
			browser: ["Chrome (Windows)", "Chrome", "120.0.6099.217"],
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
			sessionKey
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

				if (code === DisconnectReason.loggedOut) {
					console.log(`[WA][${sessionKey}] Logged out. Must scan QR again.`);
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
					console.log(`[WA][${sessionKey}] Reconnecting...`);
					delete sessions[sessionKey];
					setTimeout(() => startSession(accountId, userId), 1500);
				}
			}
		});

		// Log incoming message upserts (concise summary) to help diagnose decryption errors
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
				// Don't let logging break session flow
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

module.exports = {
	startSession,
	getSession,
	getAllSessions,
	removeSession,
	SESSIONS_DIR,
	buildSessionKey,
	buildSessionPath,
	emptySessionFolder,
	purgeSessionCredentials
};
