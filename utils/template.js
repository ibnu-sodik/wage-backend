function applyPlaceholders(template, placeholders) {
	return template.replace(/{(.*?)}/g, (match, key) => {
		return placeholders[key.trim()] || match;
	});
}

function groupButtonsByType(buttons = []) {
	const grouped = { reply: [], url: [], call: [] };
	for (const btn of buttons) {
		if (btn.type === 'reply') grouped.reply.push(btn);
		else if (btn.type === 'url') grouped.url.push(btn);
		else if (btn.type === 'call') grouped.call.push(btn);
	}
	if (grouped.reply.length) return { type: 'reply', buttons: grouped.reply };
	if (grouped.url.length) return { type: 'url', buttons: grouped.url };
	if (grouped.call.length) return { type: 'call', buttons: grouped.call };
	return { type: null, buttons: [] };
}

function convertButtons(buttons, type) {
	const result = [];
	buttons.forEach((btn, idx) => {
		const index = idx + 1; // Baileys expects index to start from 1
		if (type === 'reply' && btn.reply) {
			result.push({
				index: index,
				quickReplyButton: { displayText: btn.reply.title, id: btn.reply.id }
			});
		} else if (type === 'url' && btn.url) {
			result.push({
				index: index,
				urlButton: {
					displayText: btn.url.title,
					url: btn.url.url.startsWith('http') ? btn.url.url : 'https://' + btn.url.url
				}
			});
		} else if (type === 'call' && btn.call) {
			result.push({
				index: index,
				callButton: {
					displayText: btn.call.title,
					phoneNumber: '+' + btn.call.phone_number.replace(/^(\+?)/, '')
				}
			});
		}
	});
	return result;
}

module.exports = { applyPlaceholders, groupButtonsByType, convertButtons };
