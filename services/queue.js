const Queue = require('bull');
const { sendTemplatedMessage } = require('./messageService');
const { startSession, getSession } = require('./sessionManager');
const db = require('../config/db');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const QUEUE_NAME = process.env.SCHEDULER_QUEUE_NAME || 'wage-scheduler-queue';
const QUEUE_CONCURRENCY = parseInt(process.env.SCHEDULER_QUEUE_CONCURRENCY) || 10;
const MAX_RETRIES = parseInt(process.env.SCHEDULER_MAX_RETRIES) || 3;
const BASE_BACKOFF_SECONDS = parseInt(process.env.SCHEDULER_BASE_BACKOFF_SECONDS) || 60;

const queue = new Queue(QUEUE_NAME, REDIS_URL);

// Add a job for single recipient send
function addRecipientJob({ headerId, nokey, deviceId, userId, messageType, messageText, templateId }) {
    return queue.add(
        'send-recipient',
        { headerId, nokey, deviceId, userId, messageType, messageText, templateId },
        {
            attempts: MAX_RETRIES,
            backoff: { type: 'exponential', delay: BASE_BACKOFF_SECONDS * 1000 },
            removeOnComplete: true,
            removeOnFail: false
        }
    );
}

// Worker processing jobs for named job type 'send-recipient'
queue.process('send-recipient', QUEUE_CONCURRENCY, async (job) => {
    const data = job.data;
    const { headerId, nokey, deviceId, userId, messageType, messageText, templateId } = data;

    // load detail row
    const [[detailRow]] = await db.query('SELECT * FROM scbcdt WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [headerId, nokey, userId]);
    if (!detailRow) {
        // nothing to do
        return Promise.resolve();
    }

    // Ensure session
    let session = getSession(deviceId, userId);
    try { session = await startSession(deviceId, userId); } catch (e) { /* continue */ }

    if (!session || !session.connected) {
        throw new Error('device not connected');
    }

    // prepare template if needed
    let templateRow = null;
    if (messageType === 'template' && templateId) {
        const [trows] = await db.query('SELECT ID, TEMP_TYPE, TEMP_FILE, TEMP_MESSAGE, TEMP_BUTTONS FROM TEMPTBL WHERE ID = ? AND USER_ID = ?', [templateId, userId]);
        templateRow = trows[0] || null;
        if (!templateRow) throw new Error('template not found');
    }

    // sender
    const [senderRows] = await db.query("SELECT CONCAT(FIRST_NAME,' ', LAST_NAME) AS FULLNAME, EMAIL FROM SYSUSER WHERE ID = ?", [userId]);
    const senderRow = senderRows[0] || {};

    try {
        if (messageType === 'live') {
            const { applyPlaceholders } = require('../utils/template');
            const finalMessage = applyPlaceholders(messageText || '', { name: detailRow.CONTACT_NAME || '' });
            const sent = await session.socket.sendMessage(`${detailRow.CONTACT_NUMBER}@s.whatsapp.net`, { text: finalMessage });
            if (!sent) throw new Error('unknown send result');
        } else if (messageType === 'template') {
            await sendTemplatedMessage({ session, templateRow, receiverRow: detailRow, senderRow, receiver: detailRow.CONTACT_NUMBER, templateType: templateRow.TEMP_TYPE });
        } else {
            throw new Error('unsupported message type');
        }

        // mark sent
        await db.query('UPDATE scbcdt SET IS_SENT = 1, DELIVERY_AT = ?, LAST_ERROR = NULL, NEXT_ATTEMPT_AT = NULL WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), headerId, nokey, userId]);

        // After marking recipient sent, re-evaluate header status in transaction-safe way
        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            const [countsRows] = await conn.query("SELECT SUM(CASE WHEN IS_SENT = 1 THEN 1 ELSE 0 END) AS sent_count, SUM(CASE WHEN IS_SENT = 2 THEN 1 ELSE 0 END) AS fail_count, COUNT(*) AS total_count FROM scbcdt WHERE ID = ? AND USER_ID = ? FOR UPDATE", [headerId, userId]);
            const counts = countsRows[0] || {};
            const sent_count = counts.sent_count || 0;
            const fail_count = counts.fail_count || 0;
            const total_count = counts.total_count || 0;
            let newStatus = 'scheduled';
            if (total_count === 0) newStatus = 'sent';
            else if (sent_count === total_count) newStatus = 'sent';
            else if (fail_count === total_count) newStatus = 'failed';
            else if (sent_count > 0) newStatus = 'sent';
            else newStatus = 'scheduled';
            await conn.query('UPDATE scbchd SET STATUS = ? WHERE ID = ? AND USER_ID = ?', [newStatus, headerId, userId]);
            await conn.commit();
        } catch (e) {
            try { await conn.rollback(); } catch (ex) { }
        } finally {
            conn.release();
        }

        return Promise.resolve();
    } catch (e) {
        // record LAST_ERROR and schedule next attempt via job retry (Bull will handle backoff/attempts)
        try {
            const retryCount = (detailRow.RETRY_COUNT || 0) + 1;
            if (retryCount > MAX_RETRIES) {
                await db.query('UPDATE scbcdt SET IS_SENT = 2, DELIVERY_AT = ?, LAST_ERROR = ?, RETRY_COUNT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [new Date(), e.message, retryCount, headerId, nokey, userId]);
            } else {
                await db.query('UPDATE scbcdt SET LAST_ERROR = ?, RETRY_COUNT = ? WHERE ID = ? AND NOKEY = ? AND USER_ID = ?', [e.message, retryCount, headerId, nokey, userId]);
            }
        } catch (ex) { /* ignore */ }
        throw e; // let bull handle retries/backoff
    }
});

module.exports = { addRecipientJob, queue };
