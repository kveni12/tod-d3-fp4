/**
 * Municipal data model — extracted from static/municipal/index.html.
 *
 * Provides data loading, haversine distance calculation, project parsing,
 * and municipality-level aggregation for the POC narrative page.
 */
import * as d3 from 'd3';

/* ── Helpers ─────────────────────────────────────────── */

export function num(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

function estimateMedianIncomeFromBins(row) {
	const bins = [
		{ key: 'incu10', low: 0, high: 10000 },
		{ key: 'inc1015', low: 10000, high: 15000 },
		{ key: 'inc1520', low: 15000, high: 20000 },
		{ key: 'inc2025', low: 20000, high: 25000 },
		{ key: 'inc2530', low: 25000, high: 30000 },
		{ key: 'inc3035', low: 30000, high: 35000 },
		{ key: 'inc3540', low: 35000, high: 40000 },
		{ key: 'inc4045', low: 40000, high: 45000 },
		{ key: 'inc4550', low: 45000, high: 50000 },
		{ key: 'inc5060', low: 50000, high: 60000 },
		{ key: 'inc6075', low: 60000, high: 75000 },
		{ key: 'i7599', low: 75000, high: 100000 },
		{ key: 'i100125', low: 100000, high: 125000 },
		{ key: 'i125150', low: 125000, high: 150000 },
		{ key: 'i150200', low: 150000, high: 200000 },
		{ key: 'in200o', low: 200000, high: 250000 }
	];
	const total = num(row.hh);
	if (!total) return NaN;
	const halfway = total / 2;
	let cumulative = 0;
	for (const bin of bins) {
		const count = num(row[bin.key]);
		if (!count) continue;
		const next = cumulative + count;
		if (halfway <= next) {
			const withinBin = (halfway - cumulative) / count;
			return bin.low + withinBin * (bin.high - bin.low);
		}
		cumulative = next;
	}
	return bins[bins.length - 1].high;
}

export function normalize(name) {
	return (name || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, '');
}

export function haversineMiles(lat1, lon1, lat2, lon2) {
	const toRad = (deg) => (deg * Math.PI) / 180;
	const r = 3958.8;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * r * Math.asin(Math.sqrt(a));
}

/* ── Data loading ────────────────────────────────────── */

/**
 * Fetch and parse all municipal-level data files.
 *
 * Parameters
 * ----------
 * basePath : str
 *     SvelteKit ``base`` path (e.g. "" or "/fp1-demographics").
 *
 * Returns
 * -------
 * object
 *     ``{ projects, stations, incomeByNorm, storyByNorm, householdByNorm,
 *     municipalityList, allMunicipalities, zoningOptions, muniGeo }``
 */
export async function loadMunicipalData(basePath) {
	const root = `${basePath}/data`;
	const [projectsRaw, stationsRaw, incomeRaw, storyRaw, housingRaw, muniGeo] =
		await Promise.all([
			d3.csv(`${root}/massbuilds_housing_development.csv`),
			d3.csv(`${root}/mbta_stations.csv`),
			d3.csv(`${root}/muni_income_agg.csv`),
			d3.csv(`${root}/municipality_story_metrics.csv`),
			d3.csv(`${root}/housing_sf_other_w_census.csv`),
			d3.json(`${root}/muni_simplified.geojson`)
		]);

	const stations = stationsRaw
		.map((d) => ({
			lat: num(d.stop_lat || d.latitude),
			lon: num(d.stop_lon || d.longitude)
		}))
		.filter((d) => d.lat && d.lon);

	const incomeByNorm = new Map(
		incomeRaw.map((d) => [
			normalize(d.municipality || d.municipal_norm),
			{
				municipality: d.municipality,
				under125: num(d.pct_inc_low) + num(d.pct_inc_mid),
				high125: num(d.pct_inc_high)
			}
		])
	);

	const storyByNorm = new Map(
		storyRaw.map((d) => [
			normalize(d.municipality || d.municipal_norm),
			{
				municipality: d.municipality,
				zoningBin: d.zoning_bin || 'Unknown',
				baselineAffordableShare: num(d.affordable_share),
				isMbta: num(d.is_mbta)
			}
		])
	);

	const householdByNorm = new Map(
		housingRaw.map((d) => [
			normalize(d.muni),
			{
				households: num(d.hh),
				over200k: num(d.in200o),
				incomeBinsKnown: true,
				estimatedMedianIncome: estimateMedianIncomeFromBins(d)
			}
		])
	);

	const projects = buildMunicipalProjects(projectsRaw, stations, storyByNorm);

	const { municipalityList, allMunicipalities, zoningOptions } =
		buildMunicipalityList(incomeRaw, storyRaw, housingRaw, projects, incomeByNorm, storyByNorm);

	return {
		projects,
		stations,
		incomeByNorm,
		storyByNorm,
		householdByNorm,
		municipalityList,
		allMunicipalities,
		zoningOptions,
		muniGeo
	};
}

/* ── Project parsing ─────────────────────────────────── */

/**
 * Parse MassBuilds CSV rows into enriched project objects with nearest-station distance.
 */
export function buildMunicipalProjects(projectsRaw, stations, storyByNorm) {
	return projectsRaw
		.map((d) => {
			const municipality = (d.municipal || '').trim();
			const key = normalize(municipality);
			const year = num(d.year_compl) || num(d.yrcomp_est);
			const units = num(d.hu);
			const affordableUnits = num(d.affrd_unit);
			const lat = num(d.latitude);
			const lon = num(d.longitude);
			let distance = NaN;
			if (lat && lon && stations.length) {
				distance = d3.min(stations, (s) => haversineMiles(lat, lon, s.lat, s.lon));
			}
			return {
				municipality,
				municipalNorm: key,
				year,
				units,
				affordableUnits,
				distance,
				hasDistance: Number.isFinite(distance),
				status: d.status || '',
				project: d.name || '(unnamed project)',
				zoningBin: storyByNorm.get(key)?.zoningBin || 'Unknown'
			};
		})
		.filter((d) => d.municipality && d.year >= 1990 && d.year <= 2026 && d.units > 0);
}

/* ── Municipality list ───────────────────────────────── */

function buildMunicipalityList(incomeRaw, storyRaw, housingRaw, projects, incomeByNorm, storyByNorm) {
	const municipalityMeta = new Map();
	const add = (name, norm, extra = {}) => {
		if (!norm) return;
		const current = municipalityMeta.get(norm) || {
			municipality: name || extra.municipality || norm,
			municipalNorm: norm
		};
		municipalityMeta.set(norm, {
			...current,
			...extra,
			municipality: current.municipality || name || extra.municipality || norm,
			municipalNorm: norm
		});
	};

	incomeRaw.forEach((d) =>
		add(d.municipality || d.municipal_norm, normalize(d.municipality || d.municipal_norm))
	);
	storyRaw.forEach((d) =>
		add(d.municipality || d.municipal_norm, normalize(d.municipality || d.municipal_norm), {
			zoningBin: d.zoning_bin || 'Unknown'
		})
	);
	housingRaw.forEach((d) => add(d.muni, normalize(d.muni)));
	projects.forEach((d) =>
		add(d.municipality, d.municipalNorm, { zoningBin: d.zoningBin || 'Unknown' })
	);

	const municipalityList = Array.from(municipalityMeta.values())
		.filter((d) => Number.isFinite(incomeByNorm.get(d.municipalNorm)?.under125))
		.sort((a, b) => a.municipality.localeCompare(b.municipality));

	const allMunicipalities = municipalityList.map((d) => d.municipality);

	const zoningOptions = Array.from(
		new Set(
			municipalityList.map(
				(d) => d.zoningBin || storyByNorm.get(d.municipalNorm)?.zoningBin || 'Unknown'
			)
		)
	).sort((a, b) => a.localeCompare(b));

	return { municipalityList, allMunicipalities, zoningOptions };
}

/* ── Filtering / aggregation ─────────────────────────── */

/**
 * Filter projects by year window, zoning set, and search string.
 */
export function filterMunicipalProjects(projects, state, includeYearFilter = true) {
	return projects.filter(
		(d) =>
			(!includeYearFilter || (d.year >= state.yearStart && d.year <= state.yearEnd)) &&
			state.zoning.has(d.zoningBin) &&
			(!state.search || d.municipality.toLowerCase().includes(state.search))
	);
}

/**
 * Aggregate project rows into one row per municipality.
 */
export function buildMunicipalityRows(
	projectRows,
	municipalityList,
	incomeByNorm,
	storyByNorm,
	householdByNorm,
	threshold,
	state,
	applyControlFilters = true
) {
	const roll = new Map(
		d3.rollups(
			projectRows,
			(values) => {
				const units = d3.sum(values, (d) => d.units);
				const affordableUnits = d3.sum(values, (d) => d.affordableUnits);
				const todUnits = d3.sum(
					values.filter((d) => d.hasDistance && d.distance <= threshold),
					(d) => d.units
				);
				const nonTodUnits = units - todUnits;
				const key = values[0].municipalNorm;
				const income = incomeByNorm.get(key);
				const story = storyByNorm.get(key);
				const housing = householdByNorm.get(key);
				return {
					municipality: values[0].municipality,
					municipalNorm: key,
					units,
					affordableUnits,
					affordableShare: units ? affordableUnits / units : 0,
					todUnits,
					todShare: units ? todUnits / units : 0,
					dominant: todUnits >= nonTodUnits ? 'tod' : 'nonTod',
					under125: income ? income.under125 : NaN,
					high125: income ? income.high125 : NaN,
					zoningBin: story?.zoningBin || 'Unknown',
					baselineAffordableShare: story?.baselineAffordableShare || 0,
					households: housing?.households || 0,
					estimatedMedianIncome: housing?.estimatedMedianIncome || NaN
				};
			},
			(d) => d.municipalNorm
		)
	);

	return municipalityList
		.filter((meta) => {
			if (!applyControlFilters) return true;
			const zoningBin =
				storyByNorm.get(meta.municipalNorm)?.zoningBin || meta.zoningBin || 'Unknown';
			return (
				state.zoning.has(zoningBin) &&
				(!state.search || meta.municipality.toLowerCase().includes(state.search))
			);
		})
		.map((meta) => {
			const existing = roll.get(meta.municipalNorm);
			if (existing) return existing;
			const income = incomeByNorm.get(meta.municipalNorm);
			const story = storyByNorm.get(meta.municipalNorm);
			const housing = householdByNorm.get(meta.municipalNorm);
			return {
				municipality: meta.municipality,
				municipalNorm: meta.municipalNorm,
				units: 0,
				affordableUnits: 0,
				affordableShare: 0,
				todUnits: 0,
				todShare: 0,
				dominant: 'none',
				under125: income ? income.under125 : NaN,
				high125: income ? income.high125 : NaN,
				zoningBin: story?.zoningBin || meta.zoningBin || 'Unknown',
				baselineAffordableShare: story?.baselineAffordableShare || 0,
				households: housing?.households || 0,
				estimatedMedianIncome: housing?.estimatedMedianIncome || NaN
			};
		})
		.filter((d) => Number.isFinite(d.under125));
}

/**
 * Return only selected rows, or all rows if nothing is selected.
 */
export function activeRows(allRows, selected) {
	if (!selected.size) return allRows;
	return allRows.filter((d) => selected.has(d.municipality));
}
