'use strict';

// A small request/response + event protocol over anything that carries
// messages: the library worker's parent port (main ↔ worker) and the
// MessagePorts between each window and the worker. Loaded by Node
// (require) and by the pages (<script>, as window.Rpc).
//
//   { t: 'req', id, m, a }                  call method m with args a
//   { t: 'res', id, v } / { t: 'res', id, err: { message, code } }
//   { t: 'evt', ch, a }                     an event, no reply
(function (root) {
  // The calling side. Calls made while disconnected wait; connect() sends
  // them, and re-sends anything still unanswered from a previous connection
  // — use it only for calls that are safe to repeat — unless the caller
  // chose to fail them instead (fail()).
  function createClient() {
    let send = null;
    let seq = 0;
    const pending = new Map(); // id -> { msg, resolve, reject }
    const listeners = new Map(); // channel -> Set of callbacks

    function emit(ch, args) {
      for (const cb of listeners.get(ch) || []) {
        try {
          cb(...args);
        } catch (err) {
          console.error(`rpc: ${ch} listener failed:`, err);
        }
      }
    }

    return {
      connect(fn) {
        send = fn;
        for (const p of pending.values()) send(p.msg);
      },
      disconnect() {
        send = null;
      },
      // Reject everything unanswered (e.g. the other side died mid-call).
      fail(message) {
        for (const p of pending.values()) p.reject(new Error(message));
        pending.clear();
      },
      call(m, ...a) {
        return new Promise((resolve, reject) => {
          const msg = { t: 'req', id: ++seq, m, a };
          pending.set(msg.id, { msg, resolve, reject });
          if (send) send(msg);
        });
      },
      receive(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'res') {
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          if (msg.err) {
            const err = new Error(msg.err.message);
            if (msg.err.code) err.code = msg.err.code;
            p.reject(err);
          } else p.resolve(msg.v);
        } else if (msg.t === 'evt') emit(msg.ch, msg.a || []);
      },
      on(ch, cb) {
        if (!listeners.has(ch)) listeners.set(ch, new Set());
        listeners.get(ch).add(cb);
        return () => listeners.get(ch).delete(cb);
      },
      emit: (ch, ...args) => emit(ch, args),
      pendingCount: () => pending.size,
    };
  }

  // The answering side: handle(msg, ctx) runs handlers[m](...a, ctx) and
  // replies through reply(). Anything that isn't a request is ignored.
  function createServer(handlers) {
    return async function handle(msg, reply, ctx) {
      if (!msg || msg.t !== 'req') return;
      const fn = Object.prototype.hasOwnProperty.call(handlers, msg.m) ? handlers[msg.m] : null;
      try {
        if (typeof fn !== 'function') throw new Error(`unknown method ${msg.m}`);
        const v = await fn(...(msg.a || []), ctx);
        reply({ t: 'res', id: msg.id, v });
      } catch (err) {
        reply({ t: 'res', id: msg.id, err: { message: String(err && err.message ? err.message : err), code: err && err.code } });
      }
    };
  }

  const event = (ch, ...a) => ({ t: 'evt', ch, a });

  const api = { createClient, createServer, event };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Rpc = api;
})(typeof window !== 'undefined' ? window : globalThis);
