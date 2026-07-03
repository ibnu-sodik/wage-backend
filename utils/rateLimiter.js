// In-memory rate limiter per device
const deviceMessageTimestamps = new Map();

const RATE_LIMIT_PER_MINUTE = parseInt(process.env.WA_RATE_LIMIT_PER_MINUTE) || 10;
const DAILY_LIMIT_PER_DEVICE = parseInt(process.env.WA_DAILY_LIMIT_PER_DEVICE) || 200;

function canSend(deviceId) {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  const oneDayAgo = now - 86400000;

  if (!deviceMessageTimestamps.has(deviceId)) {
    deviceMessageTimestamps.set(deviceId, []);
  }

  const timestamps = deviceMessageTimestamps.get(deviceId);
  const recentMinute = timestamps.filter(t => t > oneMinuteAgo);
  const recentDay = timestamps.filter(t => t > oneDayAgo);

  deviceMessageTimestamps.set(deviceId, recentDay);

  return recentMinute.length < RATE_LIMIT_PER_MINUTE && recentDay.length < DAILY_LIMIT_PER_DEVICE;
}

function markSent(deviceId) {
  if (!deviceMessageTimestamps.has(deviceId)) {
    deviceMessageTimestamps.set(deviceId, []);
  }
  deviceMessageTimestamps.get(deviceId).push(Date.now());
}

module.exports = { canSend, markSent };