// Entry point: bootstrap express app
const { createApp } = require('./app');

const port = process.env.PORT || 8000;
const app = createApp();

app.listen(port, () => {
	console.log(`WA Gateway Baileys running at http://localhost:${port}`);

	const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
	console.log("Timezone aktif:", tz);
	console.log("Current Time:", new Date().toLocaleString("id-ID", { timeZone: tz }));
});

// Global handlers to reduce noisy stack traces from libsignal decrypt failures
process.on('unhandledRejection', (reason) => {
	try {
		const msg = (reason && reason.message) ? reason.message : String(reason);
		if (msg && (msg.includes('Bad MAC') || msg.includes('Failed to decrypt message'))) {
			console.warn('[GLOBAL] libsignal decrypt warning:', msg);
			return;
		}
	} catch (e) { }
	console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
	try {
		const msg = (err && err.message) ? err.message : String(err);
		if (msg && (msg.includes('Bad MAC') || msg.includes('Failed to decrypt message'))) {
			console.warn('[GLOBAL] libsignal decrypt exception:', msg);
			return;
		}
	} catch (e) { }
	console.error('Uncaught Exception:', err);
	// For other exceptions, exit to allow process manager to restart if needed
	process.exit(1);
});
