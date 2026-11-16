import { randomBytes, randomInt } from 'node:crypto';

const ttl = 7200;
const cas = 'if redis.call("GET",KEYS[1]) == ARGV[1] then redis.call("SET",KEYS[1],ARGV[2],"EX",ARGV[3]); return 1 end; return 0';
const token = () => randomBytes(24).toString('hex');

async function redis(...command) {
  const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: secret } = process.env;
  if (!url || !secret) throw new Error('missing config');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(5000)
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error('storage unavailable');
  return data.result;
}

function schedule(room, now) {
  const first = now + randomInt(3800, 6200);
  room.fakeAt = randomInt(10) < 4 ? first : null;
  room.goAt = room.fakeAt ? first + randomInt(900, 2100) : first;
}

function view(room, player, now) {
  const phase = room.players.length < 2 ? 'lobby'
    : room.scores.includes(5) ? 'end'
    : room.last && now < room.last.at + 1450 ? 'break' 
    : now < room.goAt ? (room.fakeAt && now >= room.fakeAt ? 'fake' : 'wait') : 'go';
  return { player, phase, scores: room.scores, last: room.last };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Chỉ hỗ trợ POST.' });
  const { action, code, secret } = req.body ?? {};
  try {
    if (action === 'create') {
      for (let i = 0; i < 4; i++) {
        const code = randomBytes(4).toString('hex').toUpperCase();
        const secret = token();
        const room = { players: [secret], scores: [0, 0], last: null };
        if (await redis('SET', 'bao:' + code, JSON.stringify(room), 'EX', ttl, 'NX')) {
          return res.status(200).json({ code, secret, ...view(room, 0, Date.now()) });
        }
      }
      return res.status(503).json({ error: 'Chưa tạo được phòng. Thử lại nhé.' });
    }
    if (!['join', 'state', 'grab', 'restart'].includes(action) || typeof code !== 'string' || !/^[A-F0-9]{8}$/.test(code)) {
      return res.status(400).json({ error: 'Mã phòng gồm 8 ký tự từ 0–9 và A–F.' });
    }
    const key = 'bao:' + code;
    for (let i = 0; i < 5; i++) {
      const raw = await redis('GET', key);
      if (!raw) return res.status(404).json({ error: 'Phòng đã hết hạn hoặc mã phòng sai.' });
      const room = JSON.parse(raw);
      const now = Date.now();
      let player = room.players.indexOf(secret);
      let issued;
      if (action === 'join' && player < 0) {
        if (room.players.length >= 2) return res.status(409).json({ error: 'Phòng đã đủ 2 người.' });
        issued = token();
        room.players.push(issued);
        player = 1;
        schedule(room, now);
      } else {
        if (player < 0) return res.status(403).json({ error: 'Bạn chưa vào phòng.' });
        const current = view(room, player, now);
        if (action === 'restart' && current.phase === 'end') {
          room.scores = [0, 0];
          room.last = null;
          schedule(room, now);
        } else if (action === 'grab' && ['wait', 'fake', 'go'].includes(current.phase)
          && (!room.last || now >= room.last.at + 1450)) {
          const good = current.phase === 'go';
          room.scores[good ? player : 1 - player]++;
          room.last = { at: now, player, good };
          if (!room.scores.includes(5)) schedule(room, now);
        } else {
          return res.status(200).json(current);
        }
      }
      if (await redis('EVAL', cas, 1, key, raw, JSON.stringify(room), ttl)) {
        return res.status(200).json({ ...view(room, player, now), ...(issued ? { secret: issued } : {}) });
      }
      if (action === 'grab' || action === 'restart') {
        const latest = await redis('GET', key);
        if (!latest) return res.status(404).json({ error: 'Phòng đã hết hạn.' });
        return res.status(200).json(view(JSON.parse(latest), player, Date.now()));
      }
    }
    return res.status(503).json({ error: 'Phòng đang bận. Thử lại nhé.' });
  } catch {
    return res.status(503).json({ error: 'Không kết nối được Redis. Kiểm tra cấu hình Vercel.' });
  }
}

