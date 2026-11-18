const { createHash } = require('node:crypto');
const webPush = require('web-push');

const subscriptions = 'ruangsemester:reminders';
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
});

function dateInJakarta(time) {
  const parts = Object.fromEntries(dateFormat.formatToParts(time).map(({ type, value }) => [type, value]));
  return [parts.year, parts.month, parts.day].join('-');
}

function validSubscription(value) {
  try {
    const url = new URL(value.endpoint);
    const host = url.hostname;
    const allowed = ['fcm.googleapis.com', 'updates.push.services.mozilla.com'].includes(host)
      || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com');
    return typeof value.endpoint === 'string' && value.endpoint.length <= 2048
      && allowed && url.protocol === 'https:' && !url.port && !url.username && !url.password
      && !url.hash && typeof value.keys?.p256dh === 'string' && /^[\w-]{87}$/.test(value.keys.p256dh)
      && typeof value.keys?.auth === 'string' && /^[\w-]{22}$/.test(value.keys.auth);
  } catch {
    return false;
  }
}

async function redis(...command) {
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.UPSTASH_REDIS_REST_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Redis HTTP ' + response.status);
  const data = await response.json();
  if (data.error) throw new Error('Redis command failed');
  return data.result;
}

async function sendReminders() {
  const now = Date.now();
  const today = dateInJakarta(now);
  const tomorrow = dateInJakarta(now + 86400000);
  const vapidDetails = {
    subject: 'https://ruang-semester.vercel.app',
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY
  };
  let cursor = '0';
  let sent = 0;
  let failed = 0;
  do {
    const [next, fields] = await redis('HSCAN', subscriptions, cursor, 'COUNT', 50);
    cursor = String(next);
    for (let index = 0; index < fields.length; index += 2) {
      const token = fields[index];
      const stored = fields[index + 1];
      const { subscription, tasks } = JSON.parse(stored);
      const due = tasks.filter(task => task.due === tomorrow);
      if (!tasks.some(task => task.due > today)) {
        await redis('EVAL', "if redis.call('HGET',KEYS[1],ARGV[1])==ARGV[2] then return redis.call('HDEL',KEYS[1],ARGV[1]) end", 1, subscriptions, token, stored);
        continue;
      }
      if (!due.length || !validSubscription(subscription)) continue;
      const lock = 'ruangsemester:sent:' + token + ':' + today;
      const claimed = await redis('EVAL', "if redis.call('HGET',KEYS[1],ARGV[1])==ARGV[2] then return redis.call('SET',KEYS[2],'1','NX','EX',172800) end", 2, subscriptions, lock, token, stored);
      if (!claimed) continue;
      const body = due[0].title + (due.length > 1 ? ' dan ' + (due.length - 1) + ' tugas lainnya' : '');
      try {
        await webPush.sendNotification(subscription, JSON.stringify({ title: 'Tugas jatuh tempo besok', body }), {
          vapidDetails, TTL: 21600, timeout: 8000, topic: 'ruangsemester-h1'
        });
        sent++;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await redis('EVAL', "if redis.call('HGET',KEYS[1],ARGV[1])==ARGV[2] then return redis.call('HDEL',KEYS[1],ARGV[1]) end", 1, subscriptions, token, stored);
        } else {
          await redis('DEL', lock);
          failed++;
        }
      }
    }
  } while (cursor !== '0');
  return { sent, failed };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'CRON_SECRET'].every(name => process.env[name])) {
    return res.status(503).json({ error: 'Notifikasi belum dikonfigurasi oleh pengelola.' });
  }
    try {
    if (req.query?.cron === '1') {
      if (req.method !== 'GET' || req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET) {
        return res.status(401).json({ error: 'Akses ditolak.' });
      }
      return res.status(200).json(await sendReminders());
    }
    if (req.method === 'GET') return res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Akses ditolak.' });
    if (!['PUT', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'Metode tidak didukung.' });
    const token = req.headers['x-reminder-token'];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'Perangkat tidak valid.' });
    const key = createHash('sha256').update(token).digest('hex');
    if (req.method === 'DELETE') {
      await redis('HDEL', subscriptions, key);
      return res.status(200).json({ ok: true });
    }
    const { subscription, tasks } = req.body ?? {};
    if (!validSubscription(subscription) || !Array.isArray(tasks) || tasks.length > 1000 ||
      tasks.some(task => typeof task?.title !== 'string' || !task.title.trim() || task.title.length > 120 ||
        typeof task.due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(task.due))) {
      return res.status(400).json({ error: 'Data pengingat tidak valid.' });
    }
    const pending = tasks.filter(task => task.due > dateInJakarta(Date.now()));
    if (!pending.length) await redis('HDEL', subscriptions, key);
    else await redis('HSET', subscriptions, key, JSON.stringify({
      subscription: { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } },
      tasks: pending.map(({ title, due }) => ({ title, due }))
    }));
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(503).json({ error: 'Sinkronisasi pengingat gagal. Coba lagi.' });
  }
};
