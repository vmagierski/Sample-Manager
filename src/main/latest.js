// One load at a time per owner (a window), newest wins. A new request aborts
// the one in flight through its AbortSignal — killing its afconvert or file
// read — unless it's for the same sample, which it then shares. A superseded
// load resolves to null, so its bytes are never sent to the page.
function latestWins() {
  const slots = new Map(); // owner -> { id, ctrl, promise }
  return function run(owner, id, load) {
    const cur = slots.get(owner);
    if (cur && cur.id === id) return cur.promise;
    if (cur) cur.ctrl.abort();
    const ctrl = new AbortController();
    const slot = { id, ctrl };
    slot.promise = Promise.resolve()
      .then(() => load(ctrl.signal))
      .then(
        (v) => (ctrl.signal.aborted ? null : v),
        (err) => {
          if (ctrl.signal.aborted) return null;
          throw err;
        },
      )
      .finally(() => {
        if (slots.get(owner) === slot) slots.delete(owner);
      });
    slots.set(owner, slot);
    return slot.promise;
  };
}

module.exports = { latestWins };
