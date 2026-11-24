// A tiny stand-in for a StudioLive console: answers the UCNet subscribe with its state
// (zlib + UBJSON, optionally split into CK chunks) and applies "PS" channel-name packets.
import net from 'node:net';
import zlib from 'node:zlib';
import { packet, jsonPayload, frame } from '../../server/studiolive.js';

function ub(obj) {
  const parts = [Buffer.from([0x7b])];
  const key = (k) => { const b = Buffer.from(k); return Buffer.concat([Buffer.from([0x69, b.length]), b]); };
  for (const [k, v] of Object.entries(obj)) {
    parts.push(key(k));
    if (v && typeof v === 'object') parts.push(ub(v));
    else if (typeof v === 'number') { const b = Buffer.alloc(5); b[0] = 0x64; b.writeFloatBE(v, 1); parts.push(b); }
    else { const s = Buffer.from(String(v)); parts.push(Buffer.from([0x53, 0x69, s.length]), s); }
  }
  parts.push(Buffer.from([0x7d]));
  return Buffer.concat(parts);
}

export function fakeConsole({ lines = 64, auxes = 32, chunked = false } = {}) {
  const names = { line: {}, aux: {} };
  for (let i = 1; i <= lines; i += 1) names.line[i] = `Ch ${i}`;
  for (let i = 1; i <= auxes; i += 1) names.aux[i] = `Aux ${i}`;
  const writes = [];
  const sync = () => {
    const kids = (kind) => Object.fromEntries(Object.entries(names[kind]).map(([ch, n]) => [`ch${ch}`, { values: { username: n, mute: 0 } }]));
    return { id: 'Synchronize', children: { line: { children: kids('line') }, aux: { children: kids('aux') } } };
  };
  const server = net.createServer((sock) => {
    let pending = Buffer.alloc(0);
    sock.on('data', (bytes) => {
      let ps;
      [ps, pending] = frame(Buffer.concat([pending, bytes]));
      for (const p of ps) {
        if (p.code === 'JM' && JSON.parse(p.data.subarray(4).toString()).id === 'Subscribe') {
          sock.write(packet('JM', jsonPayload({ id: 'SubscriptionReply' })));
          const z = zlib.deflateSync(ub(sync()));
          if (!chunked) sock.write(packet('ZB', Buffer.concat([Buffer.alloc(4), z])));
          else {
            const size = Math.ceil(z.length / 3);
            for (let off = 0; off < z.length; off += size) {
              const part = z.subarray(off, off + size);
              const h = Buffer.alloc(16);
              h.writeUInt32LE(off, 4); h.writeUInt32LE(z.length, 8); h.writeUInt32LE(part.length, 12);
              sock.write(packet('CK', Buffer.concat([h, part])));
            }
          }
        } else if (p.code === 'PS') {
          const d = p.data;
          const nul = d.indexOf(0);
          const key = d.subarray(0, nul).toString();
          const value = d.subarray(nul + 3, d.length - 1).toString();
          writes.push([key, value]);
          const m = /^(line|aux)\/ch(\d+)\/username$/.exec(key);
          if (m) names[m[1]][Number(m[2])] = value;
        }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, names, writes, close: () => new Promise((r) => server.close(r)) })));
}
