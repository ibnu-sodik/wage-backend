const db = require('../config/db');
const { applyPlaceholders, groupButtonsByType, convertButtons } = require('../utils/template');
const fs = require('fs');
const path = require('path');

// Max size (bytes) defaults (can override via env)
const MAX_IMAGE_SIZE = parseInt(process.env.MAX_IMAGE_SIZE);
const MAX_VIDEO_SIZE = parseInt(process.env.MAX_VIDEO_SIZE);
const MAX_AUDIO_SIZE = parseInt(process.env.MAX_AUDIO_SIZE);
const MAX_DOC_SIZE = parseInt(process.env.MAX_DOC_SIZE);

// Optional: BASE_URL for stripping local absolute URLs and mapping to filesystem
const APP_BASE_URL = (process.env.APP_BASE_URL).replace(/\/$/, '');
// Public uploads dir relative to project root (adjust if different)
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

function normalizeMediaPath(url) {
	if (!url) return { original: url, fsPath: null, isLocal: false };
	let clean = url.trim();
	// If contains base url, strip it to get relative path
	if (clean.startsWith(APP_BASE_URL)) {
		const rel = clean.substring(APP_BASE_URL.length).replace(/^\//, '');
		// Expect something like goblog-nawanu/uploads/... or uploads/...
		// Try to locate 'uploads/' segment
		const idx = rel.toLowerCase().indexOf('uploads/');
		if (idx !== -1) {
			const relFromUploads = rel.substring(idx + 'uploads/'.length); // part after uploads/
			const fullFsPath = path.join(UPLOADS_DIR, relFromUploads);
			return { original: url, fsPath: fullFsPath, isLocal: true };
		}
	}
	// Also treat as local if it's a relative path starting with uploads/
	if (/^uploads\//i.test(clean)) {
		const relFromUploads = clean.replace(/^uploads\//i, '');
		const fullFsPath = path.join(UPLOADS_DIR, relFromUploads);
		return { original: url, fsPath: fullFsPath, isLocal: true };
	}
	return { original: url, fsPath: null, isLocal: false };
}

function validateFileSize(fsPath, typeCategory, maxSizeMap) {
	if (!fsPath) return; // remote URL – skip size validation (could add HEAD request later)
	try {
		const stat = fs.statSync(fsPath);
		const size = stat.size;
		const limit = maxSizeMap[typeCategory];
		if (limit && size > limit) {
			throw new Error(`File size ${Math.round(size / 1024)}KB exceeds limit for ${typeCategory} (${Math.round(limit / 1024)}KB)`);
		}
	} catch (e) {
		if (e.code === 'ENOENT') {
			throw new Error('Media file not found on server');
		}
		if (e.message.startsWith('File size')) throw e; // rethrow size error
		// Other errors: log but don't mask
		throw e;
	}
}

async function prepareTemplateData({ templateId, userId, receiverIds }) {
	// Not fully generalized; we follow original query style for single receiver later in controller.
	return { templateId, userId, receiverIds };
}

async function sendTemplatedMessage({ session, templateRow, receiverRow, senderRow, receiver, templateType }) {
	const { TEMP_MESSAGE: templateContent, TEMP_TYPE: tType, TEMP_FILE: templateFileUrl, TEMP_BUTTONS } = templateRow;
	const placeholders = {
		name: receiverRow.CONTACT_NAME || '',
		phone_number: receiverRow.CONTACT_NUMBER || '',
		device_name: receiverRow.DEVICE_NAME || '',
		my_name: senderRow.FULLNAME || '',
		my_email: senderRow.EMAIL || '',
		// Jika ada kolom nomor kontak pengirim (belum ada di query sekarang), fallback ke email.
		my_contact_number: senderRow.CONTACT_NUMBER || senderRow.EMAIL || '',
	};
	const finalMessage = applyPlaceholders(templateContent, placeholders);
	const numberWA = receiver.includes('@s.whatsapp.net') ? receiver : receiver + '@s.whatsapp.net';

	let sentMsg;
	const type = templateType || tType;
	if (type === 'plain-text') {
		sentMsg = await session.socket.sendMessage(numberWA, { text: finalMessage });
	} else if (type === 'text-with-media') {
		if (!templateFileUrl) throw new Error('Media file missing');
		const videoExt = ['mp4', 'avi', 'mov', 'mkv', 'wmv', 'webm', 'flv'];
		const audioExt = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'];
		const imageExt = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'];
		const documentExt = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'odt', 'ods'];
		const docMimeMap = {
			pdf: 'application/pdf',
			doc: 'application/msword',
			docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			xls: 'application/vnd.ms-excel',
			xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			ppt: 'application/vnd.ms-powerpoint',
			pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
			txt: 'text/plain',
			csv: 'text/csv',
			odt: 'application/vnd.oasis.opendocument.text',
			ods: 'application/vnd.oasis.opendocument.spreadsheet'
		};
		const lowerUrl = templateFileUrl.toLowerCase();
		const ext = lowerUrl.split('.').pop();
		// Map extension to coarse category for size limit
		const sizeMap = {
			image: MAX_IMAGE_SIZE,
			video: MAX_VIDEO_SIZE,
			document: MAX_DOC_SIZE,
			audio: MAX_AUDIO_SIZE
		};
		const norm = normalizeMediaPath(templateFileUrl);
		if (imageExt.includes(ext)) {
			validateFileSize(norm.fsPath, 'image', sizeMap);
			sentMsg = await session.socket.sendMessage(numberWA, { image: { url: templateFileUrl }, caption: finalMessage });
		} else if (videoExt.includes(ext)) {
			validateFileSize(norm.fsPath, 'video', sizeMap);
			sentMsg = await session.socket.sendMessage(numberWA, { video: { url: templateFileUrl }, caption: finalMessage });
		} else if (documentExt.includes(ext)) {
			const mimetype = docMimeMap[ext] || 'application/octet-stream';
			validateFileSize(norm.fsPath, 'document', sizeMap);
			sentMsg = await session.socket.sendMessage(numberWA, { document: { url: templateFileUrl }, mimetype, caption: finalMessage });
		} else if (audioExt.includes(ext)) {
			// Tentukan mimetype audio berdasar ekstensi
			const audioMime = {
				mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac'
			}[ext] || 'audio/mpeg';
			validateFileSize(norm.fsPath, 'audio', sizeMap);
			sentMsg = await session.socket.sendMessage(numberWA, { audio: { url: templateFileUrl }, mimetype: audioMime });
		} else {
			throw new Error('Unsupported media type');
		}
	} else if (type === 'interactive-button') {
		const options = JSON.parse(TEMP_BUTTONS || '{}');
		const footerText = options.footer || '';
		const rawButtons = options.buttons || [];
		const { type: selectedType, buttons: filteredButtons } = groupButtonsByType(rawButtons);
		if (!selectedType || filteredButtons.length === 0) throw new Error('No valid buttons of same type');
		const convertedButtons = convertButtons(filteredButtons, selectedType);
		const buttonMessage = { text: finalMessage, footer: footerText, templateButtons: convertedButtons, headerType: 1 };
		console.log('[DEBUG] buttonMessage:', JSON.stringify(buttonMessage, null, 2));

		// const buttonMessage = {
		// 	text: "Pilih *Gender* anda",
		// 	footer: "Silakan pilih salah satu",
		// 	templateButtons: [
		// 		{
		// 			index: 1,
		// 			quickReplyButton: {
		// 				displayText: "Pria",
		// 				id: "btn-pria"
		// 			}
		// 		},
		// 		{
		// 			index: 2,
		// 			quickReplyButton: {
		// 				displayText: "Wanita",
		// 				id: "btn-wanita"
		// 			}
		// 		}
		// 	],
		// 	headerType: 1 // 1 = text, 2 = media
		// };
		// console.log('[DEBUG] convertedButtons:', JSON.stringify(buttonMessage, null, 2));

		// sentMsg = await session.socket.sendMessage(numberWA, { poll: { name: "pollName", values: ["option1", "option2", "option3"] } });
		sentMsg = await session.socket.sendMessage(numberWA, buttonMessage);
	} else {
		throw new Error('Unsupported template type');
	}
	return sentMsg;
}

module.exports = { prepareTemplateData, sendTemplatedMessage };
