import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CancelledError } from './ffmpeg.js';
import { runEngine } from './engine.js';
import type { Hit } from './text.js';

interface EngineSpan {
	known?: boolean;
	in_cast?: boolean;
	person?: string | null;
	asd?: number;
	persons?: string[];
	onscreen?: boolean;
}

export interface AttributeHitsOptions {
	cast?: string[] | null;
	onscreen?: boolean;
	onLog?: (line: string) => void;
	signal?: AbortSignal;
}

export async function attributeHits(hits: Hit[], opts: AttributeHitsOptions = {}): Promise<Hit[]> {
	const cast = opts.cast?.filter(Boolean) ?? [];
	const onLog = opts.onLog ?? (() => {});
	const needsEngine = cast.length > 0 || opts.onscreen === true || hits.some((hit) => /^c\d+$/.test(hit.clip ?? ''));
	if (!needsEngine || hits.length === 0) return hits;

	const dir = await mkdtemp(join(tmpdir(), 'ssc-engine-hits-'));
	const spansFile = join(dir, 'spans.json');
	try {
		await writeFile(spansFile, JSON.stringify(hits.map((hit) => ({ clip: hit.clip, words: hit.words ?? [] }))));
		const args = ['attribute', '--spans', spansFile];
		for (const value of cast) args.push('--cast', value);
		let engine: { spans?: EngineSpan[]; names?: Record<string, string> };
		try {
			engine = (await runEngine(args, onLog, opts.signal)) as { spans?: EngineSpan[]; names?: Record<string, string> };
		} catch (err) {
			if (err instanceof CancelledError || opts.signal?.aborted) throw err;
			if (cast.length === 0 && opts.onscreen !== true) {
				onLog(`Warning: engine attribution failed; keeping ${hits.length} unannotated hits.`);
				return hits;
			}
			throw err;
		}

		const spans = Array.isArray(engine.spans) ? engine.spans : [];
		const counts = new Map<string, number>();
		let unknown = 0;
		let otherCast = 0;
		let offscreen = 0;
		const attributed = hits.map((hit, i) => ({ hit, span: spans[i] ?? { known: false } }));
		for (const { span } of attributed) {
			if (!span.known) unknown++;
			// A hit that crosses a shot change has no single person; count each of its speakers.
			for (const person of span.persons ?? (span.person ? [span.person] : [])) counts.set(person, (counts.get(person) ?? 0) + 1);
			if (cast.length > 0 && span.known && span.in_cast !== true) otherCast++;
			if (opts.onscreen === true && span.known && span.onscreen !== true) offscreen++;
		}
		const kept = attributed
			.filter(({ span }) => (cast.length === 0 || span.in_cast === true) && (opts.onscreen !== true || span.onscreen === true))
			.map(({ hit, span }) => {
				const { words: _words, ...annotated } = hit;
				return { ...annotated, person: span.person ?? null, asd: span.asd };
			});
		onLog(`attributed ${hits.length} hits: ${kept.length} kept, ${unknown} not in the engine, ${otherCast} other speakers, ${offscreen} off-screen`);
		for (const [person, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) onLog(`  ${person}${engine.names?.[person] ? ` (${engine.names[person]})` : ''}: ${count}`);
		return kept;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
