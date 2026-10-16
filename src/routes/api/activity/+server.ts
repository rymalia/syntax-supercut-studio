import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readActivity } from '$lib/server/activity';

export const GET: RequestHandler = async ({ url }) => {
	const requested = Number(url.searchParams.get('limit') ?? 20);
	const limit = Number.isFinite(requested) ? Math.min(200, Math.max(1, Math.floor(requested))) : 20;
	return json({ entries: await readActivity(limit) });
};
