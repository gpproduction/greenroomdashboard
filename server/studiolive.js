// PreSonus StudioLive (Series III, e.g. the 64S) channel naming over UCNet (TCP 53000).
//
// Only the small part of the protocol needed to read and set scribble-strip names is
// implemented here. The packet format, handshake and state decoding are ported from
// presonus-studiolive-api (MIT, (c) 2019-2026 Andrew Wong "featherbear"; fork by
// Branson Matheson "sandinak"): https://github.com/featherbear/presonus-studiolive-api
//
// This is not an official PreSonus API. Names are the only thing this module ever writes.
import net from 'node:net';
import zlib from 'node:zlib';

export const DEFAULT_PORT = 53000;
const HEADER = Buffer.from([0x55, 0x43, 0x00, 0x01]); // "UC\0\1"
const CBYTES = Buffer.from([0x68, 0x00, 0x65, 0x00]);

// ---- packets --------------------------------------------------------------------------

/** UC header + LE16 length + 2-char code + connection bytes + payload. */
export function packet(code, data = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(code, 'ascii'), CBYTES, data]);
  const len = Buffer.alloc(2);
  len.writeUInt16LE(body.length);
  return Buffer.concat([HEADER, len, body]);
}

/** JSON payloads carry a LE16 length and two zero bytes first. */
export function jsonPayload(obj) {
  const json = Buffer.from(JSON.stringify(obj, null, ' '));
  const len = Buffer.alloc(4);
  len.writeUInt16LE(json.length);
  return Buffer.concat([len, json]);
}

/** "PS" (parameter string): key, NUL + 2 pad bytes, the text, NUL. Used for channel names. */
export function stringPayload(key, value) {
  return Buffer.concat([Buffer.from(`${key}\x00\x00\x00`, 'ascii'), Buffer.from(value, 'ascii'), Buffer.from([0])]);
}

/** Split a TCP byte stream into whole packets: returns [packets, leftover]. */
export function frame(buffer) {
  const out = [];
  let buf = buffer;
  for (;;) {
    if (buf.length < 6) break;
    if (buf.compare(HEADER, 0, 4, 0, 4) !== 0) {
      const next = buf.indexOf(HEADER, 1);
      if (next === -1) { buf = buf.subarray(Math.max(0, buf.length - 3)); break; }
      buf = buf.subarray(next);
      continue;
    }
    const total = 6 + buf.readUInt16LE(4);
    if (buf.length < total) break;
    const p = buf.subarray(0, total);
    out.push({ code: p.subarray(6, 8).toString('ascii'), data: p.subarray(12) });
    buf = buf.subarray(total);
  }
  return [out, buf];
}

// ---- state (zlib + partial UBJSON) ------------------------------------------------------

/** Partial UBJSON decoder, as the console uses it (int8 key lengths, typed values). */
export function decodeUbjson(buf) {
  let i = 0;
  if (buf[i++] !== 0x7b) return null;
  const root = {};
  const stack = [root];
  while (i < buf.length) {
    let key = null;
    if (Array.isArray(stack[0])) {
      if (buf[i] === 0x5d) { i += 1; stack.shift(); continue; }
    } else {
      const c = buf[i++];
      if (c === 0x7d) { stack.shift(); continue; }
      if (c !== 0x69) throw new Error(`Unexpected UBJSON byte ${c} at ${i}`);
      const n = buf[i++];
      key = buf.subarray(i, i + n).toString();
      i += n;
    }
    const put = (v) => { if (Array.isArray(stack[0])) stack[0].push(v); else stack[0][key] = v; };
    const t = buf[i++];
    if (t === 0x7b || t === 0x5b) { const leaf = t === 0x7b ? {} : []; put(leaf); stack.unshift(leaf); continue; }
    let v;
    switch (t) {
      case 0x53: { if (buf[i++] !== 0x69) throw new Error('Unexpected string length type'); const n = buf[i++]; v = buf.subarray(i, i + n).toString(); i += n; break; }
      case 0x64: v = buf.readFloatBE(i); i += 4; break;
      case 0x69: v = buf.readInt8(i); i += 1; break;
      case 0x55: v = buf.readUInt8(i); i += 1; break;
      case 0x6c: v = buf.readInt32BE(i); i += 4; break;
      case 0x4c: v = Number(buf.readBigInt64BE(i)); i += 8; break;
      default: throw new Error(`Unknown UBJSON type ${t} at ${i}`);
    }
    put(v);
  }
  return root;
}

/** Channel names from the console's "Synchronize" state: { line: {1:'Kick',…}, aux: {1:'Mix 1',…} }. */
export function namesFromState(sync) {
  const out = { line: {}, aux: {} };
  for (const kind of ['line', 'aux']) {
    const chans = sync?.children?.[kind]?.children || {};
    for (const [k, node] of Object.entries(chans)) {
      const m = /^ch(\d+)$/.exec(k);
      if (m) out[kind][Number(m[1])] = node?.values?.username ?? '';
    }
  }
  return out;
}

// ---- connection -------------------------------------------------------------------------

/**
 * Connect, subscribe and wait for the console's state. Resolves with
 * { names, setName(kind, ch, name), close() }.
 */
export function open(host, port = DEFAULT_PORT, { timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let pending = Buffer.alloc(0);
    let chunks = [];
    let state = null;
    let subscribed = false;
    let done = false;
    const fail = (err) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); reject(err); };
    const timer = setTimeout(() => fail(new Error(`The mixer at ${host} didn't answer (is it on and on the same network?)`)), timeout);
    const ready = () => {
      if (done || !state || !subscribed) return;
      done = true;
      clearTimeout(timer);
      const names = namesFromState(state);
      resolve({
        names,
        setName(kind, ch, name) {
          sock.write(packet('PS', stringPayload(`${kind}/ch${ch}/username`, name)));
          names[kind][ch] = name;
        },
        close() { return new Promise((r) => { setTimeout(() => { sock.end(); sock.destroy(); r(); }, 400); }); }, // let writes flush
      });
    };
    sock.on('connect', () => {
      sock.write(packet('JM', jsonPayload({
        id: 'Subscribe',
        clientName: 'UC-Surface',
        clientInternalName: 'ucremoteapp',
        clientType: 'StudioLive API',
        clientDescription: 'GrowPoint Backstage',
        clientIdentifier: 'growpoint-backstage',
        clientOptions: 'perm users levl redu rtan',
        clientEncoding: 23106,
      })));
    });
    sock.on('data', (bytes) => {
      let packets;
      [packets, pending] = frame(Buffer.concat([pending, bytes]));
      for (const p of packets) {
        try {
          if (p.code === 'JM') {
            const msg = JSON.parse(p.data.subarray(4).toString());
            if (msg.id === 'SubscriptionReply') subscribed = true;
          } else if (p.code === 'ZB') {
            state = decodeUbjson(zlib.inflateSync(p.data.subarray(4)));
          } else if (p.code === 'CK') {
            const d = p.data.subarray(4);
            const offset = d.readUInt32LE(0), total = d.readUInt32LE(4), size = d.readUInt32LE(8);
            chunks.push(d.subarray(12));
            if (offset + size === total) { state = decodeUbjson(zlib.inflateSync(Buffer.concat(chunks))); chunks = []; }
          }
        } catch (err) {
          return fail(new Error(`Couldn't read the mixer's reply: ${err.message}`));
        }
      }
      ready();
    });
    sock.on('error', (err) => fail(new Error(err.code === 'ECONNREFUSED' ? `The mixer at ${host} refused the connection` : err.message)));
    sock.on('close', () => fail(new Error('The mixer closed the connection')));
  });
}

// ---- names ----------------------------------------------------------------------------

/** Plain ASCII for the scribble strips (é → e, smart quotes → straight). */
export function asciiName(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e]/g, '').trim();
}

/**
 * What each mixer channel should be called for this plan.
 * Mics (and "other" devices) name a clean channel ("Alex") and a tuned channel ("T. Alex");
 * IEMs name their aux mix ("IEM 1 - Alex"). Unassigned channels go back to the device name.
 * people: [{ name, short, mic, iem, other }] (device ids); returns [{ kind, ch, name, device, person, role }].
 */
export function planNames(people, devices, { maxLength = 0 } = {}) {
  const firstOf = (p) => asciiName(p.short || String(p.name).split(/\s+/)[0]);
  // Two *different* people who both get a mixer channel and share a first name get a last
  // initial ("Alex R."). Everyone else (no device, or the same person listed on two teams) doesn't count.
  const named = new Set(devices.filter((d) => d.mixerCh || d.mixerChTuned || d.mixerAux).map((d) => d.id));
  const counts = new Map();
  const seen = new Set();
  for (const p of people) {
    const who = String(p.name).trim().toLowerCase();
    if (seen.has(who) || !['mic', 'iem', 'other'].some((f) => p[f] && named.has(p[f]))) continue;
    seen.add(who);
    const k = firstOf(p).toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const label = (p) => {
    const first = firstOf(p);
    if ((counts.get(first.toLowerCase()) || 0) < 2) return first;
    const last = asciiName(String(p.name).trim().split(/\s+/).slice(1).pop() || '');
    return last ? `${first} ${last[0]}.` : first;
  };
  const holder = new Map(); // deviceId -> person
  for (const p of people) for (const f of ['mic', 'iem', 'other']) if (p[f] && !holder.has(p[f])) holder.set(p[f], p);
  const cut = (s) => (maxLength > 0 ? s.slice(0, maxLength).trim() : s);
  const out = [];
  const add = (kind, ch, name, d, p, role) => {
    const n = Number(ch);
    if (!Number.isInteger(n) || n < 1) return;
    out.push({ kind, ch: n, name: cut(name), device: d.name, person: p?.name || null, role });
  };
  for (const d of devices) {
    const p = holder.get(d.id) || null;
    const who = p ? label(p) : null;
    const dev = asciiName(d.name);
    if (d.type === 'mic' || d.type === 'other') {
      if (d.mixerCh) add('line', d.mixerCh, who || dev, d, p, 'clean');
      if (d.mixerChTuned) add('line', d.mixerChTuned, `T. ${who || dev}`, d, p, 'tuned');
    } else if (d.type === 'iem' && d.mixerAux) {
      add('aux', d.mixerAux, who ? `${dev} - ${who}` : dev, d, p, 'aux');
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.ch - b.ch : a.kind === 'line' ? -1 : 1));
}

/**
 * Send names and read them back on a fresh connection to confirm the console took them.
 * Returns [{ ...entry, before, after, ok }].
 */
export async function sendNames(host, port, entries) {
  const s = await open(host, port);
  const before = structuredClone(s.names);
  for (const e of entries) {
    if (before[e.kind]?.[e.ch] === undefined) continue; // channel doesn't exist on this console
    if (before[e.kind][e.ch] !== e.name) s.setName(e.kind, e.ch, e.name);
  }
  await s.close();
  await new Promise((r) => setTimeout(r, 300));
  const check = await open(host, port);
  const after = check.names;
  await check.close();
  return entries.map((e) => {
    const exists = before[e.kind]?.[e.ch] !== undefined;
    return { ...e, before: exists ? before[e.kind][e.ch] : null, after: exists ? after[e.kind]?.[e.ch] ?? null : null, ok: exists && after[e.kind]?.[e.ch] === e.name, missing: !exists };
  });
}

/** Connection test: channel counts and a few current names. */
export async function test(host, port) {
  const s = await open(host, port);
  await s.close();
  const line = Object.keys(s.names.line).length;
  const aux = Object.keys(s.names.aux).length;
  return { ok: true, line, aux, sample: Object.entries(s.names.line).slice(0, 4).map(([ch, n]) => `${ch}: ${n || '(blank)'}`) };
}
