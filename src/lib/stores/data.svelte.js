import { base } from '$app/paths';

const MISSING_NEAREST_STOP =
	'developments.json must include a numeric nearest_stop_dist_m for every MassBuilds project. ' +
	'Run the data pipeline on your machine and copy outputs into static/data, e.g.: ' +
	'conda activate ./.conda && python scripts/process_data.py';

/**
 * Shared tract/policy dashboard data loaded on demand (``/tract``, ``/policy``) from ``static/data``
 * (served under ``{base}/data/`` for GitHub Pages).
 *
 * Notes
 * -----
 * Svelte does not allow reassigning exported ``$state`` bindings; ``loadAllData`` mutates
 * these values in place (arrays via ``length`` / ``push``, objects via key updates).
 */

export const tractData = $state([]);
export const tractGeo = $state({ type: 'FeatureCollection', features: [] });
/** Full state tracts GeoJSON — loaded as background context for the map. */
export const allTractsGeo = $state({ type: 'FeatureCollection', features: [] });
export const developments = $state([]);
export const mbtaStops = $state([]);
export const mbtaLines = $state({ type: 'FeatureCollection', features: [] });
export const meta = $state({ yVariables: [], xVariables: [], controlAverages: {} });

/**
 * Replace enumerable own properties on ``target`` with those from ``source``.
 */
function replaceObjectProps(target, source) {
	for (const k of Object.keys(target)) {
		delete target[k];
	}
	Object.assign(target, source);
}

/**
 * Fail fast if the pipeline did not attach per-project nearest-stop distances.
 *
 * Parameters
 * ----------
 * devs : Array<object>
 *
 * Returns
 * -------
 * void
 */
function assertDevelopmentsHaveNearestStopDist(devs) {
	if (!Array.isArray(devs) || devs.length === 0) return;
	for (let i = 0; i < devs.length; i++) {
		const v = devs[i].nearest_stop_dist_m;
		if (v == null || !Number.isFinite(Number(v))) {
			throw new Error(MISSING_NEAREST_STOP);
		}
	}
}

/** @type {Promise<void> | null} */
let loadStoryDataPromise = null;
/** @type {Promise<void> | null} */
let loadGuidedDevelopmentsPromise = null;
/** @type {Promise<void> | null} */
let loadAllDataPromise = null;

export async function loadGuidedDevelopments() {
	if (developments.length) return;
	if (loadGuidedDevelopmentsPromise) return loadGuidedDevelopmentsPromise;
	loadGuidedDevelopmentsPromise = (async () => {
		const p = (/** @type {string} */ path) => `${base}${path}`;
		const devsRes = await fetch(p('/data/developments.json'));
		const devsJson = await devsRes.json();
		assertDevelopmentsHaveNearestStopDist(devsJson);
		developments.length = 0;
		developments.push(...devsJson);
	})().catch((e) => {
		loadGuidedDevelopmentsPromise = null;
		throw e;
	});
	return loadGuidedDevelopmentsPromise;
}

/**
 * Fetch the smaller data bundle needed for the guided home-page tract story.
 *
 * This avoids blocking the initial narrative on the full explorer dataset.
 *
 * Notes
 * -----
 * Developments are now loaded *before* this resolves so any consumer that reads
 * ``tractData`` after ``await loadStoryData()`` sees consistent dev-derived
 * fields (``devClass``, ``todFraction``, ``pctStockIncrease``) without waiting
 * for a second, unobserved network round-trip. Previously the unawaited
 * ``loadGuidedDevelopments`` call caused a race where the home-page map
 * rendered its choropleth and tooltips against empty developments, producing
 * "TOD-dominated" badges on tracts whose live TOD share was 0%.
 *
 * The precomputed ``tract_story_rows.json`` is no longer fetched: it was a
 * static artifact that could diverge from the live classifier. The home page
 * now rebuilds tract rows live via ``buildNhgisLikeRows`` so it shares one
 * source of truth with the playground.
 */
export async function loadStoryData() {
	if (loadStoryDataPromise) return loadStoryDataPromise;
	loadStoryDataPromise = (async () => {
		const p = (/** @type {string} */ path) => `${base}${path}`;
		const [tractDataRes, tractGeoRes, mbtaStopsRes, mbtaLinesRes] = await Promise.all([
			fetch(p('/data/tract_story_list.json')),
			fetch(p('/data/tract_story_geo.json')),
			fetch(p('/data/mbta_story_stops.json')),
			fetch(p('/data/mbta_story_lines.geojson'))
		]);

		const [tractDataJson, tractGeoJson, mbtaStopsJson, mbtaLinesJson] = await Promise.all([
			tractDataRes.json(),
			tractGeoRes.json(),
			mbtaStopsRes.json(),
			mbtaLinesRes.json()
		]);

		tractData.length = 0;
		tractData.push(...tractDataJson);
		replaceObjectProps(tractGeo, tractGeoJson);
		mbtaStops.length = 0;
		mbtaStops.push(...mbtaStopsJson);
		replaceObjectProps(mbtaLines, mbtaLinesJson);

		// Await developments so downstream classifiers see the full MassBuilds
		// set before ``loadStoryData`` resolves (prevents the badge/TOD-share
		// race on the home-page map).
		await loadGuidedDevelopments();

		// Non-blocking: load the full-state tracts GeoJSON so the map can show
		// excluded tracts as a background context layer (shape of MA).
		void loadFullTractsGeo().catch(() => {});
	})().catch((e) => {
		loadStoryDataPromise = null;
		throw e;
	});
	return loadStoryDataPromise;
}

/** @type {Promise<void> | null} */
let loadFullTractsGeoPromise = null;

async function loadFullTractsGeo() {
	if (allTractsGeo.features.length) return;
	if (loadFullTractsGeoPromise) return loadFullTractsGeoPromise;
	loadFullTractsGeoPromise = (async () => {
		const p = (/** @type {string} */ path) => `${base}${path}`;
		const res = await fetch(p('/data/tracts.geojson'));
		const json = await res.json();
		replaceObjectProps(allTractsGeo, json);
	})().catch((e) => {
		loadFullTractsGeoPromise = null;
		throw e;
	});
	return loadFullTractsGeoPromise;
}

/**
 * Fetch all dashboard JSON assets in parallel and assign module state.
 *
 * Notes
 * -----
 * Concurrent callers await the same in-flight promise so navigation and effects
 * cannot trigger duplicate fetches. On failure, the guard is cleared so a later
 * call can retry.
 */
export async function loadAllData() {
	if (loadAllDataPromise) return loadAllDataPromise;
	loadAllDataPromise = (async () => {
		await loadStoryData();
		const p = (/** @type {string} */ path) => `${base}${path}`;
		const [tractDataRes, tractGeoRes, devsRes, mbtaStopsRes, mbtaLinesRes, metaRes] = await Promise.all([
			fetch(p('/data/tract_data.json')),
			fetch(p('/data/tracts.geojson')),
			fetch(p('/data/developments.json')),
			fetch(p('/data/mbta_stops.json')),
			fetch(p('/data/mbta_lines.geojson')),
			fetch(p('/data/meta.json'))
		]);

		const [tractDataJson, tractGeoJson, devsJson, mbtaStopsJson, mbtaLinesJson, metaJson] = await Promise.all([
			tractDataRes.json(),
			tractGeoRes.json(),
			devsRes.json(),
			mbtaStopsRes.json(),
			mbtaLinesRes.json(),
			metaRes.json()
		]);

		assertDevelopmentsHaveNearestStopDist(devsJson);

		tractData.length = 0;
		tractData.push(...tractDataJson);
		replaceObjectProps(tractGeo, tractGeoJson);
		developments.length = 0;
		developments.push(...devsJson);
		mbtaStops.length = 0;
		mbtaStops.push(...mbtaStopsJson);
		replaceObjectProps(mbtaLines, mbtaLinesJson);
		replaceObjectProps(meta, metaJson);
	})().catch((e) => {
		loadAllDataPromise = null;
		throw e;
	});
	return loadAllDataPromise;
}
