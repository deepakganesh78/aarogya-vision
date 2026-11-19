import crypto from 'node:crypto';

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

export function createAuth({ accessCodes, sessionSecret, tokenTtlSec }) {
  const codeDigests = accessCodes.map((entry) => ({ entry, digest: digest(entry.code) }));

  function findUserByCode(code) {
    if (typeof code !== 'string' || code.length === 0 || code.length > 200) return null;
    const candidate = digest(code);
    let match = null;
    // Compare against every code so timing does not reveal which entry matched.
    for (const { entry, digest: d } of codeDigests) {
      if (crypto.timingSafeEqual(candidate, d)) match = entry;
    }
    return match ? { id: match.id, name: match.name, role: match.role } : null;
  }

  function issueToken(user, now = Date.now()) {
    const payload = { sub: user.id, name: user.name, role: user.role, exp: Math.floor(now / 1000) + tokenTtlSec };
    const body = b64url(JSON.stringify(payload));
    return `${body}.${hmac(sessionSecret, body)}`;
  }

  function verifyToken(token, now = Date.now()) {
    if (typeof token !== 'string') return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = hmac(sessionSecret, body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!payload.exp || payload.exp * 1000 < now) return null;
    return { id: payload.sub, name: payload.name, role: payload.role };
  }

  function requireRole(role) {
    return (req, res, next) => {
      const header = req.get('authorization') || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      const user = verifyToken(token);
      if (!user) return res.status(401).json({ error: 'unauthorized' });
      if (role && user.role !== role) return res.status(403).json({ error: 'forbidden' });
      req.user = user;
      next();
    };
  }

  return { findUserByCode, issueToken, verifyToken, requireRole };
}
