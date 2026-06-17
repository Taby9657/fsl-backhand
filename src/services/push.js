/**
 * Expo Push Notifications helper
 * Docs: https://docs.expo.dev/push-notifications/sending-notifications-custom/
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * sendPush(tokens, title, body, data?)
 * tokens: string | string[]
 */
async function sendPush(tokens, title, body, data = {}) {
  if (!tokens || (Array.isArray(tokens) && tokens.length === 0)) return;
  const arr = Array.isArray(tokens) ? tokens : [tokens];
  const valid = arr.filter(t => t && t.startsWith('ExponentPushToken['));
  if (valid.length === 0) return;

  const messages = valid.map(to => ({
    to,
    sound: 'default',
    title,
    body,
    data,
    priority: 'high',
  }));

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body:    JSON.stringify(messages),
    });
    if (!res.ok) {
      console.error('Expo push error:', res.status, await res.text());
    }
  } catch (err) {
    console.error('sendPush failed:', err.message);
  }
}

module.exports = { sendPush };
