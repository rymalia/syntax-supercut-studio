import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runEngine } from '$lib/server/engine';
import { PeopleFileError, readPeopleNames } from '$lib/server/people';

export const GET: RequestHandler = async () => {
	const result = await runEngine(['people']);
	// `names` comes from our own read so it pairs with the version that a rename must present.
	try {
		const { names, version } = await readPeopleNames();
		return json({ ...result, names, names_version: version });
	} catch (err) {
		if (err instanceof PeopleFileError) throw error(500, err.message);
		throw err;
	}
};
