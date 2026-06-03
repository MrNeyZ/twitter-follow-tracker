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

// ---------------------------------------------------------------------------
// Project-vs-person classification + alert gating
// ---------------------------------------------------------------------------
const {
  classifyAccount,
  PROJECT_ALERT_THRESHOLD,
  PROJECT_HIGH_SIGNAL_THRESHOLD,
} = require('./dist/scoring');

// Mirror of the worker's alert rule (index.ts) so we test the actual gate.
const decide = (c) => ({
  alert: c.projectScore >= PROJECT_ALERT_THRESHOLD,
  high: c.projectScore >= PROJECT_HIGH_SIGNAL_THRESHOLD,
});

console.log('\n-- classification --');

// Project-like account -> alerts.
const project = u('100', 'jupiterexchange', {
  followers: 60000,
  bio: 'crypto app', // two project keywords + follower band -> normal tier, not high
});
project.displayName = 'Jupiter';
const cProject = classifyAccount(project, { corroborationCount: 0 });
assert(cProject.category === 'project', `project account categorized project (got ${cProject.category}, score=${cProject.projectScore})`);
assert(decide(cProject).alert === true, `project account alerts (score=${cProject.projectScore})`);
assert(decide(cProject).high === false, `project account is normal, not high (score=${cProject.projectScore})`);

// Personal-like account -> does NOT alert.
const personal = u('101', 'johnsmith', {
  followers: 800000,
  bio: 'trader. investor. opinions are my own.',
});
personal.displayName = 'John Smith';
const cPersonal = classifyAccount(personal, { corroborationCount: 0 });
assert(cPersonal.category === 'personal', `personal account categorized personal (got ${cPersonal.category}, score=${cPersonal.projectScore})`);
assert(decide(cPersonal).alert === false, `personal account does not alert (score=${cPersonal.projectScore})`);

// High-signal account -> marked high.
const high = u('102', 'magicprotocol', {
  followers: 90000,
  bio: 'defi protocol app on solana, mainnet live',
});
high.displayName = 'Magic Protocol';
high.url = 'https://example.xyz';
const cHigh = classifyAccount(high, { corroborationCount: 3 });
assert(decide(cHigh).high === true, `strong project account marked HIGH SIGNAL (score=${cHigh.projectScore})`);
assert(cHigh.reasons.some((r) => /watched influencers/.test(r)), 'corroboration reason recorded for high-signal account');

// Low-score event is still saved + deduped (independent of alerting).
const lowScore = scoreUser(personal);
const inserted1 = db.insertFollowEvent('200', personal, lowScore, 't-low');
const inserted2 = db.insertFollowEvent('200', personal, lowScore, 't-low');
assert(inserted1 === true, 'low-score follow event is saved');
assert(inserted2 === false, 'low-score follow event is deduped on second insert');

db.close();
for (const f of [DB, DB + '-wal', DB + '-shm', DB + '-journal']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
console.log('\nSmoke test complete.');
