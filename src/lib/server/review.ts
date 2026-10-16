import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { engineDir } from './engine.js';

/**
 * Speaker review batches written by the engine's `review_build.py --batch <name>`:
 * `review/<batch>/{items.json, clips/, decisions.json}`. `wordbank.py` merges every batch's
 * decisions.json (later files win), so saving here takes effect on its next run.
 */
export type ReviewItem = { clip: string; seg: number; i0: number; i1: number; start: number; end: number; text: string; score: number; src: string };
export type ReviewCard = { clip: string; name: string; off: number; border: number; items: ReviewItem[] };
export type Verdict = 'speaking' | 'voiceover' | 'mixed';
export type Decision = { clip: string; seg: number; i0: number; i1: number; verdict: Verdict; text: string };
export type BatchSummary = { batch: string; clips: number; items: number; decided: number; saved: string | null };

export const VERDICTS: readonly Verdict[] = ['speaking', 'voiceover', 'mixed'];
const BATCH_RE = /^[a-z0-9][a-z0-9-]*$/;

export class ReviewError extends Error {
	constructor(message: string, readonly status: 400 | 404) { super(message); }
}

function reviewDir(): string {
	return join(engineDir(), 'review');
}

function batchDir(batch: string): string {
	if (!BATCH_RE.test(batch)) throw new ReviewError('Invalid batch name', 400);
	return join(reviewDir(), batch);
}

/** Parse a JSON file that must be a regular file (not a symlink); null when it doesn't exist. */
async function readJson(path: string): Promise<unknown> {
	const info = await lstat(path).catch(() => null);
	if (!info) return null;
	if (!info.isFile()) throw new ReviewError('Not a regular file', 400);
	try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new ReviewError('Invalid JSON', 400); }
}

async function readItems(batch: string): Promise<ReviewCard[]> {
	const dir = batchDir(batch);
	const info = await lstat(dir).catch(() => null);
	if (!info?.isDirectory()) throw new ReviewError('Review batch not found', 404);
	const cards = await readJson(join(dir, 'items.json'));
	if (!Array.isArray(cards)) throw new ReviewError('Review batch not found', 404);
	return cards as ReviewCard[];
}

async function readDecisions(batch: string): Promise<{ saved: string | null; decisions: Decision[] }> {
	const file = (await readJson(join(batchDir(batch), 'decisions.json'))) as { saved?: unknown; decisions?: unknown } | null;
	if (!file || !Array.isArray(file.decisions)) return { saved: null, decisions: [] };
	return { saved: typeof file.saved === 'string' ? file.saved : null, decisions: file.decisions as Decision[] };
}

/** Batches newest first (by the first clip number in the name, e.g. `c180-c351`). */
export async function listBatches(): Promise<BatchSummary[]> {
	const entries = await readdir(reviewDir(), { withFileTypes: true }).catch(() => []);
	const out: BatchSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !BATCH_RE.test(entry.name)) continue;
		try {
			const cards = await readItems(entry.name);
			const { saved, decisions } = await readDecisions(entry.name);
			out.push({ batch: entry.name, clips: cards.length, items: cards.reduce((n, card) => n + card.items.length, 0), decided: decisions.length, saved });
		} catch { /* skip half-built or unreadable batches */ }
	}
	const first = (name: string) => Number(/\d+/.exec(name)?.[0] ?? -1);
	return out.sort((a, b) => first(b.batch) - first(a.batch) || b.batch.localeCompare(a.batch));
}

export async function readBatch(batch: string) {
	const cards = await readItems(batch);
	const { saved, decisions } = await readDecisions(batch);
	return { batch, cards, saved, decisions };
}

/**
 * Save verdicts for items in this batch. Only the touched items are recorded, as in the
 * standalone page; i0/i1/text come from items.json so the file can't drift from the batch.
 */
export async function writeDecisions(batch: string, verdicts: { clip: string; seg: number; verdict: Verdict }[]) {
	const cards = await readItems(batch);
	const wanted = new Map<string, Verdict>();
	for (const entry of verdicts) {
		if (!VERDICTS.includes(entry.verdict)) throw new ReviewError(`Invalid verdict: ${String(entry.verdict)}`, 400);
		wanted.set(`${entry.clip}:${entry.seg}`, entry.verdict);
	}
	const decisions: Decision[] = [];
	for (const card of cards) for (const item of card.items) {
		const verdict = wanted.get(`${item.clip}:${item.seg}`);
		if (!verdict) continue;
		wanted.delete(`${item.clip}:${item.seg}`);
		decisions.push({ clip: item.clip, seg: item.seg, i0: item.i0, i1: item.i1, verdict, text: item.text });
	}
	if (wanted.size) throw new ReviewError(`Not in this batch: ${[...wanted.keys()].join(', ')}`, 400);

	const dir = batchDir(batch);
	const path = join(dir, 'decisions.json');
	const existing = await lstat(path).catch(() => null);
	if (existing && !existing.isFile()) throw new ReviewError('decisions.json is not a regular file', 400);
	const saved = new Date().toISOString();
	// Rename replaces a symlink rather than following it, so the write stays in the batch folder.
	const temp = join(dir, `.decisions.${randomUUID()}.tmp`);
	try {
		await writeFile(temp, `${JSON.stringify({ saved, decisions }, null, 1)}\n`, { flag: 'wx' });
		await rename(temp, path);
	} finally {
		await unlink(temp).catch(() => {});
	}
	return { saved, decided: decisions.length };
}
