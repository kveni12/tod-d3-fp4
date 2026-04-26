<script>
	import { base } from '$app/paths';
	import * as d3 from 'd3';
	import {
		loadMunicipalData,
		filterMunicipalProjects,
		buildMunicipalityRows,
		activeRows as getActiveRows
	} from '$lib/utils/municipalModel.js';
	import {
		renderMuniScatter,
		renderMuniComposition,
		renderMuniGrowthCapture,
		renderMuniAffordableTrend
	} from '$lib/utils/municipalCharts.js';
	import { tractData, developments, meta } from '$lib/stores/data.svelte.js';
	import { loadStoryData } from '$lib/stores/data.svelte.js';
	import {
		DEFAULT_MAIN_POC_DEV_OPTS,
		DEFAULT_MAIN_POC_UNIVERSE,
		buildNhgisLikeRows,
		buildTractDevClassMap,
		filterDevelopmentsByYearRange,
		filterTractsForMainPoc,
		uniqueCounties
	} from '$lib/utils/mainPocTractModel.js';
	import { createPanelState } from '$lib/stores/panelState.svelte.js';
	import PocNhgisTractMap from '$lib/components/PocNhgisTractMap.svelte';
	import TodIntensityScatter from '$lib/components/TodIntensityScatter.svelte';
	import {
		buildCohortDevelopmentSplit,
		cohortYMeansForYKey,
		popWeightKey,
		yMetricDisplayKind,
		formatYMetricSummary
	} from '$lib/utils/derived.js';

	/* ═══════════════════════════════════════════════════════
	   MUNICIPAL STATE (Part 1)
	   ═══════════════════════════════════════════════════════ */
	let muniLoaded = $state(false);
	let muniData = $state(/** @type {any} */ (null));

	let yearStart = $state(1990);
	let yearEnd = $state(2026);
	let threshold = $state(0.5);
	let growthScale = $state(/** @type {'units' | 'share'} */ ('units'));
	let showTrendline = $state(false);
	let dominanceFilter = $state(/** @type {'all' | 'tod' | 'nonTod'} */ ('all'));
	let zoning = $state(/** @type {Set<string>} */ (new Set()));
	let search = $state('');
	let selected = $state(/** @type {Set<string>} */ (new Set()));
	let mapMetric = $state(/** @type {string} */ ('units'));

	/* ── Derived municipal data ───────────────────────── */
	const muniState = $derived({
		yearStart,
		yearEnd,
		threshold,
		growthScale,
		showTrendline,
		dominanceFilter,
		zoning,
		search,
		selected,
		mapMetric
	});

	const projectRows = $derived.by(() => {
		if (!muniData) return [];
		return filterMunicipalProjects(muniData.projects, muniState);
	});

	const allProjectRows = $derived.by(() => {
		if (!muniData) return [];
		return filterMunicipalProjects(muniData.projects, muniState, false);
	});

	const visibleRows = $derived.by(() => {
		if (!muniData) return [];
		const rows = buildMunicipalityRows(
			projectRows,
			muniData.municipalityList,
			muniData.incomeByNorm,
			muniData.storyByNorm,
			muniData.householdByNorm,
			threshold,
			muniState
		);
		if (dominanceFilter === 'all') return rows;
		return rows.filter(
			(d) => dominanceFilter === 'tod' ? d.dominant === 'tod' : d.dominant !== 'tod'
		);
	});

	const domainRows = $derived.by(() => {
		if (!muniData) return [];
		return buildMunicipalityRows(
			allProjectRows,
			muniData.municipalityList,
			muniData.incomeByNorm,
			muniData.storyByNorm,
			muniData.householdByNorm,
			threshold,
			{ ...muniState, yearStart: 1990, yearEnd: 2026 },
			false
		);
	});

	const muniActive = $derived(getActiveRows(visibleRows, selected));

	/* ── Element refs (municipal) ─────────────────────── */
	let elScatter = $state(/** @type {HTMLElement | undefined} */ (undefined));
	let elComposition = $state(/** @type {HTMLElement | undefined} */ (undefined));
	let elGrowthCapture = $state(/** @type {HTMLElement | undefined} */ (undefined));
	let elAffordableTrend = $state(/** @type {HTMLElement | undefined} */ (undefined));

	function draw() {
		if (!muniData) return;
		const cb = { onSelectionChange: () => { selected = new Set(selected); } };
		if (elScatter) renderMuniScatter(elScatter, visibleRows, domainRows, muniState, cb);
		if (elComposition) renderMuniComposition(elComposition, projectRows, muniState);
		if (elGrowthCapture) renderMuniGrowthCapture(elGrowthCapture, projectRows, domainRows, muniState);
		if (elAffordableTrend) renderMuniAffordableTrend(elAffordableTrend, projectRows, muniState);
	}

	// Debounce draw during playback via rAF
	let rafId = 0;
	$effect(() => {
		void visibleRows;
		void domainRows;
		void projectRows;
		void muniActive;
		void mapMetric;
		void muniData;
		void elScatter;
		void elComposition;
		void elGrowthCapture;
		void elAffordableTrend;
		cancelAnimationFrame(rafId);
		rafId = requestAnimationFrame(() => draw());
	});

	/* ── Load municipal data on mount ─────────────────── */
	$effect(() => {
		loadMunicipalData(base).then((data) => {
			muniData = data;
			zoning = new Set(data.zoningOptions);
			muniLoaded = true;
		});
	});

	/* ═══════════════════════════════════════════════════════
	   TRACT STATE (Part 2)
	   ═══════════════════════════════════════════════════════ */
	let tractLoading = $state(true);
	let tractError = $state(/** @type {string | null} */ (null));
	let tractReady = $state(false);

	// Tract analysis defaults (sensible, no user controls)
	const tractTimePeriod = '00_20';
	const tractSigDevMin = 2;
	const tractTodFractionCutoff = 0.5;

	/** Map overlays + dev filters for ``PocNhgisTractMap`` (aligned with tract ``FilterPanel`` / ``MapView``). */
	const pocMapPanel = createPanelState('poc-main');

	$effect(() => {
		if (!tractReady) return;
		pocMapPanel.transitDistanceMi = threshold;
		pocMapPanel.timePeriod = tractTimePeriod;
		pocMapPanel.minStops = DEFAULT_MAIN_POC_UNIVERSE.minStops;
		pocMapPanel.sigDevMinPctStockIncrease = tractSigDevMin;
		pocMapPanel.todFractionCutoff = tractTodFractionCutoff;
		pocMapPanel.huChangeSource = 'massbuilds';
		pocMapPanel.minPopulation = DEFAULT_MAIN_POC_UNIVERSE.minPopulation;
		pocMapPanel.minPopDensity = DEFAULT_MAIN_POC_UNIVERSE.minPopDensity;
		pocMapPanel.minUnitsPerProject = DEFAULT_MAIN_POC_DEV_OPTS.minUnitsPerProject;
		pocMapPanel.minDevMultifamilyRatioPct = DEFAULT_MAIN_POC_DEV_OPTS.minDevMultifamilyRatioPct;
		pocMapPanel.minDevAffordableRatioPct = DEFAULT_MAIN_POC_DEV_OPTS.minDevAffordableRatioPct;
		pocMapPanel.includeRedevelopment = DEFAULT_MAIN_POC_DEV_OPTS.includeRedevelopment;
		pocMapPanel.showRailLines = true;
		pocMapPanel.showRailStops = true;
		pocMapPanel.showCommuterRailLines = true;
		pocMapPanel.showCommuterRailStops = true;
		pocMapPanel.showBusLines = false;
		pocMapPanel.showBusStops = false;
	});

	$effect(() => {
		loadStoryData()
			.then(() => {
				tractReady = true;
				tractError = null;
			})
			.catch((e) => {
				tractError = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				tractLoading = false;
			});
	});

	const tractDevOpts = $derived({
		minUnitsPerProject: DEFAULT_MAIN_POC_DEV_OPTS.minUnitsPerProject,
		minDevMultifamilyRatioPct: DEFAULT_MAIN_POC_DEV_OPTS.minDevMultifamilyRatioPct,
		minDevAffordableRatioPct: DEFAULT_MAIN_POC_DEV_OPTS.minDevAffordableRatioPct,
		includeRedevelopment: DEFAULT_MAIN_POC_DEV_OPTS.includeRedevelopment
	});

	const tractCounties = $derived.by(() => {
		if (!tractData.length) return new Set();
		return new Set(uniqueCounties(tractData));
	});

	const tractListFiltered = $derived.by(() => {
		if (!tractData.length) return [];
		return filterTractsForMainPoc(tractData, tractCounties, '', {
			timePeriod: tractTimePeriod,
			minStops: DEFAULT_MAIN_POC_UNIVERSE.minStops,
			minPopulation: DEFAULT_MAIN_POC_UNIVERSE.minPopulation,
			minPopDensity: DEFAULT_MAIN_POC_UNIVERSE.minPopDensity
		});
	});

	const tractWindowDevs = $derived.by(() =>
		filterDevelopmentsByYearRange(developments, 1990, 2026, tractDevOpts)
	);

	const tractDevClassByGj = $derived.by(() =>
		buildTractDevClassMap(
			tractListFiltered,
			tractWindowDevs,
			{ timePeriod: tractTimePeriod, minStops: DEFAULT_MAIN_POC_UNIVERSE.minStops, minPopulation: DEFAULT_MAIN_POC_UNIVERSE.minPopulation, minPopDensity: DEFAULT_MAIN_POC_UNIVERSE.minPopDensity },
			threshold,
			tractDevOpts,
			tractSigDevMin,
			tractTodFractionCutoff
		)
	);

	// Always rebuild ``nhgisRows`` live from the current panel parameters so
	// the home-page map uses the same ``devClass`` definition as the playground.
	// (Previously a precomputed ``tract_story_rows.json`` was preferred here,
	// which was a static artifact that could diverge from the live classifier
	// and caused "TOD-dominated" badges on tracts showing 0% live TOD share.)
	const nhgisLikeRows = $derived.by(() =>
		buildNhgisLikeRows(tractListFiltered, tractDevClassByGj, tractTimePeriod)
	);

	const tractPanelConfig = $derived({
		timePeriod: tractTimePeriod,
		transitDistanceMi: threshold,
		sigDevMinPctStockIncrease: tractSigDevMin,
		todFractionCutoff: tractTodFractionCutoff,
		huChangeSource: 'massbuilds',
		minPopulation: DEFAULT_MAIN_POC_UNIVERSE.minPopulation,
		minPopDensity: DEFAULT_MAIN_POC_UNIVERSE.minPopDensity,
		minStops: DEFAULT_MAIN_POC_UNIVERSE.minStops,
		minUnitsPerProject: DEFAULT_MAIN_POC_DEV_OPTS.minUnitsPerProject,
		minDevMultifamilyRatioPct: DEFAULT_MAIN_POC_DEV_OPTS.minDevMultifamilyRatioPct,
		minDevAffordableRatioPct: DEFAULT_MAIN_POC_DEV_OPTS.minDevAffordableRatioPct,
		includeRedevelopment: DEFAULT_MAIN_POC_DEV_OPTS.includeRedevelopment
	});

	const cohortDevSplit = $derived.by(() => {
		if (!tractData.length || !developments.length) return { tod: [], nonTod: [], minimal: [] };
		return buildCohortDevelopmentSplit(tractData, tractPanelConfig, developments);
	});

	/**
	 * Display kind for a Y key when ``meta`` is not loaded yet: matches ``meta.json`` / ``yMetricDisplayKind`` rules.
	 *
	 * @param {string} vKey
	 * @returns {'pp' | 'pct' | 'min'}
	 */
	function yKindForStoryKey(vKey) {
		const v = meta.yVariables?.find((x) => x.key === vKey);
		if (v) return yMetricDisplayKind(v);
		if (vKey === 'bachelors_pct_change') return 'pp';
		if (vKey === 'median_income_change_pct') return 'pct';
		return 'pct';
	}

	/**
	 * Cohort means for a single story metric (independent of ``meta.yVariables`` being populated).
	 *
	 * @param {string} vKey
	 */
	function buildStoryCohortRow(vKey) {
		const weightKey = popWeightKey(tractTimePeriod);
		const yKey = `${vKey}_${tractTimePeriod}`;
		const raw = cohortYMeansForYKey(cohortDevSplit, yKey, weightKey);
		const kind = yKindForStoryKey(vKey);
		return {
			key: vKey,
			kind,
			meanTod: raw.meanTod,
			meanNonTod: raw.meanNonTod,
			meanMinimal: raw.meanMinimal,
			fmtTod: formatYMetricSummary(raw.meanTod, kind),
			fmtCtrl: formatYMetricSummary(raw.meanNonTod, kind),
			fmtMinimal: formatYMetricSummary(raw.meanMinimal, kind)
		};
	}

	const incomeRow = $derived(buildStoryCohortRow('median_income_change_pct'));
	const eduRow = $derived(buildStoryCohortRow('bachelors_pct_change'));

	/**
	 * Layout for a compact three-cohort bar chart (same population-weighted means as body copy / scatter Y).
	 *
	 * @param { { meanTod: number, meanNonTod: number, meanMinimal: number, kind: 'pp' | 'pct' | 'min' } | undefined } row
	 * @param {{ w?: number, h?: number }} [opts]
	 */
	function cohortMiniBarLayout(row, opts) {
		if (!row) return null;
		const W = opts?.w ?? 268;
		const H = opts?.h ?? 96;
		// Extra top margin so value labels (above bar tops) stay inside the viewBox
		const m = { t: 16, r: 8, b: 20, l: 36 };
		const items = [
			{ id: 'tod', shortLabel: 'TOD', v: row.meanTod, fill: '#0f766e' },
			{ id: 'nontod', shortLabel: 'Non-TOD', v: row.meanNonTod, fill: '#64748b' },
			{ id: 'minimal', shortLabel: 'Minimal', v: row.meanMinimal, fill: '#94a3b8' }
		];
		const finite = items.filter((d) => Number.isFinite(d.v));
		if (finite.length === 0) return null;
		const minV = d3.min(finite, (d) => d.v) ?? 0;
		const maxV = d3.max(finite, (d) => d.v) ?? 0;
		const y0 = Math.min(0, minV);
		const y1 = Math.max(0, maxV);
		const span = y1 - y0;
		const pad = span > 0 ? span * 0.08 : 0.5;
		const yDomain = [y0 - pad, y1 + pad];
		const iw = W - m.l - m.r;
		const ih = H - m.t - m.b;
		const x = d3.scaleBand().domain(items.map((d) => d.id)).range([0, iw]).padding(0.22);
		const y = d3.scaleLinear().domain(yDomain).range([ih, 0]);
		/** @param {number} v */
		const toSvgY = (v) => m.t + y(v);
		const y0px = toSvgY(0);
		const tickFmt =
			row.kind === 'pp'
				? d3.format('.1f')
				: row.kind === 'min'
					? d3.format('.1f')
					: d3.format('.0f');
		const yTicks = d3
			.ticks(yDomain[0], yDomain[1], 3)
			.filter((t) => t >= yDomain[0] - 1e-9 && t <= yDomain[1] + 1e-9);
		const bars = items.map((d) => {
			if (!Number.isFinite(d.v)) {
				return {
					...d,
					xPx: (x(d.id) ?? 0) + m.l,
					yPx: y0px,
					wPx: x.bandwidth(),
					hPx: 0,
					valueLabel: '—',
					labelY: y0px - 4
				};
			}
			const yV = toSvgY(d.v);
			const top = Math.min(y0px, yV);
			const hPx = Math.abs(yV - y0px);
			const valueLabel = formatYMetricSummary(d.v, row.kind);
			// Alphabetic baseline: a few px above the top of the bar (smaller y = higher on screen)
			const labelY = top - 4;
			return { ...d, xPx: (x(d.id) ?? 0) + m.l, yPx: top, wPx: x.bandwidth(), hPx, valueLabel, labelY };
		});
		const yAxisTicks = yTicks.map((t) => ({
			t,
			yPx: toSvgY(t),
			label:
				row.kind === 'pp'
					? `${tickFmt(t)}`
					: row.kind === 'min'
						? `${tickFmt(t)}`
						: `${tickFmt(t)}%`
		}));
		return { W, H, m, mInner: iw, ih, y0px, bars, yDomain, yAxisTicks, unitKind: row.kind };
	}

	const incomeMiniBar = $derived(cohortMiniBarLayout(incomeRow));
	const eduMiniBar = $derived(cohortMiniBarLayout(eduRow));

	function makeTodScatterPanelState(yVar) {
		return {
			timePeriod: tractTimePeriod,
			yVar,
			transitDistanceMi: threshold,
			sigDevMinPctStockIncrease: tractSigDevMin,
			todFractionCutoff: tractTodFractionCutoff,
			huChangeSource: 'massbuilds',
			minPopulation: DEFAULT_MAIN_POC_UNIVERSE.minPopulation,
			minPopDensity: DEFAULT_MAIN_POC_UNIVERSE.minPopDensity,
			minStops: DEFAULT_MAIN_POC_UNIVERSE.minStops,
			minUnitsPerProject: DEFAULT_MAIN_POC_DEV_OPTS.minUnitsPerProject,
			minDevMultifamilyRatioPct: DEFAULT_MAIN_POC_DEV_OPTS.minDevMultifamilyRatioPct,
			minDevAffordableRatioPct: DEFAULT_MAIN_POC_DEV_OPTS.minDevAffordableRatioPct,
			includeRedevelopment: DEFAULT_MAIN_POC_DEV_OPTS.includeRedevelopment,
			trimOutliers: true,
			hoveredTract: null,
			selectedTracts: new Set(),
			setHovered(gisjoin) {
				this.hoveredTract = gisjoin;
			},
			toggleTract(gisjoin) {
				const next = new Set(this.selectedTracts);
				if (next.has(gisjoin)) next.delete(gisjoin);
				else next.add(gisjoin);
				this.selectedTracts = next;
			}
		};
	}

	let incomePanelState = $state(makeTodScatterPanelState('median_income_change_pct'));
	let eduPanelState = $state(makeTodScatterPanelState('bachelors_pct_change'));

	$effect(() => {
		void threshold;
		incomePanelState = makeTodScatterPanelState('median_income_change_pct');
		eduPanelState = makeTodScatterPanelState('bachelors_pct_change');
	});
</script>

<div class="poc-root">
	<!-- Narrative + tract story up to "Explore" use a narrower column; Explore stays full poc-root width. -->
	<div class="poc-pre-explore">
	<section class="hero-full card">
		<div class="eyebrow">Guided Story</div>
		<h1>Massachusetts is expanding TOD--how can equity be protected?</h1>
		<p class="subtitle">
			Transit-oriented development is widely viewed as a robust and highly beneficial planning strategy: it can support housing growth,
			reduce car dependence, and create higher-density neighborhoods with closer access to jobs and services. 
			However, debate remains about <strong>whether the benefits of TOD are being shared with lower-income residents</strong>, and <strong>whether this development contributes
			to gentrification and displacement</strong>.<br><br>
		</p>
		<p class="subtitle">
			To answer this question, we analyze the current geographic distribution of TOD across Massachusetts, and analyze
			the correlations between increased TOD and demographic changes in TOD areas in the hope of identifying possible
			trends (though not causal proof) that can inform equity considerations and policy decisions.
		</p>
		<p class="hero-plan-note">
			A separate writeup page includes our design decisions, development overview, and final project plan:
			<a href={`${base}/writeup`}>open the full writeup</a>.
		</p>
	</section>

	<section class="story card story--signal">
		<h2>The central takeaway</h2>
		<p class="signal-line">Many transit-rich places see limited housing growth, which indicates further opportunities
			for transit-oriented development.</p>
		<p class="signal-line">Some of these high-opportunity areas are lower-income, and therefore more at risk of
			displacement due to rising costs.
		</p>
		<p class="signal-line">TOD is associated with rising income and education levels, which signals a possible
			pressure pushing lower-income households out of these areas. Incorporating affordable housing requirements into TOD
			development can help mitigate this pressure.
		</p>
	</section>

	{#if !muniLoaded}
		<div class="loading-status">
			<div class="spinner" aria-hidden="true"></div>
			<p>Loading municipal data…</p>
		</div>
	{:else}
	<section class="story card">
		<h2>What is the status of TOD in Massachusetts?</h2>
		<p>
			Despite policy efforts, most new housing being built in Massachusetts consists of non-TOD units. However, total development has increased over time,
			so the volume of TOD units has also been increasing. With the passage of the MBTA Communities Act, TOD is expected to become even more widespread,
			so it is important to understand the effects TOD has already had on the state.
		</p>

		<section class="chart-card card">
			<h3>TOD vs non-TOD mix by year</h3>
			<div class="chart-wrap small-chart" bind:this={elComposition}></div>
		</section>
	</section>

	<section class="card story-chart-panel story-chart-panel--stacked">
		<div class="story-chart-panel__grid">
			<div class="story-chart-panel__text">
				<h2>Who benefits from TOD?</h2>
				<p>
					For many residents, a primary concern with TOD is the gap between housing supply and genuine affordability.
					Although TOD projects often increase the total number of housing units, if these units are
					market-rate, they are usually significantly more expensive than existing units in the neighborhood.
					This does not mean that low-to-moderate income households cannot afford to move into these homes,
					and more importantly, it often raises rents for those already living in the area.
				</p>

				<p>
					Encouraging TOD projects that include affordable housing units can help mitigate this issue, but recent
					trends show that affordability is not currently keeping pace with total production.
				</p>
			</div>
			<div class="story-chart-panel__chart">
				<h3>Most new housing is still market-rate</h3>
				<p class="chart-note">
					The affordable share of new development stays low for most of the timeline, with only a few short
					spikes upward. Even in years when more housing is being added, most of those units are still
					market-rate rather than affordable.
				</p>
				<div class="chart-wrap small-chart compact-side-chart" bind:this={elAffordableTrend}></div>
			</div>
		</div>
	</section>

	<section class="card story-chart-panel story-chart-panel--stacked">
		<div class="story-chart-panel__grid">
			<div class="story-chart-panel__text">
				<h2>Where is development most concentrated?</h2>
				<p>
					Although lower-income residents are the most at risk of displacement,
					municipalities with more lower income households (&lt; $125k/year) are often the ones seeing the most new development.
					This suggests that equitable implementation matters most in the places already under the most pressure.
				</p>
				<p>
					Here, <strong>higher-vulnerability</strong> municipalities are the ones above the median share of households earning less than
					$125k, while <strong>lower-vulnerability</strong> municipalities fall below that median. The comparison is meant to show
					where new housing production is landing relative to that income pressure.
				</p>
			</div>
			<div class="story-chart-panel__chart">
				<h3>New development is often concentrated in higher-vulnerability municipalities</h3>
				<div class="chart-wrap small-chart compact-side-chart" bind:this={elGrowthCapture}></div>
			</div>
		</div>
	</section>

	<section class="story card">
		<h2>What is the impact of TOD?</h2>
		<p>
			Lower-income communities are at higher risk for displacement due to TOD, so it is all the more important
			to understand what demographic changes are associated with TOD, and determine how they might be mitigated.
			These proxy indicators are often associated with (though not always solely caused by) gentrification pressure:
		</p>
		<ul class="story-list">
			<li>Sharp increases in median income, often used as a <strong>risk indicator for rising housing costs</strong></li>
			<li>Rapid increases in the percentage of residents with bachelor's degrees or higher</li>
			<li>Shift from owner-occupied housing to high-turnover rental units [analysis of this metric will be added soon]</li>
		</ul>
		<p>
			Changes in these measures will not necessarily establish that TOD causes gentrification, but they can be interpreted as
			warning signals that can help identify where neighborhood change may be happening
			alongside new development and transit access.
		</p>
	</section>
	<!-- <section class="story card">
		<h2>What is the status of TOD in Massachusetts?	</h2>
		<p class="chart-note">
			Despite policy efforts, most new housing being built in Massachusetts consists of non-TOD units. However, total development has increased over time,
			so the volume of TOD units has also been increasing. With the passage of the MBTA Communities Act, TOD is expected to become even more widespread,
			so it is important to understand the effects TOD has already had on the state.
		</p>
		<div class="guide-figures">
			<figure class="guide-figure card">
				<h3>Transit-oriented development is growing, but not always at the same pace as total housing growth</h3>
				<div class="chart-wrap small-chart" bind:this={elComposition}></div>
				<figcaption>
					We start here because it prevents an easy misunderstanding. The question is not whether TOD exists in Greater
					Boston. It clearly does. The question is whether new housing is consistently concentrating in the places with the
					strongest transit access. This figure shows that the answer is no: TOD makes up an important share of recent growth,
					but a large share of new units still lands outside the highest-access transit context.
				</figcaption>
			</figure>
			<figure class="guide-figure card">
				<h3>New housing growth is not only uneven, but socially uneven</h3>
				<div class="chart-wrap small-chart" bind:this={elGrowthCapture}></div>
				<figcaption>
					This figure moves from geography to stakes. It shows how much yearly growth is landing in municipalities with
					higher shares of households below $125k. That matters because the mismatch argument is not only about where growth
					is missing from transit-rich places. It is also about where growth pressure is landing, and who is more likely to
					be living there when that pressure arrives.
				</figcaption>
			</figure>
			<figure class="guide-figure card">
				<h3>Transit access and lower-income geography do not line up cleanly</h3>
				<div class="chart-wrap small-chart" bind:this={elScatter}></div>
				<figcaption>
					Here the point is comparison. Municipalities with larger lower-income shares do not map neatly onto the places with
					the strongest TOD share or the largest amount of new growth. That is why we do not stop at a regional summary. The
					map is needed next, because the tract scale shows where transit access, housing growth, and lower-income context
					line up, and where they begin to pull apart. The dashed gray lines mark the regional averages on each axis, so they
					help the reader see which municipalities sit above or below the typical lower-income share and above or below the
					typical level of housing growth.
				</figcaption>
			</figure>
		</div>
		<p class="chart-note chart-note--after-figures">
			Taken together, these views show the reader what to watch for once the map begins to zoom in. The question is not simply
			where transit is, or where growth is, but where those patterns stop lining up neatly, especially in places where lower-income
			households may have the most to gain from living near strong transit access.
		</p>
	</section> -->
	{/if}

	<!-- ═══════════════════════════════════════════════════════
	     PART 2 — TRACT ANALYSIS
	     ═══════════════════════════════════════════════════════ -->

	
	<section class="story card full-width">
		<h2>How can we analyze the effects of TOD holisitically?</h2>
		<p>
			Different regions in Massachusetts have different characteristics, and have undergone different levels of development.
			In order to analyze the varying intensity of TOD and other development, we can consider decennial census tracts
			as a regional unit of analysis.
		</p>
		<p>
			Before we can analyze the demographic changes associated with TOD, we need a broad framework for understanding
			and comparing different regions of the state based on their development intensity and type. To do this, we answer
			several key questions:
		</p>
		<ul class="story-list">
			<li>Where is transit accessible?</li>
			<li>Which regions have seen the most development, and which present the most opportunity for TOD?</li>
			<li>Where has TOD already occured, and where has it not?</li>
		</ul>
	</section>
	
	<section class="tract-section">
		<section class="story card full-width story--framing">
			<div class="framing-grid">
				<div class="framing-block">
					<h2>Key definitions</h2>
					<p>
						<strong>TOD developments</strong> are projects within <strong>0.5 miles</strong> of an MBTA stop; all others are treated as
						<strong> non-TOD developments</strong>.
					</p>
					<p>
						<strong>TOD-dominated tracts</strong> are tracts where at least <strong>50%</strong> of filtered new units come from TOD developments and
						housing stock increases by at least <strong>2.0%</strong>. <strong>Non-TOD-dominated tracts</strong> meet the same growth threshold but fall
						below that TOD share cutoff. <strong>Minimal-development tracts</strong> stay below the stock-growth threshold.
					</p>
				</div>
				<div class="framing-block">
					<h2>Key assumptions</h2>
					<p>
						This walkthrough uses a fixed <strong>0.5-mile MBTA access threshold</strong> and compares tract-level housing growth, TOD share, and
						transit access descriptively rather than causally.
					</p>
					<p>
						Mismatch categories are based on how transit access and housing growth compare within the tract set, and the averages shown in the
						walkthrough treat each tract equally rather than weighting by population or total units.
					</p>
				</div>
			</div>
		</section>


		<!-- <section class="story card full-width">
			<h2>Guided walkthrough: where the mismatch appears</h2>
			<p>
				The map below is the guided part of the story. It introduces one layer at a time so the reader can see how transit
				access, housing growth, mismatch, and lower-income context build on one another. The point is not simply to identify
				where transit is strongest, but to notice where expected growth does not follow and where that has broader social
				consequences.
			</p>
			<ul class="story-list">
				<li><strong>First:</strong> establish the geography of strong MBTA access.</li>
				<li><strong>Then:</strong> compare that geography to where housing growth has actually occurred.</li>
				<li><strong>Then:</strong> isolate the mismatch layer, which is the core analytical claim.</li>
				<li><strong>Finally:</strong> bring in lower-income context to show why the mismatch matters beyond a purely spatial planning question.</li>
			</ul>
		</section> -->

		{#if tractLoading}
			<div class="loading-status">
				<div class="spinner" aria-hidden="true"></div>
				<p>Loading tract data…</p>
			</div>
		{:else if tractError}
			<div class="loading-status loading-status--error">
				<h3>Failed to load tract data</h3>
				<p>{tractError}</p>
			</div>
		{:else}
			<section class="chart-card card full-width">
				<h3>Transit access and new housing growth do not consistently align across Greater Boston tracts</h3>
				<p class="chart-note">
					As you move through the walkthrough, the map progresses from transit access, to housing growth, to mismatch, and then
					to lower-income context. Blue tract fill indicates stronger housing growth, red indicates weaker or negative growth,
					and purple outlines identify the tracts where transit access and growth no longer move together in the expected way.
					The full exploration interface comes afterward, once that argument has been established more clearly. You can also
					hover over tracts and development dots throughout the map to see tooltips with more detail.
				</p>
				<p class="chart-note">
					For readability, tract tooltips and example cards use short labels like <strong>“Tract in Suffolk County”</strong> rather than full census tract identifiers. Those labels are there to help orient the viewer quickly, not to imply that the analysis itself is only happening at the county level.
				</p>
				<div class="chart-wrap chart-tall chart-wrap--poc-map">
					<PocNhgisTractMap
						panelState={pocMapPanel}
						tractList={tractListFiltered}
						nhgisRows={nhgisLikeRows}
						metricsDevelopments={tractWindowDevs}
						guidedMode={true}
					/>
				</div>
			</section>

			<section class="story card">
				<h2>Three places to notice</h2>
				<p class="chart-note">
					These are useful anchors while you scroll. They are not the only places that matter, but they make the regional
					argument easier to interpret because they show different relationships between transit access and housing growth.
				</p>
				<div class="annotation-grid">
					<div class="annotation-card">
						<h3>Boston and Cambridge</h3>
						<p>These municipalities anchor the strongest rapid-transit system in the region.</p>
						<p>They matter because they show the expected case most clearly: dense transit access and substantial housing growth in the same part of the map.</p>
						<p>At the same time, not every tract here grows equally. That unevenness matters, because it reminds us that being near strong transit does not automatically produce the same development outcome everywhere.</p>
					</div>
					<div class="annotation-card">
						<h3>Quincy and Revere</h3>
						<p>These are useful comparison cases because they sit within the broader transit system but do not reproduce the same growth pattern everywhere.</p>
						<p>They matter because the mismatch question is not only about the inner core. Nearby tracts can share transit context while still showing different housing outcomes.</p>
						<p>That variation makes the planning problem more concrete: access alone does not tell us where growth will actually occur.</p>
					</div>
					<div class="annotation-card">
						<h3>Outer-ring tracts west of Boston</h3>
						<p>Some highlighted tracts farther from the strongest MBTA access still show meaningful growth.</p>
						<p>They matter because they reveal the reverse side of the mismatch story: growth can occur without equivalent transit access.</p>
						<p>That is important for the gentrification argument because it suggests new housing growth is not consistently being steered toward the most transit-rich places, even though those are often framed as the most equitable places to add housing.</p>
					</div>
				</div>
			</section>


			<section class="story card">
				<h2>How can we identify demographic changes associated with TOD?</h2>
				<p>
					Development, transit-oriented or otherwise, often results in demographic change. In order to
					isolate the influence of TOD from the influence of development generally, we use three of the
					census tract groups defined in the previous section.
				</p>
				<ul class="story-list story-list--nested">
					<li>
						<strong>Minimal development tracts</strong> (less than 2% increase in housing stock): These are
						likely to show different demographic changes than high-development tracts and are filtered out of
						the demographic analysis.
					</li>
					<li>
						High-development tracts: Census tracts with at least 2% increase in housing
						stock. These tracts are divided into two groups to differentiate between the effects of TOD and
						non-TOD development:
						<ul>
							<li>
								<strong>TOD-dominated tracts</strong>: High-development tracts where TOD units make up at
								least 50% of new development.
							</li>
							<li>
								<strong>Non-TOD-dominated tracts</strong>: High-development tracts where TOD units make up
								less than 50% of new development.
							</li>
						</ul>
					</li>
				</ul>
			</section>

			<!-- Income / education tract analysis (reinstated from earlier POC story layout) -->
			<div class="story-chart-row story-chart-row--tract full-width">
				<section class="story card story-chart-text">
					<h2>Income analysis</h2>
					<p>
						We can get a sense of the socioeconomic distribution of people by looking at the median income
						of a neighborhood. In census tracts dominated by TOD, the median income changes by
						<strong>{incomeRow.fmtTod}</strong>, while in non-TOD dominated tracts it changes by
						<strong>{incomeRow.fmtCtrl}</strong>, and in minimal development tracts by
						<strong>{incomeRow.fmtMinimal}</strong>. This is one proxy for neighborhood change and possible
						market pressure, though it should not be read as direct evidence that TOD itself caused these
						shifts.
					</p>
					<p>
						If TOD-dominated tracts show larger income increases, that is consistent with stronger
						socioeconomic sorting or housing-market pressure, though other urban factors may also contribute.
					</p>
					{#if incomeMiniBar}
						<figure class="cohort-mini-bar">
							<svg
								width={incomeMiniBar.W}
								height={incomeMiniBar.H}
								viewBox="0 0 {incomeMiniBar.W} {incomeMiniBar.H}"
								role="img"
								aria-label="Bar chart: population-weighted mean median income change in percent for TOD-dominated, non-TOD-dominated, and minimal-development tracts, matching the summary values above."
							>
								<line
									x1={incomeMiniBar.m.l - 0.5}
									y1={incomeMiniBar.m.t}
									x2={incomeMiniBar.m.l - 0.5}
									y2={incomeMiniBar.m.t + incomeMiniBar.ih}
									stroke="#cbd5e1"
									stroke-width="1"
								/>
								{#each incomeMiniBar.yAxisTicks as tick (tick.t)}
									<line
										x1={incomeMiniBar.m.l}
										y1={tick.yPx}
										x2={incomeMiniBar.m.l + incomeMiniBar.mInner}
										y2={tick.yPx}
										stroke="#f1f5f9"
										stroke-width="1"
									/>
									<text
										x={incomeMiniBar.m.l - 5}
										y={tick.yPx}
										text-anchor="end"
										dominant-baseline="middle"
										fill="var(--muted, #5e6573)"
										font-size="9"
									>
										{tick.label}
									</text>
								{/each}
								<line
									x1={incomeMiniBar.m.l}
									y1={incomeMiniBar.y0px}
									x2={incomeMiniBar.m.l + incomeMiniBar.mInner}
									y2={incomeMiniBar.y0px}
									stroke="#94a3b8"
									stroke-width="1"
									stroke-dasharray="3 2"
									opacity="0.85"
								/>
								{#each incomeMiniBar.bars as b (b.id)}
									<rect
										x={b.xPx}
										y={b.yPx}
										width={b.wPx}
										height={b.hPx}
										fill={b.fill}
										rx="1"
									>
										<title
											>{b.shortLabel}: {formatYMetricSummary(b.v, incomeRow.kind)} (population-weighted mean)</title
										>
									</rect>
									<text
										x={b.xPx + b.wPx / 2}
										y={b.labelY}
										text-anchor="middle"
										font-size="9"
										font-weight="600"
										fill="var(--ink, #1f2430)"
									>
										{b.valueLabel}
									</text>
									<text
										x={b.xPx + b.wPx / 2}
										y={incomeMiniBar.m.t + incomeMiniBar.ih + 13}
										text-anchor="middle"
										fill="var(--ink, #1f2430)"
										font-size="9"
									>
										{b.shortLabel}
									</text>
								{/each}
							</svg>
							<figcaption class="cohort-mini-bar__cap">
								Population-weighted tract means (same cohorts as the scatter); axis uses median income change
								({incomeRow.kind === 'pp' ? 'percentage points' : 'percent'}).
							</figcaption>
						</figure>
					{:else}
						<figure class="cohort-mini-bar cohort-mini-bar--empty">
							<p class="cohort-mini-bar__cap">
								Bar chart of population-weighted means will appear when tract data includes enough
								non-missing values for this metric.
							</p>
						</figure>
					{/if}

				</section>

				<section class="chart-card card story-chart-plot">
					<h3>TOD intensity vs median income change</h3>
					<p class="chart-note">
						This plot shows that not only does TOD correspond to greater income jumps than non-TOD,
						but also that higher TOD intensity is associated with larger income changes within the observed tract sample.
						Hover for tract details and click points if you want to hold onto a few comparisons.
					</p>
					<div class="scatter-container scatter-container--compact">
						<TodIntensityScatter panelState={incomePanelState} wideLayout showTrimControl={false} />
					</div>
				</section>
			</div>

			<div class="story-chart-row story-chart-row--tract full-width">
				<section class="story card story-chart-text">
					<h2>Education analysis</h2>
					<p>
						Another indicator of socioeconomic change is the percentage of people who are college-educated.
						In TOD-dominated tracts, the bachelor's degree share changes by
						<strong>{eduRow.fmtTod}</strong>, compared to
						<strong>{eduRow.fmtCtrl}</strong> in non-TOD dominated tracts and
						<strong>{eduRow.fmtMinimal}</strong> in minimal development tracts. This is another proxy for
						neighborhood change. Because most adults do not gain bachelor's degrees rapidly within a decade,
						changes often reflect turnover, replacement, or selective in-migration.
					</p>
					{#if eduMiniBar}
						<figure class="cohort-mini-bar">
							<svg
								width={eduMiniBar.W}
								height={eduMiniBar.H}
								viewBox="0 0 {eduMiniBar.W} {eduMiniBar.H}"
								role="img"
								aria-label="Bar chart: population-weighted mean change in bachelor degree share (percentage points) for TOD-dominated, non-TOD-dominated, and minimal-development tracts, matching the summary values above."
							>
								<line
									x1={eduMiniBar.m.l - 0.5}
									y1={eduMiniBar.m.t}
									x2={eduMiniBar.m.l - 0.5}
									y2={eduMiniBar.m.t + eduMiniBar.ih}
									stroke="#cbd5e1"
									stroke-width="1"
								/>
								{#each eduMiniBar.yAxisTicks as tick (tick.t)}
									<line
										x1={eduMiniBar.m.l}
										y1={tick.yPx}
										x2={eduMiniBar.m.l + eduMiniBar.mInner}
										y2={tick.yPx}
										stroke="#f1f5f9"
										stroke-width="1"
									/>
									<text
										x={eduMiniBar.m.l - 5}
										y={tick.yPx}
										text-anchor="end"
										dominant-baseline="middle"
										fill="var(--muted, #5e6573)"
										font-size="9"
									>
										{tick.label}
									</text>
								{/each}
								<line
									x1={eduMiniBar.m.l}
									y1={eduMiniBar.y0px}
									x2={eduMiniBar.m.l + eduMiniBar.mInner}
									y2={eduMiniBar.y0px}
									stroke="#94a3b8"
									stroke-width="1"
									stroke-dasharray="3 2"
									opacity="0.85"
								/>
								{#each eduMiniBar.bars as b (b.id)}
									<rect
										x={b.xPx}
										y={b.yPx}
										width={b.wPx}
										height={b.hPx}
										fill={b.fill}
										rx="1"
									>
										<title
											>{b.shortLabel}: {formatYMetricSummary(b.v, eduRow.kind)} (population-weighted mean)</title
										>
									</rect>
									<text
										x={b.xPx + b.wPx / 2}
										y={b.labelY}
										text-anchor="middle"
										font-size="9"
										font-weight="600"
										fill="var(--ink, #1f2430)"
									>
										{b.valueLabel}
									</text>
									<text
										x={b.xPx + b.wPx / 2}
										y={eduMiniBar.m.t + eduMiniBar.ih + 13}
										text-anchor="middle"
										fill="var(--ink, #1f2430)"
										font-size="9"
									>
										{b.shortLabel}
									</text>
								{/each}
							</svg>
							<figcaption class="cohort-mini-bar__cap">
								Population-weighted tract means (same cohorts as the scatter); axis shows bachelor’s share
								change ({eduRow.kind === 'pp' ? 'percentage points' : 'other units'}).
							</figcaption>
						</figure>
					{:else}
						<figure class="cohort-mini-bar cohort-mini-bar--empty">
							<p class="cohort-mini-bar__cap">
								Bar chart of population-weighted means will appear when tract data includes enough
								non-missing values for this metric.
							</p>
						</figure>
					{/if}
				</section>

				<section class="chart-card card story-chart-plot">
					<h3>TOD intensity vs bachelor's degree share change</h3>
					<p class="chart-note">
						The same pattern holds for education: tracts with more TOD see larger increases in the share
						of residents with bachelor's degrees or higher. Hover for tract details and click points to keep a few in view.
					</p>
					<div class="scatter-container scatter-container--compact">
						<TodIntensityScatter panelState={eduPanelState} wideLayout showTrimControl={false} />
					</div>
				</section>
			</div>

			<!-- <section class="chart-card card full-width">
				<h3>Income & education summary</h3>
				<p class="chart-note">
					Population-weighted means of income and education changes in the three groups of census tracts.
				</p>
				<div class="chart-wrap chart-wrap--tract-edu" bind:this={elTractEdu}></div>
			</section> -->

			<section class="story card full-width">
				<h2>How affordability could help</h2>
				<!-- <p>
					Among TOD-dominated tracts, we can compare those where <strong>at least half</strong> of new
					development is affordable (≥{(affSplitCohorts.affSplitThreshold * 100).toFixed(0)}% affordable share)
					to those where <strong>less than half</strong> is affordable.
					Comparing these two groups reveals whether affordability moderates
					the demographic changes associated with TOD.
				</p>
				{#if affIncomeRow && affEduRow}
					<p>
						In TOD tracts with a higher affordable share, median income changes by
						<strong>{affIncomeRow.fmtHi}</strong> (vs. <strong>{affIncomeRow.fmtLo}</strong> in
						low-affordable TOD tracts). For education, the bachelor's share changes by
						<strong>{affEduRow.fmtHi}</strong> vs. <strong>{affEduRow.fmtLo}</strong>.
						This suggests that TOD tracts with more affordability may experience smaller socioeconomic shifts
						on average, though the comparison is still descriptive rather than causal.
					</p>
				{/if} -->
				<p>
					Among TOD-dominated tracts, we compare those where at least half of new development is affordable (≥50% affordable share) to those where less than half is affordable. Comparing these two groups reveals whether affordability moderates the demographic changes associated with TOD.
				</p>
				<p>
					In TOD tracts with a higher affordable share, median income changes by <strong>69.33%</strong> (vs. <strong>88.11%</strong> in low-affordable TOD tracts). For education, the bachelor's share changes by <strong>12.56 pp</strong> vs. <strong>16.36 pp</strong>. This suggests that TOD tracts with more affordability may experience smaller socioeconomic shifts on average, though the comparison is still descriptive rather than causal.
				</p>
				<p>
					More figures will be added soon.
				</p>
			</section>

			<section class="story card">
				<h2>What does this tell us?</h2>
				<p>
					Transit-oriented development is a powerful tool for addressing the housing crisis, and there are many regions
					particularly ripe for TOD. However, the current patterns of TOD are associated with demographic changes
					that suggest increased displacement pressure, particularly for lower-income households. In order to mitigate
					these issues, it is important to ensure that TOD projects include a substantial number of affordable housing units--
					particularly in lower-income and more at-risk communities.
				</p>
			</section>
		{/if}
	</section>

	</div>

	{#if muniLoaded && !tractLoading && !tractError}
		<div class="explore-after-narrow">
			<section class="explore-gate card full-width" aria-labelledby="explore-gate-heading">
				<h2 id="explore-gate-heading">Explore the map for yourself</h2>
				<p>
					If you want to keep exploring after the guided story, the full interactive choropleth and toggleable map tools now live on their own page.
				</p>
				<p class="explore-gate__cta">
					<a class="explore-gate__button" href={`${base}/playground`}>Open the playground</a>
				</p>
			</section>

			<section class="story card full-width sources-card">
				<h2>Data sources and acknowledgments</h2>
				<p>
					This project brings together tract-level census data, tract geometry, MBTA stops and line data, and project-level
					housing development records. In the current application, those processed assets are loaded as
					<code>tract_data.json</code>, <code>tracts.geojson</code>, <code>developments.json</code>,
					<code>mbta_stops.json</code>, <code>mbta_lines.geojson</code>, and <code>meta.json</code>. Together, they let us compare
					housing growth, transit access, TOD-related development, and lower-income context in the same regional frame.
				</p>
				<ul class="story-list sources-list">
					<li>
						<strong>NHGIS / U.S. Census tract data:</strong> provides tract-level housing-unit counts, housing growth,
						median household income, income change, and other demographic measures that anchor both the choropleth and the
						lower-income context in the walkthrough.
					</li>
					<li>
						<strong>Tract geometry:</strong> census tract boundary geometries are used to draw the base choropleth, support
						linked tract selection, and make it possible to compare neighboring places directly on the map.
					</li>
					<li>
						<strong>MassBuilds development records:</strong> provide project-level unit counts, affordable-unit fields,
						multifamily share, completion year, and tract assignment. Those records drive the TOD / non-TOD tract grouping,
						the project-dot layer, and the examples used later in the guided story.
					</li>
					<li>
						<strong>HUD LIHTC match where available:</strong> supplements affordability information for some development
						records when affordable-unit data is not complete in the base project file, helping us say a little more about
						who may or may not benefit from new housing.
					</li>
					<li>
						<strong>MBTA stops and line geometry:</strong> provide the transit network used both for display and for
						calculating project proximity to transit and tract-level stop access, which is what makes the TOD and mismatch
						classifications possible.
					</li>
				</ul>
				<p>
					This proof of concept also reflects substantial course feedback and repeated revision. The current page was shaped by
					iteration on the story, layout, and interaction design so that the final experience would guide readers toward the
					main planning question before opening into a fuller interactive exploration tool.
				</p>
			</section>
		</div>
	{/if}
</div>

<style>
	/* ── Warm editorial theme (matches static/municipal/index.html) ── */
	.poc-root {
		--bg: #f5f2eb;
		--paper: #fffdf8;
		--ink: #1f2430;
		--muted: #5e6573;
		--line: #d8d2c7;
		--accent: #00843d;
		--accent-soft: #d8efe2;
		--warning: #ed8b00;
		--warning-soft: #fbe6cc;
		--blue-1: #edf4ff;
		--blue-2: #bfd6f6;
		--blue-3: #6fa8dc;
		--blue-4: #2f6ea6;
		--blue-5: #003da5;
		--shadow: 0 14px 34px rgba(31, 36, 48, 0.08);
		--radius: 18px;

		/* Light-mode tokens for embedded charts (TodIntensityScatter, D3) — darker than app :root dark theme */
		--text: #1f2430;
		--text-muted: #3d4a5c;
		--border: #b8b0a3;
		--bg-hover: #e8e0d4;
		--bg-card: #fffdf8;
		--cat-a: #006b32;
		--radius-sm: 6px;
		--shadow-sm: 0 4px 14px rgba(31, 36, 48, 0.12);

		/* mainPocTractCharts.js — same as MainPocTractDashboard warm theme */
		--mpc-ink: #1f2430;
		--mpc-muted: #454d5c;
		--mpc-line: #d8d2c7;
		--mpc-paper: #fffdf8;
		--mpc-bg: #f5f2eb;
		--mpc-accent: #00843d;
		--mpc-accent-soft: #d8efe2;
		--mpc-warning: #ed8b00;
		--mpc-blue5: #003da5;

		--poc-max-width: 1680px;

		font-family: var(--font-body);
		color: var(--ink);
		background: var(--bg);
		max-width: var(--poc-max-width);
		margin: 0 auto;
		padding: 18px 22px 36px;
	}

	/* 75% of the main column max width — keeps long-form narrative readable; explore map stays wide below. */
	.poc-pre-explore {
		max-width: calc(var(--poc-max-width) * 0.75);
		margin-inline: auto;
		width: 100%;
	}

	.explore-after-narrow {
		margin-top: 14px;
		display: grid;
		gap: 18px;
	}

	.explore-gate {
		padding: 18px 20px;
		display: grid;
		gap: 10px;
	}

	.explore-gate h2 {
		margin: 0;
		font-size: 1.2rem;
	}

	.explore-gate p {
		margin: 0;
		color: var(--muted);
		line-height: 1.55;
		max-width: 58rem;
	}

	.explore-gate__cta {
		margin-top: 6px;
	}

	.explore-gate__button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 10px 16px;
		border-radius: 999px;
		background: var(--accent);
		color: #fff;
		font-weight: 700;
		text-decoration: none;
		box-shadow: 0 6px 18px rgba(0, 132, 61, 0.18);
	}

	.explore-gate__button:hover {
		background: #0a6a38;
	}

	.sources-card {
		margin-top: 6px;
	}

	* { box-sizing: border-box; }

	h1, h2, h3 { margin-top: 0; }

	h1 {
		margin-bottom: 14px;
		font-size: clamp(2rem, 4vw, 3.4rem);
		line-height: 1.02;
		letter-spacing: -0.03em;
	}

	.card {
		background: var(--paper);
		border: 1px solid rgba(120, 114, 102, 0.14);
		border-radius: 12px;
		box-shadow: none;
	}

	/* ── Hero ─────────────────────────────────────────── */
	.hero-full {
		padding: 20px 22px;
		margin-bottom: 14px;
	}

	.eyebrow {
		display: inline-block;
		margin-bottom: 8px;
		padding: 0;
		border-radius: 0;
		background: transparent;
		color: var(--accent);
		font-weight: 700;
		font-size: 0.74rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.subtitle { color: var(--muted); line-height: 1.58; margin-bottom: 0; }

	/* ── Dashboard layout ─────────────────────────────── */
	.dashboard {
		display: grid;
		gap: 14px;
	}

	.controls-bar {
		padding: 14px 16px;
	}

	.controls-header {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: end;
		flex-wrap: wrap;
	}

	.controls-bar h2 { margin-bottom: 6px; font-size: 1.05rem; }
	.controls-note { color: var(--muted); line-height: 1.5; font-size: 0.9rem; margin: 0; }
	.controls-reset { white-space: nowrap; }

	.controls-grid,
	.advanced-grid {
		display: grid;
		gap: 12px;
	}

	.controls-grid {
		grid-template-columns: minmax(260px, 1.35fr) minmax(220px, 1fr) minmax(220px, 1fr);
		align-items: end;
		margin-top: 14px;
	}

	.advanced-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		margin-top: 14px;
	}

	.control-field {
		min-width: 0;
	}

	.control-field--range {
		max-width: 420px;
	}

	.control-block + .control-block {
		margin-top: 0;
		padding-top: 0;
		border-top: 0;
	}

	.label {
		display: block;
		margin-bottom: 8px;
		font-weight: 700;
		font-size: 0.9rem;
	}

	.range-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}

	.play-row {
		display: flex;
		gap: 10px;
		align-items: center;
	}

	.play-row button { flex: 0 0 auto; min-width: 92px; }

	.play-slider-wrap { flex: 1 1 auto; }
	.play-caption { margin-top: 6px; font-size: 0.84rem; color: var(--muted); }

	input[type="number"], select, input[type="search"] {
		width: 100%;
		padding: 9px 10px;
		border: 1px solid #c9c1b4;
		border-radius: 8px;
		background: #fff;
		color: var(--ink);
		font: inherit;
	}

	input[type="range"] { width: 100%; }

	.check-grid {
		display: grid;
		gap: 8px;
		max-height: 180px;
		overflow: auto;
		padding-right: 4px;
	}

	.check-item {
		display: flex;
		gap: 8px;
		align-items: start;
		font-size: 0.92rem;
		color: var(--muted);
		cursor: pointer;
	}

	.button-row, .preset-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	button {
		font: inherit;
		border: 1px solid #cfc6b8;
		border-radius: 8px;
		padding: 8px 12px;
		background: #fff;
		color: var(--ink);
		cursor: pointer;
		transition: background 120ms ease, border-color 120ms ease;
	}

	button.secondary {
		background: #fff;
		color: var(--ink);
	}

	button:hover {
		background: #faf7f0;
		border-color: #bdb3a4;
	}

	/* ── Content area ─────────────────────────────────── */
	.content {
		display: grid;
		gap: 14px;
	}

	.summary { padding: 16px; }

	.summary-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 10px;
		margin: 12px 0;
	}

	.summary-stat {
		padding: 12px;
		border-radius: 10px;
		background: transparent;
		border: 1px solid var(--line);
	}

	.summary-stat .k {
		color: var(--muted);
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-weight: 700;
	}

	.summary-stat .v {
		margin-top: 6px;
		font-size: 1.7rem;
		font-weight: 800;
		letter-spacing: -0.03em;
	}

	.selection-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 10px;
	}

	.finding-list {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
		margin-top: 12px;
	}

	.finding-item {
		padding: 12px;
		border-radius: 10px;
		background: transparent;
		border: 1px solid var(--line);
	}

	.finding-kicker {
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
		margin-bottom: 6px;
	}

	.finding-item p {
		color: var(--muted);
		line-height: 1.5;
		margin: 0;
	}

	.chip {
		padding: 5px 8px;
		border-radius: 8px;
		background: transparent;
		border: 1px solid var(--line);
		color: #433d34;
		font-size: 0.85rem;
		font-weight: 500;
	}

	/* ── Story / narrative cards ──────────────────────── */
	.story {
		padding: 18px;
	}

	.story h2 { font-size: 1.2rem; margin-bottom: 10px; }
	.story p { color: var(--muted); line-height: 1.58; margin-bottom: 12px; }
	.story p:last-child { margin-bottom: 0; }

	.hero-plan-note {
		margin-top: 14px;
		font-size: 0.95rem;
		color: var(--muted);
	}

	.hero-plan-note a {
		color: var(--accent);
		font-weight: 700;
		text-decoration: none;
	}

	.hero-plan-note a:hover {
		text-decoration: underline;
	}

	.story-list {
		color: var(--muted);
		line-height: 1.58;
		padding-left: 22px;
		margin: 10px 0;
		list-style-position: outside;
	}

	.story-list li { margin-bottom: 6px; }

	.plan-section {
		scroll-margin-top: 24px;
	}

	.plan-grid {
		display: grid;
		gap: 14px;
		margin-top: 16px;
	}

	.plan-card {
		padding: 16px;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: #faf7f0;
	}

	.plan-card h3 {
		margin-bottom: 12px;
		font-size: 1.05rem;
	}

	.plan-block + .plan-people {
		margin-top: 14px;
		padding-top: 14px;
		border-top: 1px solid var(--line);
	}

	.plan-people {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
	}

	.plan-block h4,
	.plan-person h4,
	.plan-contingency h3 {
		margin-bottom: 8px;
		font-size: 0.95rem;
	}

	.plan-list {
		margin: 0;
	}

	.plan-contingency {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--line);
	}

	/* Nested methodology list: indent sub-bullets and leave space before the next paragraph */
	.story-list--nested {
		margin-bottom: 18px;
		padding-left: 1.5em;
	}

	.story-list--nested ul {
		margin-top: 8px;
		margin-bottom: 0;
		padding-left: 1.5em;
		list-style-position: outside;
	}

	.story-list--nested > li:last-child > ul > li:last-child {
		margin-bottom: 0;
	}

	.supplemental {
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--line);
	}

	.supplemental summary {
		cursor: pointer;
		font-weight: 700;
		color: var(--ink);
		list-style: none;
	}

	.supplemental summary::-webkit-details-marker {
		display: none;
	}

	.supplemental summary::before {
		content: '+';
		display: inline-block;
		margin-right: 8px;
		font-weight: 700;
		color: var(--accent);
	}

	.supplemental[open] summary::before {
		content: '–';
	}

	.supplemental-grid,
	.supplemental-card {
		margin-top: 14px;
	}

	/* ── Chart cards ──────────────────────────────────── */
	.chart-card { padding: 20px; }
	.chart-card { padding: 16px; }

	.chart-card h2 { font-size: 1.15rem; margin-bottom: 8px; }
	.chart-card h3 { font-size: 1.05rem; margin-bottom: 8px; }

	.chart-note {
		color: var(--muted);
		line-height: 1.55;
		font-size: 0.9rem;
		margin-bottom: 8px;
	}

	.chart-toolbar {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}

	.chart-toolbar select { width: auto; min-width: 210px; }

	.chart-wrap {
		position: relative;
		min-height: 420px;
	}

	.small-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 14px;
	}

	.small-chart { min-height: 320px; }
	.chart-tall { min-height: 560px; }

	/* Tract overview map: full width of card; map uses wheel capture so zoom stays on the map */
	.chart-wrap--poc-map {
		width: 100%;
		max-width: 100%;
		min-height: 560px;
	}

	/* Cohort comparison chart: responsive height, scroll if needed */
	.chart-wrap--tract-edu {
		min-height: 0;
		max-height: min(78vh, 620px);
		overflow: auto;
	}

	.scatter-container {
		display: flex;
		justify-content: center;
		overflow-x: auto;
	}

	.scatter-container--compact {
		justify-content: flex-start;
		max-width: 100%;
	}

	/* Story + chart side-by-side */
	.story-chart-row {
		display: grid;
		gap: 14px;
		align-items: start;
	}

	/* Narrative + chart in one white card (municipal affordability & vulnerability) */
	.story-chart-panel {
		padding: 18px;
	}

	.story-card--embedded {
		margin-top: 12px;
		padding: 0;
		border: 0;
		background: transparent;
	}

	.story-chart-panel__grid {
		display: grid;
		gap: 14px;
		align-items: start;
		grid-template-columns: minmax(0, 1fr) minmax(300px, 1.05fr);
	}

	/* Stacked: narrative uses full card width; chart keeps prior right-column width (1fr : 1.05fr → 1.05/2.05 of row) */
	.story-chart-panel--stacked .story-chart-panel__grid {
		grid-template-columns: 1fr;
	}

	.story-chart-panel--stacked .story-chart-panel__text {
		width: 100%;
		max-width: none;
		justify-self: stretch;
	}

	.story-chart-panel--stacked .story-chart-panel__chart {
		/* Same track sizing intent as minmax(300px, 1.05fr) in the two-column card */
		width: min(100%, max(300px, calc(100% * 1.05 / 2.05)));
		margin-inline: auto;
	}

	.story-chart-panel__text h2 {
		font-size: 1.2rem;
		margin-bottom: 10px;
	}

	.story-chart-panel__text p {
		color: var(--muted);
		line-height: 1.58;
		margin-bottom: 12px;
	}

	.story-chart-panel__text p:last-child {
		margin-bottom: 0;
	}

	.story-chart-panel__chart {
		width: 100%;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.story-chart-panel__chart h3 {
		font-size: 1rem;
		margin-bottom: 8px;
	}

	.story-chart-panel__chart .chart-wrap.small-chart.compact-side-chart {
		flex: 0 0 auto;
		min-height: 0;
		height: auto;
		width: 100%;
	}

	.story-chart-panel .compact-side-chart :global(svg) {
		display: block;
		width: 100%;
		height: auto;
	}

	/* Tract TOD scatters: wider copy column, plot slightly narrower than before */
	.story-chart-row--tract {
		grid-template-columns: minmax(0, 0.36fr) minmax(0, 0.64fr);
		align-items: start;
	}

	.story-chart-row--tract .story-chart-text {
		max-width: 40em;
	}

	.story-chart-row--tract .story-chart-plot {
		max-width: 100%;
		width: 100%;
	}

	.story-chart-text {
		margin: 0;
		max-width: 34em;
	}

	/* Compact cohort means bar: mirrors population-weighted values in the paragraph and scatter */
	.cohort-mini-bar {
		margin: 12px 0 0;
		max-width: 280px;
	}

	.cohort-mini-bar svg {
		display: block;
		max-width: 100%;
		height: auto;
	}

	.cohort-mini-bar__cap {
		font-size: 0.75rem;
		color: var(--muted);
		margin: 6px 0 0;
		line-height: 1.45;
	}

	.story-chart-plot {
		min-width: 0;
	}

	.story-chart-plot h3 {
		font-size: 1rem;
	}

	.story-chart-row--tract .scatter-container--compact {
		width: 100%;
	}

	@media (max-width: 920px) {
		.controls-grid,
		.advanced-grid {
			grid-template-columns: 1fr;
		}

		.finding-list,
		.plan-people,
		.story-chart-panel__grid,
		.story-chart-row--tract {
			grid-template-columns: 1fr;
		}

		.story-chart-panel .compact-side-chart {
			max-height: none;
			min-height: 260px;
		}
	}

	:global(.poc-root .mpc-map-zoom-hint) {
		font-size: 0.78rem;
		color: var(--muted);
		margin: 8px 0 0;
		line-height: 1.45;
	}

	:global(.poc-root .mpc-tract-edu-legend) {
		display: flex;
		flex-wrap: wrap;
		gap: 10px 20px;
		align-items: center;
		margin-bottom: 6px;
		font-size: 0.82rem;
		color: var(--muted);
	}

	:global(.poc-root .mpc-tract-edu-legend-item) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	:global(.poc-root .mpc-tract-edu-swatch) {
		width: 11px;
		height: 11px;
		border-radius: 2px;
		flex-shrink: 0;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
	}

	/* TodIntensityScatter: readable tooltip on warm background */
	:global(.poc-root .tod-intensity-wrap .scatter-tooltip) {
		color: var(--ink);
		border-color: var(--line);
		box-shadow: var(--shadow-sm);
	}

	/* ── Tooltip & legend (global for D3 injected elements) ── */
	:global(.poc-root .tooltip) {
		position: absolute;
		pointer-events: none;
		opacity: 0;
		background: rgba(20, 24, 31, 0.94);
		color: #fff;
		padding: 10px 12px;
		border-radius: 10px;
		font-size: 0.82rem;
		line-height: 1.45;
		width: 230px;
		box-shadow: 0 10px 24px rgba(0, 0, 0, 0.22);
		z-index: 20;
		max-width: 280px;
	}

	:global(.poc-root .tooltip strong) {
		display: block;
		margin-bottom: 4px;
		font-size: 0.9rem;
	}

	:global(.poc-root .legend) {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		color: var(--muted);
		font-size: 0.84rem;
	}

	:global(.poc-root .legend-item) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	:global(.poc-root .legend-scale) {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	:global(.poc-root .legend-ramp) {
		display: inline-grid;
		grid-auto-flow: column;
		gap: 2px;
	}

	:global(.poc-root .legend-ramp span) {
		width: 18px;
		height: 10px;
		border-radius: 999px;
		display: inline-block;
	}

	:global(.poc-root .swatch) {
		width: 12px;
		height: 12px;
		border-radius: 999px;
		display: inline-block;
	}

	:global(.poc-root .chart-note) {
		font-size: 0.85rem;
		color: var(--muted);
		margin: 0 0 8px;
	}

	:global(.poc-root .empty) {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 240px;
		color: var(--muted);
		text-align: center;
		padding: 20px;
		border: 1px dashed var(--line);
		border-radius: 14px;
		background: #faf7f1;
	}

	:global(.poc-root .summary-stat) {
		padding: 14px;
		border-radius: 14px;
		background: #faf7f0;
		border: 1px solid var(--line);
	}

	:global(.poc-root .summary-stat .k) {
		font-size: 0.78rem;
		color: var(--muted);
	}

	:global(.poc-root .summary-stat .v) {
		font-size: 1.15rem;
		font-weight: 700;
	}

	/* NHGIS-style tract globals */
	:global(.poc-root .mpc-tooltip) {
		position: absolute;
		pointer-events: none;
		background: rgba(17, 24, 39, 0.94);
		color: #fff;
		padding: 8px 10px;
		border-radius: 8px;
		font-size: 12px;
		line-height: 1.45;
		opacity: 0;
		z-index: 20;
		max-width: 280px;
	}

	:global(.poc-root .mpc-legend) {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 14px;
		font-size: 0.82rem;
		color: var(--mpc-muted);
	}

	:global(.poc-root .mpc-legend-item) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	:global(.poc-root .mpc-swatch) {
		width: 12px;
		height: 12px;
		border-radius: 3px;
		display: inline-block;
	}

	:global(.poc-root .mpc-legend-scale) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	:global(.poc-root .mpc-legend-ramp span) {
		display: inline-block;
		width: 18px;
		height: 10px;
	}

	:global(.poc-root .mpc-empty) {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 160px;
		color: var(--muted);
		border: 1px dashed var(--line);
		border-radius: 12px;
		background: #faf7f1;
		padding: 16px;
		text-align: center;
	}

	:global(.poc-root .mpc-chart-note) {
		font-size: 0.85rem;
		color: var(--mpc-muted);
		margin: 0 0 8px;
	}

	:global(.poc-root .mpc-summary-stat) {
		padding: 12px;
		border-radius: 10px;
		background: #faf7f0;
		border: 1px solid var(--line);
	}

	:global(.poc-root .mpc-k) {
		font-size: 0.78rem;
		color: var(--muted);
	}

	:global(.poc-root .mpc-v) {
		font-size: 1.1rem;
		font-weight: 700;
	}

	/* ── Tract section ────────────────────────────────── */
	.tract-section {
		margin-top: 18px;
		display: grid;
		gap: 14px;
	}

	.full-width { grid-column: 1 / -1; }

	.subtitle--compact {
		max-width: 760px;
		font-size: 1rem;
	}

	.story--signal {
		display: grid;
		gap: 10px;
	}

	.signal-line {
		margin: 0;
		font-size: 1.05rem;
		line-height: 1.55;
		color: var(--ink);
	}

	.guide-figures {
		display: grid;
		grid-template-columns: 1fr;
		gap: 18px;
		margin-top: 14px;
		max-width: 860px;
	}

	.guide-figure {
		margin: 0;
		padding: 16px;
		display: grid;
		gap: 12px;
	}

	.guide-figure h3 {
		margin: 0;
		font-size: 1rem;
		line-height: 1.35;
	}

	.guide-figure figcaption {
		font-size: 0.94rem;
		line-height: 1.55;
		color: var(--muted);
	}

	.annotation-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 12px;
		margin-top: 12px;
	}

	.annotation-card {
		padding: 14px;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: rgba(255, 253, 248, 0.78);
		display: grid;
		gap: 8px;
	}

	.annotation-card h3 {
		margin: 0;
		font-size: 1rem;
	}

	.annotation-card p {
		margin: 0;
		font-size: 0.94rem;
		line-height: 1.5;
		color: var(--muted);
	}

	/* ── Takeaway cards ───────────────────────────────── */
	.takeaway-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 10px;
		margin-top: 10px;
	}

	.takeaway-card {
		padding: 12px;
		border-radius: 10px;
		background: transparent;
		border: 1px solid var(--line);
	}

	.takeaway-label {
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
		margin-bottom: 8px;
	}

	.takeaway-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 4px;
	}

	.takeaway-dumbbell {
		position: relative;
		height: 132px;
		margin: 10px 0 6px;
	}

	.takeaway-dumbbell--compact {
		height: 110px;
	}

	.takeaway-axis {
		position: absolute;
		left: 0;
		right: 0;
		top: 56px;
		height: 4px;
		border-radius: 999px;
		background: linear-gradient(90deg, #e8e0d4, #ddd3c3);
	}

	.takeaway-dumbbell--compact .takeaway-axis {
		top: 46px;
	}

	.takeaway-dot-group {
		position: absolute;
		top: 0;
		transform: translateX(-50%);
		display: grid;
		justify-items: center;
		gap: 4px;
		min-width: 72px;
		max-width: 92px;
	}

	.takeaway-dot-group--lower {
		top: 24px;
	}

	.takeaway-dot-label {
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
		text-align: center;
		line-height: 1.15;
		white-space: nowrap;
	}

	.takeaway-dot {
		width: 16px;
		height: 16px;
		border-radius: 999px;
		border: 3px solid #fff;
		box-shadow: 0 2px 10px rgba(31, 36, 48, 0.15);
		margin-top: 18px;
	}

	.takeaway-dumbbell--compact .takeaway-dot {
		margin-top: 12px;
	}

	.takeaway-dot-group.tod .takeaway-dot,
	.takeaway-dot-group.hi-aff .takeaway-dot {
		background: var(--accent);
	}

	.takeaway-dot-group.ctrl .takeaway-dot {
		background: #94a3b8;
	}

	.takeaway-dot-group.minimal .takeaway-dot,
	.takeaway-dot-group.lo-aff .takeaway-dot {
		background: #c9bfaf;
	}

	.takeaway-dot-value {
		font-size: 0.95rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--ink);
		white-space: nowrap;
		background: rgba(255, 253, 248, 0.96);
		padding: 0 4px;
		border-radius: 6px;
	}

	.takeaway-meta {
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--line);
		display: grid;
		gap: 6px;
	}

	.takeaway-statline {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 14px;
		font-size: 0.9rem;
		color: var(--muted);
	}

	.takeaway-statline strong {
		color: var(--ink);
		font-size: 1rem;
		font-variant-numeric: tabular-nums;
	}

	.takeaway-tag {
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 3px 8px;
		border-radius: 999px;
		min-width: 60px;
		text-align: center;
	}

	.takeaway-tag.tod { background: var(--accent-soft); color: #0b5e2c; }
	.takeaway-tag.ctrl { background: #e2e8f0; color: #475569; }
	.takeaway-tag.minimal { background: #f1f5f9; color: #64748b; }
	.takeaway-tag.hi-aff { background: #d1fae5; color: #065f46; }
	.takeaway-tag.lo-aff { background: #f5f5f4; color: #57534e; }

	.takeaway-value {
		font-size: 1.1rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.story--framing {
		padding-top: 18px;
		padding-bottom: 18px;
	}

	.framing-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 18px;
	}

	.framing-block {
		padding: 16px 18px;
		border: 1px solid var(--line);
		border-radius: 18px;
		background: rgba(248, 249, 245, 0.78);
	}

	.framing-block h2 {
		margin: 0 0 10px;
		font-size: 1.05rem;
	}

	.framing-block p {
		margin: 0;
		color: var(--muted);
		line-height: 1.6;
	}

	.framing-block p + p {
		margin-top: 10px;
	}

	/* ── Conclusion ───────────────────────────────────── */
	.conclusion {
		border-left: 4px solid var(--accent);
	}

	/* ── Loading ──────────────────────────────────────── */
	.loading-status {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 16px;
		min-height: 200px;
		color: var(--muted);
	}

	.loading-status--error h3 { color: #c0392b; font-size: 1.1rem; margin: 0; }

	.spinner {
		width: 40px;
		height: 40px;
		border: 3px solid var(--line);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin { to { transform: rotate(360deg); } }

	/* ── Responsive ───────────────────────────────────── */
	@media (max-width: 1060px) {
		.dashboard, .small-grid, .summary-grid, .framing-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
