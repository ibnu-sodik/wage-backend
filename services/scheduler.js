const db = require('../config/db');
const { startSession, getSession } = require('./sessionManager');
const { sendTemplatedMessage } = require('./messageService');
const { applyPlaceholders } = require('../utils/template');

const POLL_INTERVAL_MS = parseInt(process.env.SCHEDULER_POLL_INTERVAL_MS) || 15_000; // 15s default
let _timer = null;
let _running = false;

async function processHeader(row) {
    const { ID, DEVICE_ID, USER_ID, MESSAGE_TYPE, MESSAGE_TEXT, TEMPLATE_ID } = row;
    // Ensure session started
    let session = getSession(DEVICE_ID, USER_ID);
    try {
        session = await startSession(DEVICE_ID, USER_ID);
    } catch (e) {
        console.error('[SCHED] startSession error', DEVICE_ID, USER_ID, e.message);
    }

    const [details] = await db.query('SELECT * FROM scbcdt WHERE ID = ? AND USER_ID = ? AND IS_SENT = 0', [ID, USER_ID]);
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
    const [senderRows] = await db.query("SELECT CONCAT(FIRST_NAME,' ', LAST_NAME) AS FULLNAME, EMAIL, EMAIL FROM SYSUSER WHERE ID = ?", [USER_ID]);
    const senderRow = senderRows[0] || {};

    for (const det of details) {
        const receiver = det.CONTACT_NUMBER;
        const nokey = det.NOKEY;
        try {
            if (!session || !session.connected) {
                // attempt to start, but if still not connected, mark as failed for this receiver
                console.warn('[SCHED] session not connected for', DEVICE_ID, USER_ID);
                await db.query('UPDATE scbcdt SET IS_SENT = 2, DELIVERY_AT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), ID, nokey, USER_ID]);
                continue;
            }

            if (MESSAGE_TYPE === 'live') {
                const placeholders = { name: det.CONTACT_NAME || '' };
                const finalMessage = applyPlaceholders(MESSAGE_TEXT || '', placeholders);
                const sent = await session.socket.sendMessage(`${receiver}@s.whatsapp.net`, { text: finalMessage });
                if (sent) {
                    await db.query('UPDATE scbcdt SET IS_SENT = 1, DELIVERY_AT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), ID, nokey, USER_ID]);
                } else {
                    await db.query('UPDATE scbcdt SET IS_SENT = 2, DELIVERY_AT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), ID, nokey, USER_ID]);
                }
            } else if (MESSAGE_TYPE === 'template') {
                if (!templateRow) {
                    await db.query('UPDATE scbcdt SET IS_SENT = 2, DELIVERY_AT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), ID, nokey, USER_ID]);
                    continue;
                }
                await sendTemplatedMessage({ session, templateRow, receiverRow: det, senderRow, receiver, templateType: templateRow.TEMP_TYPE });
                await db.query('UPDATE scbcdt SET IS_SENT = 1, DELIVERY_AT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), ID, nokey, USER_ID]);
            } else {
                console.warn('[SCHED] Unknown MESSAGE_TYPE', MESSAGE_TYPE);
                await db.query('UPDATE scbcdt SET IS_SENT = 2, DELIVERY_AT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), ID, nokey, USER_ID]);
            }
        } catch (e) {
            console.error('[SCHED] send error for', receiver, e.message);
            try { await db.query('UPDATE scbcdt SET IS_SENT = 2, DELIVERY_AT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), ID, nokey, USER_ID]); } catch (ex) { }
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
