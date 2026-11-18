import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { parseHyperDeck, testHyperDeck, testObs, obsAuth } from '../server/media.js';

test('parses HyperDeck single- and multi-line responses, keeps partial tail', () => {
  const text = '500 connection info:\r\nprotocol version: 1.11\r\nmodel: HyperDeck Studio HD Plus\r\n\r\n200 ok\r\n208 transport info:\r\nstatus: record\r\ntimecode: 00:12:34:05\r\n\r\n208 transport info:\r\nstatus: st';
  const { responses, rest } = parseHyperDeck(text);
  assert.deepEqual(responses.map((r) => r.code), [500, 200, 208]);
  assert.equal(responses[0].fields.model, 'HyperDeck Studio HD Plus');
  assert.equal(responses[2].fields.status, 'record');
  assert.equal(responses[2].fields.timecode, '00:12:34:05');
  assert.ok(rest.startsWith('208 transport info:'));
});

test('talks to a (fake) HyperDeck over TCP', async () => {
  const server = net.createServer((sock) => {
    sock.write('500 connection info:\r\nprotocol version: 1.11\r\nmodel: Fake HyperDeck\r\n\r\n');
    sock.on('data', (d) => {
      if (String(d).startsWith('transport info')) sock.write('208 transport info:\r\nstatus: record\r\nspeed: 0\r\ndisplay timecode: 01:02:03:04\r\ntimecode: 01:02:03:04\r\n\r\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const res = await testHyperDeck({ host: '127.0.0.1', port: server.address().port });
  server.close();
  assert.deepEqual(res, { ok: true, model: 'Fake HyperDeck', status: 'record', timecode: '01:02:03:04' });
});

function fakeObs(password) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const salt = 'saltsalt', challenge = crypto.randomBytes(8).toString('hex');
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1, ...(password ? { authentication: { salt, challenge } } : {}) } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.op === 1) {
        if (password && msg.d.authentication !== obsAuth(password, salt, challenge)) return ws.close(4009);
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      }
      if (msg.op === 6) ws.send(JSON.stringify({ op: 7, d: { requestType: msg.d.requestType, requestId: msg.d.requestId, requestStatus: { result: true, code: 100 }, responseData: { obsVersion: '31.0.0' } } }));
    });
  });
  return new Promise((r) => wss.on('listening', () => r(wss)));
}

test('connects to (fake) OBS with a password', async () => {
  const wss = await fakeObs('secret');
  const res = await testObs({ host: '127.0.0.1', port: wss.address().port, password: 'secret' });
  wss.close();
  assert.deepEqual(res, { ok: true, obsVersion: '31.0.0' });
});

test('reports a wrong OBS password clearly', async () => {
  const wss = await fakeObs('secret');
  await assert.rejects(testObs({ host: '127.0.0.1', port: wss.address().port, password: 'nope' }), /rejected the password/);
  await assert.rejects(testObs({ host: '127.0.0.1', port: wss.address().port, password: '' }), /requires a password/);
  wss.close();
});
