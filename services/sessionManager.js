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

	if (!sess) return false;

	try { sess.socket.logout(); } catch { }
	try { sess.socket.end(); } catch { }
	try { sess.socket.ws?.close(); } catch { }

	delete sessions[sessionKey];

	if (deleteFolder) {
		fs.rmSync(sess.sessionPath, { recursive: true, force: true });
	}

	return true;
}

module.exports = {
	startSession,
	getSession,
	getAllSessions,
	removeSession,
	SESSIONS_DIR,
	buildSessionKey,
	buildSessionPath
};
