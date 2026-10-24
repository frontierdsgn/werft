// Failed sign-ins slow down. Each attempt counts against the account and the client's address (or,
// from a browser that signed in to the account before, against that browser's device token only),
// before the password is checked, so parallel guesses count too; a successful sign-in clears the
// count of the account or device. After FREE[kind] attempts the next one waits 1 minute, then 2, 4, 8, at most 15; an hour
// without attempts forgets them. Unknown accounts count like known ones, so the replies do not
// reveal which e-mails exist.
//
// The counts live in this process (one Workers isolate on Cloudflare) and, when a shared store is
// given, also there: { get(key), put(key, value, ttlSeconds), delete(key) }, e.g. Cloudflare KV. A
// failing shared store (a used-up quota) leaves the counts of this process.

const FREE = { account: 5, device: 5, address: 20, session: 5, reset: 3 };
const MAX_WAIT = 15 * 60 * 1000;
const FORGET = 60 * 60 * 1000;
// Requests for new-password e-mails are forgotten after a day, so the hour-long wait holds.
const KEEP = { reset: 24 * 60 * 60 * 1000 };
const MAX_KEYS = 10000;

const encoder = new TextEncoder();
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

// The waiting time after `count` attempts: from 1 minute, doubling, at most 15; for e-mails with a
// new-password link from 15 minutes to at most an hour, so an address gets about 25 a day.
const WAITS = { reset: [15 * 60 * 1000, 60 * 60 * 1000] };
export const waitAfter = (kind, count) => {
  const [first, max] = WAITS[kind] ?? [60 * 1000, MAX_WAIT];
  return count < FREE[kind] ? 0 : Math.min(first * 2 ** (count - FREE[kind]), max);
};

// An address as the throttle counts it: IPv4 as it is, IPv6 by its /64 network, which one
// connection usually has to itself.
export function addressKey(address) {
  let a = String(address ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!a) return null;
  const v4 = a.match(/^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) return v4[1];
  if (!a.includes(':')) return a;
  const [head, tail] = a.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export function throttle({ secret, now, store, maxKeys = MAX_KEYS }) {
  const local = new Map();
  const hashed = async (key) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(`${secret}\n${key}`))).slice(0, 32);
  const fresh = (record, t) => (record && (t - record.last < (record.keep ?? FORGET) || record.until > t) ? record : null);
  const newer = (a, b) => ((a?.last ?? 0) >= (b?.last ?? 0) ? a : b);
  let warned = false;
  const shared = async (operation, ...args) => {
    if (!store) return null;
    try { return await store[operation](...args); } catch (error) {
      if (!warned) console.error('werft throttle store (counting in this process only):', error.message);
      warned = true;
      return null;
    }
  };

  // Beyond maxKeys counts, the oldest go first: forgotten ones, then single attempts, then counts
  // not in a wait, and only when all are in a wait any; never those of the attempt being counted.
  // So a flood of new e-mails or addresses does not wipe the count of an account under attack.
  function evict(t, keep) {
    for (const spare of [(r) => !fresh(r, t), (r) => r.count === 1 && r.until <= t, (r) => r.until <= t, () => true]) {
      for (const [id, record] of local) {
        if (local.size <= maxKeys) return;
        if (!keep.includes(id) && spare(record)) local.delete(id);
      }
    }
  }

  // keys: [[kind, value], …]. Counts the attempt in this process and returns { wait: 0, failed(),
  // succeeded(), cancel() }, or { wait } with the milliseconds until the next attempt may be made.
  // Only a failure is written to the shared store, and a success deletes only what is there, so a
  // sign-in costs the store reads only. A success clears the account's or device's count; the
  // address keeps its failures, so signing in to one's own account does not reset the guesses at
  // others.
  async function attempt(keys) {
    const ids = await Promise.all(keys.map(([kind, value]) => hashed(`${kind}:${value}`)));
    const remote = await Promise.all(ids.map((id) => shared('get', id)));
    // From here to the end of the counting there is no await, so attempts in this process count
    // one after the other.
    const t = now();
    const records = ids.map((id, i) => fresh(newer(local.get(id), remote[i]), t));
    const wait = Math.max(0, ...records.map((r) => (r ? r.until - t : 0)));
    if (wait > 0) return { wait };
    const next = records.map((r, i) => {
      const count = (r?.count ?? 0) + 1;
      return { count, last: t, until: t + waitAfter(keys[i][0], count), ...(KEEP[keys[i][0]] && { keep: KEEP[keys[i][0]] }) };
    });
    ids.forEach((id, i) => { local.delete(id); local.set(id, next[i]); });
    evict(t, ids);
    // Takes this attempt back: the record before it, or, when other attempts came since, one less
    // with their time and the wait for that count.
    const undo = (id, i) => {
      const current = local.get(id);
      if (current === next[i]) { local.delete(id); if (records[i]) local.set(id, records[i]); return; }
      if (current) local.set(id, { ...current, count: Math.max(0, current.count - 1), until: current.last + waitAfter(keys[i][0], Math.max(0, current.count - 1)) });
    };
    return {
      wait: 0,
      // The attempt was not decided (the users could not be read): it does not count.
      cancel: () => ids.forEach((id, i) => undo(id, i)),
      // Writes the newest count of this process, which parallel attempts may have raised.
      failed: () => Promise.all(ids.map((id, i) => {
        const record = local.get(id) ?? next[i];
        return shared('put', id, record, Math.ceil((record.until - now() + (record.keep ?? FORGET)) / 1000));
      })),
      succeeded: () => {
        // The address keeps its failures; the success itself does not count.
        ids.forEach((id, i) => (keys[i][0] === 'address' ? undo(id, i) : local.delete(id)));
        return Promise.all(ids.filter((id, i) => keys[i][0] !== 'address' && remote[i]).map((id) => shared('delete', id)));
      },
    };
  }

  return { attempt };
}
