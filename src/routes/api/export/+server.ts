import { error, json } from '@sveltejs/kit';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { RequestHandler } from './$types';
import { resolveBuckets, isInsideAllowedRoot } from '$lib/server/paths';
import { engineDir, runEngine } from '$lib/server/engine';
import { logActivity } from '$lib/server/activity';

/**
 * Export a render to an editor timeline (FCPXML + SRT on the original sources)
 * through the engine's `export` command. Body: `{bucket, file}` for a supercut
 * mp4 with a `.cuts.json` beside it, or `{plan}` for an engine render in
 * `films/out/`. Returns the files' contents so the page can offer downloads.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') throw error(400, 'JSON body required');

	let args: string[];
	let target: string;
	let outDir: string;
	if (typeof body.plan === 'string') {
		if (!/^[a-z0-9_-]+$/.test(body.plan)) throw error(400, 'Invalid plan name');
		args = ['export', '--plan', body.plan];
		target = body.plan;
		outDir = join(engineDir(), 'films', 'out');
	} else if (typeof body.bucket === 'string' && typeof body.file === 'string') {
		const file: string = body.file;
		if (file.includes('/') || file.includes('\\') || file.startsWith('.') || !file.endsWith('.mp4')) {
			throw error(400, 'Invalid filename');
		}
		const [bucket] = await resolveBuckets([body.bucket]).catch(() => []);
		if (!bucket) throw error(404, 'Unknown bucket');
		const cuts = resolve(join(bucket.supercutsDir, file.replace(/\.mp4$/, '.cuts.json')));
		if (!isInsideAllowedRoot(cuts)) throw error(403, 'Forbidden');
		if (!(await stat(cuts).catch(() => null))?.isFile()) {
			throw error(404, 'This render has no cut list (made before cut lists were saved)');
		}
		args = ['export', '--cuts', cuts, '--out', bucket.supercutsDir];
		target = `${bucket.name}/${file}`;
		outDir = bucket.supercutsDir;
	} else {
		throw error(400, 'plan, or bucket and file, required');
	}

	let result;
	try {
		result = await runEngine(args);
	} catch (err) {
		void logActivity('export', target, 'error');
		throw error(500, err instanceof Error ? err.message : String(err));
	}
	// Only hand back files the export wrote into the directory it was given.
	const realOut = await realpath(outDir);
	const files: { name: string; type: string; text: string }[] = [];
	for (const [field, type] of [
		['fcpxml', 'application/xml'],
		['srt', 'application/x-subrip'],
	] as const) {
		const path = result[field];
		if (typeof path === 'string' && path) {
			const actual = await realpath(path).catch(() => null);
			if (!actual || dirname(actual) !== realOut) throw error(500, `Engine export wrote ${field} outside ${outDir}`);
			files.push({ name: basename(path), type, text: await readFile(path, 'utf8') });
		}
	}
	if (!files.some((f) => f.name.endsWith('.fcpxml'))) throw error(500, 'Engine export returned no fcpxml');
	void logActivity('export', target, `${result.clips ?? '?'} items`);
	return json({ files, clips: result.clips, sources: result.sources, fps: result.fps });
};
