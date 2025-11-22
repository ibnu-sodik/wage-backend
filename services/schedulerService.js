const db = require('../config/db');
const { startSession, getSession } = require('./sessionManager');
const { sendTemplatedMessage } = require('./messageService');
const { applyPlaceholders } = require('../utils/template');

const POLL_INTERVAL_MS = parseInt(process.env.SCHEDULER_POLL_INTERVAL_MS) || 15_000; // 15s default
const MAX_RETRIES = parseInt(process.env.SCHEDULER_MAX_RETRIES) || 3;
const BASE_BACKOFF_SECONDS = parseInt(process.env.SCHEDULER_BASE_BACKOFF_SECONDS) || 60; // exponential base
const DEVICE_CONCURRENCY = parseInt(process.env.SCHEDULER_DEVICE_CONCURRENCY) || 5;
const RATE_MIN_MS = parseInt(process.env.SCHEDULER_RATE_MIN_MS) || 300;
const RATE_MAX_MS = parseInt(process.env.SCHEDULER_RATE_MAX_MS) || 1000;

let _timer = null;
let _running = false;

// in-memory concurrency tracking per DEVICE_ID
const deviceActiveMap = new Map();

function incrementDeviceActive(deviceId) {
    const v = deviceActiveMap.get(deviceId) || 0;
    deviceActiveMap.set(deviceId, v + 1);
}

function decrementDeviceActive(deviceId) {
    const v = deviceActiveMap.get(deviceId) || 0;
    if (v <= 1) deviceActiveMap.delete(deviceId);
    else deviceActiveMap.set(deviceId, v - 1);
}

async function processHeader(row) {
    const { ID, DEVICE_ID, USER_ID, MESSAGE_TYPE, MESSAGE_TEXT, TEMPLATE_ID } = row;
    // Ensure session started
    let session = getSession(DEVICE_ID, USER_ID);
    try {
        session = await startSession(DEVICE_ID, USER_ID);
    } catch (e) {
        console.error('[SCHED] startSession error', DEVICE_ID, USER_ID, e.message);
    }

    // select only pending details that are due for attempt
    const [details] = await db.query('SELECT * FROM scbcdt WHERE ID = ? AND USER_ID = ? AND IS_SENT = 0 AND (NEXT_ATTEMPT_AT IS NULL OR NEXT_ATTEMPT_AT <= NOW()) ORDER BY NOKEY ASC', [ID, USER_ID]);
    if (!details.length) {
        // nothing to do; mark header as sent
        await db.query('UPDATE scbchd SET STATUS = ? WHERE ID = ? AND USER_ID = ?', ['sent', ID, USER_ID]);
        return;
    }

    // Preload template and sender when needed
    let templateRow = null;
    if (MESSAGE_TYPE === 'template' && TEMPLATE_ID) {
        const [trows] = await db.query('SELECT ID, TEMP_TYPE, TEMP_FILE, TEMP_MESSAGE, TEMP_BUTTONS FROM TEMPTBL WHERE ID = ? AND USER_ID = ?', [TEMPLATE_ID, USER_ID]);
        templateRow = trows[0] || null;
    }
    const [senderRows] = await db.query("SELECT CONCAT(FIRST_NAME,' ', LAST_NAME) AS FULLNAME, EMAIL FROM SYSUSER WHERE ID = ?", [USER_ID]);
    const senderRow = senderRows[0] || {};

    for (const det of details) {
        const receiver = det.CONTACT_NUMBER;
        const nokey = det.NOKEY;
        // If job-queue is enabled, enqueue a job and skip immediate send (queue worker will process)
        if (USE_QUEUE && queueModule) {
            try {
                await queueModule.addRecipientJob({ headerId: ID, nokey, deviceId: DEVICE_ID, userId: USER_ID, messageType: MESSAGE_TYPE, messageText: MESSAGE_TEXT, templateId: TEMPLATE_ID });
                // mark NEXT_ATTEMPT_AT null so we don't block future retries from scheduler
                await db.query('UPDATE scbcdt SET NEXT_ATTEMPT_AT = NULL WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [ID, nokey, USER_ID]);
            } catch (e) {
                console.error('[SCHED] enqueue failed for', nokey, e.message);
                // fallthrough to postpone via scheduler
                const postponeSeconds = Math.max(5, Math.ceil(BASE_BACKOFF_SECONDS / 6));
                try { await db.query('UPDATE scbcdt SET NEXT_ATTEMPT_AT = DATE_ADD(NOW(), INTERVAL ? SECOND), LAST_ERROR = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [postponeSeconds, e.message, ID, nokey, USER_ID]); } catch (ex) { }
            }
            continue;
        }

        // concurrency control per device (only used when not using queue)
        const active = deviceActiveMap.get(DEVICE_ID) || 0;
        if (active >= DEVICE_CONCURRENCY) {
            // postpone this recipient a bit
            const postponeSeconds = Math.max(5, Math.ceil(BASE_BACKOFF_SECONDS / 6));
            try { await db.query('UPDATE scbcdt SET NEXT_ATTEMPT_AT = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [postponeSeconds, ID, nokey, USER_ID]); } catch (e) { }
            continue;
        }

        incrementDeviceActive(DEVICE_ID);
        let didIncrement = true;
        try {
            if (!session || !session.connected) {
                // record error and retry/backoff
                console.warn('[SCHED] session not connected for', DEVICE_ID, USER_ID);
                const errMsg = 'device not connected';
                const retryCount = (det.RETRY_COUNT || 0) + 1;
                if (retryCount > MAX_RETRIES) {
                    await db.query('UPDATE scbcdt SET IS_SENT = 2, DELIVERY_AT = ?, LAST_ERROR = ?, RETRY_COUNT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), errMsg, retryCount, ID, nokey, USER_ID]);
                } else {
                    const backoff = Math.pow(2, retryCount - 1) * BASE_BACKOFF_SECONDS;
                    await db.query('UPDATE scbcdt SET NEXT_ATTEMPT_AT = DATE_ADD(NOW(), INTERVAL ? SECOND), LAST_ERROR = ?, RETRY_COUNT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [backoff, errMsg, retryCount, ID, nokey, USER_ID]);
                }
                continue;
            }

            if (MESSAGE_TYPE === 'live') {
                // rate limit: small random delay before sending to avoid rapid-fire
                const delayMs = Math.floor(Math.random() * (RATE_MAX_MS - RATE_MIN_MS + 1)) + RATE_MIN_MS;
                await new Promise(r => setTimeout(r, delayMs));
                const placeholders = { name: det.CONTACT_NAME || '' };
                const finalMessage = applyPlaceholders(MESSAGE_TEXT || '', placeholders);
                const sent = await session.socket.sendMessage(`${receiver}@s.whatsapp.net`, { text: finalMessage });
                if (sent) {
                    await db.query('UPDATE scbcdt SET IS_SENT = 1, DELIVERY_AT = ?, LAST_ERROR = NULL, NEXT_ATTEMPT_AT = NULL WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), ID, nokey, USER_ID]);
                } else {
                    const errMsg = 'unknown send result';
                    const retryCount = (det.RETRY_COUNT || 0) + 1;
                    if (retryCount > MAX_RETRIES) {
                        await db.query('UPDATE scbcdt SET IS_SENT = 2, DELIVERY_AT = ?, LAST_ERROR = ?, RETRY_COUNT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), errMsg, retryCount, ID, nokey, USER_ID]);
                    } else {
                        const backoff = Math.pow(2, retryCount - 1) * BASE_BACKOFF_SECONDS;
                        await db.query('UPDATE scbcdt SET NEXT_ATTEMPT_AT = DATE_ADD(NOW(), INTERVAL ? SECOND), LAST_ERROR = ?, RETRY_COUNT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [backoff, errMsg, retryCount, ID, nokey, USER_ID]);
                    }
                }
            } else if (MESSAGE_TYPE === 'template') {
                if (!templateRow) {
                    const errMsg = 'template not found';
                    const retryCount = (det.RETRY_COUNT || 0) + 1;
                    if (retryCount > MAX_RETRIES) {
                        await db.query('UPDATE scbcdt SET IS_SENT = 2, DELIVERY_AT = ?, LAST_ERROR = ?, RETRY_COUNT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), errMsg, retryCount, ID, nokey, USER_ID]);
                    } else {
                        const backoff = Math.pow(2, retryCount - 1) * BASE_BACKOFF_SECONDS;
                        await db.query('UPDATE scbcdt SET NEXT_ATTEMPT_AT = DATE_ADD(NOW(), INTERVAL ? SECOND), LAST_ERROR = ?, RETRY_COUNT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [backoff, errMsg, retryCount, ID, nokey, USER_ID]);
                    }
                    continue;
                }
                try {
                    // rate limit before templated send
                    const delayMs = Math.floor(Math.random() * (RATE_MAX_MS - RATE_MIN_MS + 1)) + RATE_MIN_MS;
                    await new Promise(r => setTimeout(r, delayMs));
                    await sendTemplatedMessage({ session, templateRow, receiverRow: det, senderRow, receiver, templateType: templateRow.TEMP_TYPE });
                    await db.query('UPDATE scbcdt SET IS_SENT = 1, DELIVERY_AT = ?, LAST_ERROR = NULL, NEXT_ATTEMPT_AT = NULL WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), ID, nokey, USER_ID]);
                } catch (e) {
                    const errMsg = e.message || 'send failed';
                    const retryCount = (det.RETRY_COUNT || 0) + 1;
                    if (retryCount > MAX_RETRIES) {
                        await db.query('UPDATE scbcdt SET IS_SENT = 2, DELIVERY_AT = ?, LAST_ERROR = ?, RETRY_COUNT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), errMsg, retryCount, ID, nokey, USER_ID]);
                    } else {
                        const backoff = Math.pow(2, retryCount - 1) * BASE_BACKOFF_SECONDS;
                        await db.query('UPDATE scbcdt SET NEXT_ATTEMPT_AT = DATE_ADD(NOW(), INTERVAL ? SECOND), LAST_ERROR = ?, RETRY_COUNT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [backoff, errMsg, retryCount, ID, nokey, USER_ID]);
                    }
                }
            } else {
                console.warn('[SCHED] Unknown MESSAGE_TYPE', MESSAGE_TYPE);
                const errMsg = 'unsupported message type';
                const retryCount = (det.RETRY_COUNT || 0) + 1;
                if (retryCount > MAX_RETRIES) {
                    await db.query('UPDATE scbcdt SET IS_SENT = 2, DELIVERY_AT = ?, LAST_ERROR = ?, RETRY_COUNT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), errMsg, retryCount, ID, nokey, USER_ID]);
                } else {
                    const backoff = Math.pow(2, retryCount - 1) * BASE_BACKOFF_SECONDS;
                    await db.query('UPDATE scbcdt SET NEXT_ATTEMPT_AT = DATE_ADD(NOW(), INTERVAL ? SECOND), LAST_ERROR = ?, RETRY_COUNT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [backoff, errMsg, retryCount, ID, nokey, USER_ID]);
                }
            }
        } catch (e) {
            console.error('[SCHED] send error for', receiver, e.message);
            try {
                const errMsg = e.message || 'exception';
                const retryCount = (det.RETRY_COUNT || 0) + 1;
                if (retryCount > MAX_RETRIES) {
                    await db.query('UPDATE scbcdt SET IS_SENT = 2, DELIVERY_AT = ?, LAST_ERROR = ?, RETRY_COUNT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), errMsg, retryCount, ID, nokey, USER_ID]);
                } else {
                    const backoff = Math.pow(2, retryCount - 1) * BASE_BACKOFF_SECONDS;
                    await db.query('UPDATE scbcdt SET NEXT_ATTEMPT_AT = DATE_ADD(NOW(), INTERVAL ? SECOND), LAST_ERROR = ?, RETRY_COUNT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [backoff, errMsg, retryCount, ID, nokey, USER_ID]);
                }
            } catch (ex) { }
        } finally {
            if (didIncrement) decrementDeviceActive(DEVICE_ID);
        }
    }

    // Re-evaluate header status
    try {
        const [[counts]] = await db.query("SELECT SUM(CASE WHEN IS_SENT = 1 THEN 1 ELSE 0 END) AS sent_count, SUM(CASE WHEN IS_SENT = 2 THEN 1 ELSE 0 END) AS fail_count, COUNT(*) AS total_count FROM scbcdt WHERE ID = ? AND USER_ID = ?", [ID, USER_ID]);
        const { sent_count = 0, fail_count = 0, total_count = 0 } = counts || {};
        let newStatus = 'scheduled';
        if (total_count === 0) newStatus = 'sent';
        else if (sent_count === total_count) newStatus = 'sent';
        else if (fail_count === total_count) newStatus = 'failed';
        else if (sent_count > 0) newStatus = 'sent';
        else newStatus = 'scheduled';
        await db.query('UPDATE scbchd SET STATUS = ? WHERE ID = ? AND USER_ID = ?', [newStatus, ID, USER_ID]);
    } catch (e) {
        console.error('[SCHED] evaluate header status failed', e.message);
    }
}

const USE_QUEUE = process.env.USE_JOB_QUEUE === 'true';
let queueModule = null;
if (USE_QUEUE) {
    try { queueModule = require('./queueService'); } catch (e) { console.warn('[SCHED] job queue requested but queue module failed to load:', e.message); }
}

async function poll() {
    if (_running) return;
    _running = true;
    try {
        const [rows] = await db.query("SELECT * FROM scbchd WHERE STATUS = 'scheduled' AND DELIVERY_AT <= NOW() ORDER BY DELIVERY_AT ASC LIMIT 50");
        for (const row of rows) {
            try { await processHeader(row); } catch (e) { console.error('[SCHED] processHeader error', e.message); }
        }
    } catch (e) {
        console.error('[SCHED] poll error', e.message);
    } finally {
        _running = false;
    }
}

function startScheduler() {
    if (process.env.SCHEDULER_ENABLED === 'false') {
        console.log('[SCHED] Scheduler disabled by env');
        return;
    }
    if (_timer) return; // already started
    console.log('[SCHED] Starting scheduler. Poll interval:', POLL_INTERVAL_MS);
    _timer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
    // run immediately once
    void poll();
}

function stopScheduler() {
    if (_timer) clearInterval(_timer);
    _timer = null;
}

module.exports = { startScheduler, stopScheduler };
