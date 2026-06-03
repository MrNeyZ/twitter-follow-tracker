// Standalone smoke test for DB + scoring + diff logic. No network, no real keys.
const fs = require('fs');
const { Db } = require('./dist/db');
const { scoreUser } = require('./dist/scoring');

const DB = './data/smoke.db';
for (const f of [DB, DB + '-wal', DB + '-shm', DB + '-journal']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const db = new Db(DB);
const inf = { username: 'whale', label: 'Whale' };
const influencerId = '1000';
db.upsertWatchedAccount(influencerId, inf);

const u = (id, name, opts = {}) => ({
  id,
  username: name,
  displayName: name,
  followersCount: opts.followers ?? 1000,
  verified: opts.verified ?? false,
  bio: opts.bio ?? '',
});

function diffAndAlert(following, t) {
  if (!db.hasBaseline(influencerId)) {
    db.replaceFollowingSnapshot(influencerId, following, t);
    db.markBaselineDone(influencerId);
    return { baseline: true, alerts: [] };
  }
  const known = db.getCurrentFollowingIds(influencerId);
  const newly = following.filter((x) => !known.has(x.id));
  db.addToFollowingSnapshot(influencerId, newly, t);
  const alerts = [];
  for (const f of newly) {
    const score = scoreUser(f);
    if (db.insertFollowEvent(influencerId, f, score, t)) {
      db.markEventAlerted(influencerId, f.id);
      alerts.push({ user: f.username, score: score.score, kw: score.matchedKeywords });
    }
  }
  return { baseline: false, alerts };
}

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok  -', msg);
};

// Run 1: baseline, no alerts.
const r1 = diffAndAlert([u('1', 'alice'), u('2', 'bob')], 't1');
assert(r1.baseline === true && r1.alerts.length === 0, 'run1 saves baseline, no alerts');

// Run 2: one genuinely new follow -> 1 alert.
const r2 = diffAndAlert(
  [u('1', 'alice'), u('2', 'bob'), u('3', 'carol', { verified: true, followers: 50000, bio: 'solana defi degen' })],
  't2'
);
assert(r2.alerts.length === 1 && r2.alerts[0].user === 'carol', 'run2 detects exactly one new follow (carol)');
assert(r2.alerts[0].kw.includes('solana') && r2.alerts[0].kw.includes('defi'), 'run2 scores carol bio keywords solana+defi');

// Run 3: same list again -> no new alerts (dedup).
const r3 = diffAndAlert(
  [u('1', 'alice'), u('2', 'bob'), u('3', 'carol', { verified: true, followers: 50000, bio: 'solana defi degen' })],
  't3'
);
assert(r3.alerts.length === 0, 'run3 same list -> no duplicate alerts');

// Run 4: carol reappears as "new" id-wise? No. Add dave; ensure carol not realerted even if removed+readded.
const r4 = diffAndAlert([u('3', 'carol'), u('4', 'dave')], 't4');
assert(r4.alerts.length === 1 && r4.alerts[0].user === 'dave', 'run4 only dave alerts; carol not re-alerted');

// Keyword boundary: "ai" should not match inside "chain"; should match standalone.
const { matchKeywords } = require('./dist/scoring');
assert(matchKeywords('building on chain').length === 0, 'keyword "ai" does not match inside "chain"');
assert(matchKeywords('ai + web3 builder').includes('ai') && matchKeywords('ai + web3 builder').includes('web3'), 'keyword matches standalone ai and web3');

db.close();
for (const f of [DB, DB + '-wal', DB + '-shm', DB + '-journal']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
console.log('\nSmoke test complete.');
