const test = require('node:test');
const assert = require('node:assert');
const { MessageChannel } = require('node:worker_threads');
const Rpc = require('../src/shared/rpc');
const { restartDelay } = require('../src/main/library');

// A client and a server joined by a real MessageChannel, as a window and the
// library worker are.
function pair(handlers) {
  const { port1, port2 } = new MessageChannel();
  const client = Rpc.createClient();
  const handle = Rpc.createServer(handlers);
  port2.on('message', (msg) => handle(msg, (reply) => port2.postMessage(reply), { owner: 1 }));
  port1.on('message', (msg) => client.receive(msg));
  client.connect((msg) => port1.postMessage(msg));
  return { client, port1, port2, close: () => (port1.close(), port2.close()) };
}

test('rpc: results, thrown errors (with code), unknown methods, ctx', async () => {
  const p = pair({
    add: (a, b) => a + b,
    fail: () => {
      const err = new Error('nope');
      err.code = 'ENOPE';
      throw err;
    },
    who: (ctx) => ctx.owner,
  });
  assert.strictEqual(await p.client.call('add', 2, 3), 5);
  await assert.rejects(p.client.call('fail'), (err) => err.message === 'nope' && err.code === 'ENOPE');
  await assert.rejects(p.client.call('toString'), /unknown method/);
  assert.strictEqual(await p.client.call('who'), 1);
  p.close();
});

test('rpc: events reach every listener; unsubscribe works', () => {
  const client = Rpc.createClient();
  const got = [];
  const off = client.on('library:changed', (c) => got.push(['a', c]));
  client.on('library:changed', (c) => got.push(['b', c]));
  client.receive(Rpc.event('library:changed', 1));
  off();
  client.receive(Rpc.event('library:changed', 2));
  client.receive(Rpc.event('other', 3));
  assert.deepStrictEqual(got, [['a', 1], ['b', 1], ['b', 2]]);
});

test('rpc: calls wait while disconnected, and unanswered ones are re-sent on reconnect', async () => {
  const client = Rpc.createClient();
  const sent = [];
  const answer = (msg) => client.receive({ t: 'res', id: msg.id, v: msg.m + ':' + sent.length });

  const early = client.call('listTags'); // no connection yet
  client.connect((msg) => sent.push(msg)); // a connection that never answers (the worker dies)
  assert.deepStrictEqual(sent.map((m) => m.m), ['listTags']);
  const second = client.call('listDirs');

  client.disconnect();
  const whileDown = client.call('listFolders');
  assert.strictEqual(sent.length, 2);

  // New worker: everything unanswered goes again, in order, and is answered once.
  const resent = [];
  client.connect((msg) => {
    resent.push(msg.m);
    answer(msg);
  });
  assert.deepStrictEqual(resent, ['listTags', 'listDirs', 'listFolders']);
  assert.deepStrictEqual(await Promise.all([early, second, whileDown]), ['listTags:2', 'listDirs:2', 'listFolders:2']);
  assert.strictEqual(client.pendingCount(), 0);
  // A late answer from the dead connection is ignored.
  client.receive({ t: 'res', id: 1, v: 'stale' });
});

test('rpc: fail() rejects everything unanswered', async () => {
  const client = Rpc.createClient();
  client.connect(() => {});
  const a = client.call('addFolderPath', '/x');
  client.fail('the library worker stopped');
  await assert.rejects(a, /worker stopped/);
  assert.strictEqual(client.pendingCount(), 0);
});

test('worker restarts back off, doubling up to 30 s', () => {
  assert.deepStrictEqual([1, 2, 3, 4].map(restartDelay), [250, 500, 1000, 2000]);
  assert.strictEqual(restartDelay(20), 30e3);
});
