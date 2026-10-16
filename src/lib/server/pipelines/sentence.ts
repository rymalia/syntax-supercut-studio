import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filmPath, runEngine, type EngineResult } from '../engine.js';
import { slugify } from '../text.js';
import { CancelledError, type LogFn } from '../ffmpeg.js';

export interface SentenceParams {
	sentence: string;
	cast?: string[] | null;
	captions?: boolean;
	speakerLabels?: boolean;
	draft?: boolean;
}

export interface SentenceOptions extends SentenceParams {
	onLog?: LogFn;
	signal?: AbortSignal;
}

export interface SentenceCheckLine {
	line: number;
	speaker: string;
	text: string;
	ok: boolean;
	takes?: unknown[];
	why?: string;
}

export interface SentenceCheckFilm {
	ok: boolean;
	why?: string;
	[key: string]: unknown;
}

export interface SentenceCheckResult extends EngineResult {
	name: string;
	lines: SentenceCheckLine[];
	film: SentenceCheckFilm;
}

export interface SentenceResult {
	status: 'rendered' | 'cannot-build';
	check: SentenceCheckResult;
	outFile?: string;
	plan?: string;
	qa?: EngineResult | { ok: false; error: string } | null;
}

function asSentenceCheck(result: EngineResult): SentenceCheckResult {
	const lines = Array.isArray(result.lines) ? result.lines : [];
	const film = result.film;
	if (
		typeof result.name !== 'string' ||
		!film ||
		typeof film !== 'object' ||
		Array.isArray(film) ||
		typeof (film as Record<string, unknown>).ok !== 'boolean'
	) {
		throw new Error('Engine returned an invalid sentence check result');
	}
	return { ...result, name: result.name, lines: lines as SentenceCheckLine[], film: film as SentenceCheckFilm };
}

function outputPath(result: EngineResult, field: 'outFile' | 'plan'): string {
	const value = result[field];
	if (typeof value !== 'string' || !value) throw new Error(`Engine render result has no ${field}`);
	return value;
}

/** Sentence film names: `sentence-<slug>-<uuid>`. `/api/films` hides QA copies by this shape. */
export const SENTENCE_FILM_NAME = /^sentence-[a-z0-9-]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `qa` only takes a name and reads `films/<name>.json`, so the film is copied there
 * for the duration of the call. A QA failure is reported, not thrown: the video
 * is already rendered by then.
 */
async function runQa(
	name: string,
	film: Record<string, unknown>,
	onLog: LogFn,
	signal?: AbortSignal,
): Promise<EngineResult | { ok: false; error: string }> {
	const copy = filmPath(name);
	let written = false;
	try {
		await writeFile(copy, JSON.stringify(film, null, 2), { flag: 'wx' });
		written = true;
		return await runEngine(['qa', '--name', name], onLog, signal);
	} catch (err) {
		if (err instanceof CancelledError) throw err;
		const error = err instanceof Error ? err.message : String(err);
		onLog(`QA failed; the video is still available: ${error.split('\n')[0]}`);
		return { ok: false, error };
	} finally {
		// Only remove the copy this call wrote; 'wx' refused anything already there.
		if (written) await rm(copy, { force: true });
	}
}

export async function buildSentence(opts: SentenceOptions): Promise<SentenceResult> {
	const onLog = opts.onLog ?? (() => {});
	const sentence = opts.sentence.trim();
	if (!sentence) throw new Error('Sentence is empty');

	// The engine derives file names from the film name and mangles quotes (`there's`
	// broke its captions path), so keep it to the film-slug alphabet.
	const slug = slugify(sentence).replace(/[^a-z0-9-]+/g, '-').slice(0, 48).replace(/^-+|-+$/g, '') || 'sentence';
	const filmName = `sentence-${slug}-${randomUUID()}`;
	const tempDir = await mkdtemp(join(tmpdir(), 'syntax-sentence-'));
	const filmFile = join(tempDir, `${filmName}.json`);
	const film: Record<string, unknown> = {
		title: 'Sentence',
		speaker_labels: opts.speakerLabels ?? false,
		captions: opts.captions ?? true,
		lines: [{ speaker: 'SENTENCE', text: sentence }],
	};
	if (opts.cast?.length) film.cast = opts.cast;

	try {
		await writeFile(filmFile, JSON.stringify(film, null, 2));
		onLog(`Checking sentence: "${sentence}"`);
		const check = asSentenceCheck(await runEngine(['check', '--film', filmFile], onLog, opts.signal));
		if (!check.film.ok) {
			onLog('Cannot build sentence.');
			return { status: 'cannot-build', check };
		}

		const renderArgs = ['render', '--film', filmFile];
		if (opts.draft) renderArgs.push('--draft');
		onLog(opts.draft ? 'Rendering draft...' : 'Rendering sentence...');
		const render = await runEngine(renderArgs, onLog, opts.signal);
		const qa = opts.draft ? null : await runQa(filmName, film, onLog, opts.signal);
		return {
			status: 'rendered',
			check,
			outFile: outputPath(render, 'outFile'),
			plan: outputPath(render, 'plan'),
			qa,
		};
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}
