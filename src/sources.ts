import { readFileSync } from 'node:fs';

export interface Source {
  name: string;
  shareUrl: string;
  tab: string;
}

export function parseSources(json: string): Source[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('watchlist-sources: file is not valid JSON');
  }
  if (!Array.isArray(data)) throw new Error('watchlist-sources: must be a JSON array');
  const seen = new Set<string>();
  return data.map((row, i) => {
    const r = row as Record<string, unknown>;
    for (const key of ['name', 'shareUrl', 'tab'] as const) {
      if (typeof r[key] !== 'string' || !(r[key] as string).trim()) {
        throw new Error(`watchlist-sources[${i}]: "${key}" must be a non-empty string`);
      }
    }
    const tab = (r.tab as string).trim();
    if (seen.has(tab)) throw new Error(`watchlist-sources: duplicate tab "${tab}"`);
    seen.add(tab);
    return { name: (r.name as string).trim(), shareUrl: (r.shareUrl as string).trim(), tab };
  });
}

export function loadSources(path = 'watchlist-sources.json'): Source[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `watchlist-sources: cannot read "${path}". Copy watchlist-sources.example.json and fill it in.`
    );
  }
  return parseSources(raw);
}
