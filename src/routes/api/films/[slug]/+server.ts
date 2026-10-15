import { error, json } from '@sveltejs/kit';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import type { RequestHandler } from './$types';
import { filmPath } from '$lib/server/engine';

function pathFor(slug: string): string {
	try { return filmPath(slug); } catch { throw error(400, 'Invalid film slug'); }
}

export const GET: RequestHandler = async ({ params }) => {
	const path = pathFor(params.slug);
	const info = await lstat(path).catch(() => null);
	if (!info?.isFile()) throw error(404, 'Film not found');
	try { return json(JSON.parse(await readFile(path, 'utf8'))); }
	catch { throw error(404, 'Film not found'); }
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const path = pathFor(params.slug);
	const film = await request.json().catch(() => null);
	if (!film || typeof film !== 'object' || Array.isArray(film) || !Array.isArray(film.lines) || film.lines.length === 0 ||
		film.lines.some((line: unknown) => !line || typeof line !== 'object' || typeof (line as {text?: unknown}).text !== 'string' || !(line as {text: string}).text.trim())) {
		throw error(400, 'Film must have non-empty lines with text');
	}
	const existing = await lstat(path).catch(() => null);
	if (existing && !existing.isFile()) throw error(400, 'Invalid film file');
	await writeFile(path, `${JSON.stringify(film, null, 2)}\n`, { flag: 'w' });
	return json({ ok: true, slug: params.slug });
};
