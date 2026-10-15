import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runEngine } from '$lib/server/engine';

export const GET: RequestHandler = async ({ url }) => {
	const q = url.searchParams.get('q')?.trim();
	if (!q) throw error(400, 'q required');
	const rawLimit = url.searchParams.get('limit');
	const limit = rawLimit === null ? 50 : Number(rawLimit);
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw error(400, 'limit must be 1–500');
	return json(await runEngine(['grep', '--q', q, '--limit', String(limit)]));
};
