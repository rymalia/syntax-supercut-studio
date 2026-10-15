import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { filmPath, runEngine } from '$lib/server/engine';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body.slug !== 'string') throw error(400, 'slug required');
	let path: string;
	try { path = filmPath(body.slug); } catch { throw error(400, 'Invalid film slug'); }
	return json(await runEngine(['check', '--film', path]));
};
