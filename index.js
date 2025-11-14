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
