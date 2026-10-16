import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runEngine } from '$lib/server/engine';
import { logActivity } from '$lib/server/activity';
import { assignIds, NAME_RE, PeopleFileError, readPeopleNames, updatePeopleNames } from '$lib/server/people';

/**
 * `POST {version, ids, name}` names clusters in people.json: moves `ids` under `name`, or out of any
 * name when `name` is null. `version` is the `names_version` from `GET /api/engine/people`; a stale
 * one gets 409 so the page can reload rather than overwrite another writer's edit.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const { version, ids, name } = (body ?? {}) as { version?: unknown; ids?: unknown; name?: unknown };
	if (typeof version !== 'string') throw error(400, 'Missing version');
	if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) throw error(400, 'ids must be a non-empty list of cluster ids');
	if (name !== null && (typeof name !== 'string' || !NAME_RE.test(name))) throw error(400, 'Name must be lowercase letters, digits and underscores');
	const unique = [...new Set(ids as string[])];

	try {
		// Naming needs a cluster the engine knows; un-naming also accepts ids already in the file, so
		// stale ids left by an identities re-run can be cleared.
		const known = new Set(((await runEngine(['people'])).people as { id: string }[]).map((person) => person.id));
		if (name === null) for (const ids of Object.values((await readPeopleNames()).names)) for (const id of ids) known.add(id);
		const unknown = unique.filter((id) => !known.has(id));
		if (unknown.length) throw error(400, `Unknown cluster id: ${unknown.join(', ')}`);

		const saved = await updatePeopleNames(version, (names) => assignIds(names, unique, name as string | null));
		if (!saved) throw error(409, 'people.json changed since this page loaded; reload and try again');
		void logActivity(name === null ? 'people:unname' : 'people:name', name ?? '', unique.join(', '));
		return json({ ok: true, names: saved.names, names_version: saved.version });
	} catch (err) {
		if (err instanceof PeopleFileError) throw error(400, err.message);
		throw err;
	}
};
