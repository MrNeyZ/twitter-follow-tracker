import * as fs from 'fs';
import * as path from 'path';
import { renderCard, closeCardBrowser } from '../src/alerts/card';
import { CardModel } from '../src/alerts/card-model';

// Sample data resembling the reference design. Same shape for both cards so the
// only difference is the high/normal styling.
function sample(high: boolean): CardModel {
  return {
    high,
    badge: high ? 'HIGH PRIORITY' : 'NEW FOLLOW',
    timestamp: '3:24 AM',
    watcher: 'cobratate',
    followed: 'aethermind_ai',
    projectName: 'Aethermind',
    tagLine: 'AI AGENT · UNVERIFIED',
    scoreValue: high ? 87 : 62,
    relevance: high ? '94' : '71',
    followers: high ? '128k' : '24k',
    metrics: [],
    chips: high
      ? ['AI agent narrative', 'contract address in bio', 'launchpad token', 'high-signal follower']
      : ['AI agent narrative', 'new project account', 'organic follower'],
    token: high ? { short: '7Ftq…9xQp', url: 'https://solscan.io/token/x' } : null,
    influencerImageUrl: undefined,
    followedImageUrl: undefined,
  };
}

async function main() {
  const tag = process.argv[2] || 'out';
  const outDir = path.resolve(__dirname, '../data/previews');
  fs.mkdirSync(outDir, { recursive: true });
  for (const high of [true, false]) {
    const png = await renderCard(sample(high));
    const name = `${high ? 'high' : 'green'}-${tag}.png`;
    fs.writeFileSync(path.join(outDir, name), png);
    console.log('wrote', path.join(outDir, name), png.length, 'bytes');
  }
  await closeCardBrowser();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
