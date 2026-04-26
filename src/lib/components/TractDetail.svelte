<script>
	/**
	 * Tract detail cards: joins ``panelState.selectedTracts`` to ``tractData`` rows and surfaces
	 * period-aware census / development / transit fields plus a D3 stacked race composition mini-chart.
	 */
	import * as d3 from 'd3';
	import { tractData, developments, meta } from '$lib/stores/data.svelte.js';
	import {
		filterTractsByTract,
		buildFilteredData,
		getScatterXValue,
		developmentAffordableUnitsCapped
	} from '$lib/utils/derived.js';
	import { periodCensusBounds } from '$lib/utils/periods.js';

	let {
		panelState,
		/**
		 * ``full`` — aggregate (2+ tracts) plus up to 10 per-tract cards (tract dashboard).
		 * ``compact`` — tabs: combined totals vs a single “latest” tract only (home explore sidebar).
		 */
		sidebarMode = 'full',
		/** When true, hide “Select all” (avoid huge selections in compact sidebars). */
		hideBulkActions = false,
		/** If set, aggregate / tract X-axis inspection tables only list these ``meta.xVariables`` keys. */
		allowedXAxisKeys = null,
		/**
		 * Focused tract summary from ``PocNhgisTractMap`` (parent binds ``mapFocusedTractDetail``).
		 * Shown above tract cards when present.
		 */
		mapChoroplethDetail = null,
		/** ``(gisjoin) => void`` from bound ``mapViewActions.zoomToTract`` on the map. */
		onChoroplethZoom = undefined
	} = $props();

	/** @type {'aggregate' | 'latest'} */
	let activeTab = $state('aggregate');

	const minAggregateTracts = $derived(sidebarMode === 'compact' ? 1 : 2);

	/** X-axis rows for inspection tables (optionally restricted to ``allowedXAxisKeys``). */
	const xVarsForDisplay = $derived.by(() => {
		const all = meta.xVariables ?? [];
		if (!allowedXAxisKeys?.length) return all;
		const allow = new Set(allowedXAxisKeys);
		return all.filter((v) => allow.has(v.key));
	});

	/** Aggregate development stats per tract per decade, plus 1990–2020 window from completion year. */
	const devByTractDecade = $derived.by(() => {
		const m = new Map();
		for (const d of developments) {
			const key = `${d.gisjoin}_${d.decade}`;
			if (!m.has(key)) {
				m.set(key, { new_units: 0, new_affordable: 0, multifam: 0 });
			}
			const agg = m.get(key);
			agg.new_units += d.hu;
			agg.new_affordable += developmentAffordableUnitsCapped(d);
			agg.multifam += d.smmultifam + d.lgmultifam;

			// Multi-decade windows: aggregate completions by year range
			const y = d.completion_year;
			if (y != null && y >= 2000 && y <= 2020) {
				const k00 = `${d.gisjoin}_00_20`;
				if (!m.has(k00)) {
					m.set(k00, { new_units: 0, new_affordable: 0, multifam: 0 });
				}
				const a00 = m.get(k00);
				a00.new_units += d.hu;
				a00.new_affordable += developmentAffordableUnitsCapped(d);
				a00.multifam += d.smmultifam + d.lgmultifam;
			}
			if (y != null && y >= 1990 && y <= 2020) {
				const k90 = `${d.gisjoin}_90_20`;
				if (!m.has(k90)) {
					m.set(k90, { new_units: 0, new_affordable: 0, multifam: 0 });
				}
				const a90 = m.get(k90);
				a90.new_units += d.hu;
				a90.new_affordable += developmentAffordableUnitsCapped(d);
				a90.multifam += d.smmultifam + d.lgmultifam;
			}
		}
		return m;
	});

	const selectedList = $derived([...panelState.selectedTracts]);

	/**
	 * Tract to show in the compact “Latest” tab: last clicked/toggled, else last in selection order.
	 */
	const focusGisjoin = $derived.by(() => {
		if (selectedList.length === 0) return null;
		const last = panelState.lastInteractedGisjoin;
		if (last && selectedList.some((g) => g === last)) return last;
		return selectedList[selectedList.length - 1];
	});

	/** All tracts currently passing census tract filters (for select-all). */
	const filteredGisjoins = $derived.by(() => {
		return filterTractsByTract(tractData, panelState).map((t) => t.gisjoin);
	});

	function selectAllFiltered() {
		panelState.selectAll(filteredGisjoins);
	}

	/**
	 * Development aggregation under current panel filters — matches scatter X-axis sourcing.
	 */
	const panelDevAgg = $derived.by(() => {
		return buildFilteredData(tractData, developments, panelState).devAgg;
	});

	/** Y-axis variables grouped like the Time & Axes control (for readable inspection lists). */
	const groupedYVars = $derived.by(() => {
		const groups = [];
		const seen = new Set();
		for (const v of meta.yVariables ?? []) {
			if (!seen.has(v.cat)) {
				seen.add(v.cat);
				groups.push({ cat: v.cat, catLabel: v.catLabel, vars: [] });
			}
			groups.find((g) => g.cat === v.cat)?.vars.push(v);
		}
		return groups;
	});

	/** Aggregate summary of all selected tracts. */
	const aggregate = $derived.by(() => {
		if (selectedList.length < minAggregateTracts) return null;
		const { startY, endY, tag } = periodCensusBounds(panelState.timePeriod);
		const byGj = new Map();
		for (const t of tractData) if (t.gisjoin) byGj.set(t.gisjoin, t);

		let popStart = 0, popEnd = 0, huStart = 0, huEnd = 0;
		let totalNewUnits = 0, totalAffordable = 0, totalMultifam = 0;
		const yVals = {};
		let tractCount = 0;

		for (const gid of selectedList) {
			const t = byGj.get(gid);
			if (!t) continue;
			tractCount++;
			popStart += Number(t[`pop_${startY}`]) || 0;
			popEnd += Number(t[`pop_${endY}`]) || 0;
			huStart += Number(t[`total_hu_${startY}`]) || 0;
			huEnd += Number(t[`total_hu_${endY}`]) || 0;

			const devKey = `${gid}_${tag}`;
			const da = devByTractDecade.get(devKey);
			if (da) {
				totalNewUnits += da.new_units;
				totalAffordable += da.new_affordable;
				totalMultifam += da.multifam;
			}

			for (const yv of meta.yVariables ?? []) {
				const key = `${yv.key}_${tag}`;
				const val = Number(t[key]);
				if (Number.isFinite(val)) {
					if (!yVals[key]) yVals[key] = [];
					yVals[key].push(val);
				}
			}
		}

		const yMeans = {};
		for (const [k, arr] of Object.entries(yVals)) {
			yMeans[k] = d3.mean(arr);
		}

		/** Per X metric: sum for unit counts, mean otherwise (aligned with per-tract scatter values). */
		const xStats = {};
		const devAgg = panelDevAgg;
		for (const xv of xVarsForDisplay) {
			const vals = [];
			for (const gid of selectedList) {
				const tr = byGj.get(gid);
				const xVal = getScatterXValue(tr, gid, xv.key, devAgg, panelState.timePeriod);
				if (Number.isFinite(xVal)) vals.push(xVal);
			}
			if (vals.length === 0) {
				xStats[xv.key] = null;
				continue;
			}
			const useSum = xv.key === 'new_units' || xv.key === 'new_affordable';
			xStats[xv.key] = useSum ? d3.sum(vals) : d3.mean(vals);
		}

		return {
			tractCount,
			popStart, popEnd,
			huStart, huEnd,
			huChange: huEnd - huStart,
			totalNewUnits, totalAffordable, totalMultifam,
			yMeans,
			xStats
		};
	});

	const tractByGisjoin = $derived.by(() => {
		const m = new Map();
		for (const t of tractData) {
			m.set(t.gisjoin, t);
		}
		return m;
	});

	const period = $derived(periodCensusBounds(panelState.timePeriod));

	/**
	 * @param {unknown} v
	 * @returns {string}
	 */
	function fmtInt(v) {
		if (v == null || Number.isNaN(Number(v))) return '—';
		return d3.format(',.0f')(Number(v));
	}

	/**
	 * @param {unknown} v
	 * @returns {string}
	 */
	function fmtMoney(v) {
		if (v == null || Number.isNaN(Number(v))) return '—';
		return d3.format('$,.0f')(Number(v));
	}

	/**
	 * @param {unknown} v
	 * @returns {string}
	 */
	function fmtPctVal(v) {
		if (v == null || Number.isNaN(Number(v))) return '—';
		return `${Number(v).toFixed(1)}%`;
	}

	/**
	 * @param {unknown} v
	 * @returns {string}
	 */
	function fmtPP(v) {
		if (v == null || Number.isNaN(Number(v))) return '—';
		const n = Number(v);
		const sign = n > 0 ? '+' : '';
		return `${sign}${n.toFixed(1)} pp`;
	}

	/**
	 * @param {unknown} v
	 * @returns {string}
	 */
	function fmtPctChange(v) {
		if (v == null || Number.isNaN(Number(v))) return '—';
		const n = Number(v);
		const sign = n > 0 ? '+' : '';
		return `${sign}${n.toFixed(1)}%`;
	}

	/**
	 * @param {unknown} v
	 * @returns {string}
	 */
	function fmtShare(v) {
		if (v == null || Number.isNaN(Number(v))) return '—';
		return `${(Number(v) * 100).toFixed(1)}%`;
	}

	/**
	 * @param {unknown} v
	 * @returns {string}
	 */
	function fmtBool(v) {
		if (v == null) return '—';
		return v ? 'Yes' : 'No';
	}

	/**
	 * Format a scatter Y-axis field using the same unit conventions as chart metadata labels.
	 *
	 * Parameters
	 * ----------
	 * yKey : string
	 *     Base key from ``meta.yVariables`` (no period suffix).
	 * v : unknown
	 *     Raw numeric value from ``tract[`${yKey}_${tag}`]``.
	 *
	 * Returns
	 * -------
	 * string
	 */
	function formatYAxisValue(yKey, v) {
		if (v == null || !Number.isFinite(Number(v))) return '—';
		if (yKey === 'pop_change_pct' || yKey === 'median_income_change_pct') return fmtPctChange(v);
		if (yKey === 'avg_travel_time_change') return `${Number(v).toFixed(1)} min`;
		return fmtPP(v);
	}

	/**
	 * Format a scatter X-axis field (development aggregates under current filters).
	 *
	 * Parameters
	 * ----------
	 * xKey : string
	 *     Key from ``meta.xVariables``.
	 * v : unknown
	 *     Value from ``getScatterXValue`` / aggregate ``xStats``.
	 *
	 * Returns
	 * -------
	 * string
	 */
	function formatXAxisValue(xKey, v) {
		if (v == null || !Number.isFinite(Number(v))) return '—';
		if (xKey === 'census_hu_change') return `${d3.format('.2f')(v)}%`;
		if (
			xKey === 'pct_stock_increase' ||
			xKey === 'tod_pct_stock_increase' ||
			xKey === 'nontod_pct_stock_increase'
		) {
			return fmtPctChange(v);
		}
		if (xKey === 'multifam_share' || xKey === 'affordable_share') return fmtShare(v);
		return fmtInt(v);
	}

	/** Stacked-bar keys (order); Hispanic uses ``hispanic_*`` when present in tract JSON, else 0. */
	const raceKeys = ['white', 'black', 'hispanic', 'asian', 'other'];
	const raceColors = ['#c5cad8', '#5c4d9e', '#c2410c', '#e8a54b', '#5dbb7a'];
	const raceLegendLabels = ['White', 'Black', 'Hispanic', 'Asian', 'Other'];

	/**
	 * D3 stacked horizontal bars for two census years (start / end of period).
	 *
	 * Parameters
	 * ----------
	 * node : HTMLElement
	 * params : {{ tract: object, startY: string, endY: string }}
	 *
	 * Returns
	 * -------
	 * import('svelte/action').ActionReturn
	 */
	function raceComposition(node, params) {
		let ro;

		function draw() {
			const { tract, startY, endY } = params;
			d3.select(node).selectAll('*').remove();

			const w = Math.max(node.clientWidth || 0, 160);
			const rowH = 12;
			const gap = 6;
			const labelH = 14;
			const legendH = 22;
			const svgH = labelH + rowH + gap + labelH + rowH + 6 + legendH;

			const svg = d3
				.select(node)
				.append('svg')
				.attr('width', w)
				.attr('height', svgH)
				.attr('role', 'img')
				.attr('aria-label', `Racial composition ${startY} vs ${endY}`);

			const rows = [startY, endY].map((y) => {
				const white = +tract[`white_${y}`] || 0;
				const black = +tract[`black_${y}`] || 0;
				const hisp = +tract[`hispanic_${y}`] || 0;
				const asian = +tract[`asian_${y}`] || 0;
				const other = +tract[`other_race_${y}`] || 0;
				const sum = white + black + hisp + asian + other;
				const k = sum ? 1 / sum : 0;
				return {
					year: y,
					white: white * k,
					black: black * k,
					hispanic: hisp * k,
					asian: asian * k,
					other: other * k
				};
			});

			const stack = d3.stack().keys(raceKeys);
			const layers = stack(rows);

			layers.forEach((layer, li) => {
				const fill = raceColors[li];
				layer.forEach((seg, ri) => {
					const x0 = seg[0] * w;
					const x1 = seg[1] * w;
					const bw = Math.max(0, x1 - x0);
					if (bw < 0.25) return;
					const yTop = ri === 0 ? labelH : labelH + rowH + gap + labelH;
					svg
						.append('rect')
						.attr('x', x0)
						.attr('y', yTop)
						.attr('width', bw)
						.attr('height', rowH)
						.attr('fill', fill)
						.attr('opacity', 0.92);
				});
			});

			[startY, endY].forEach((y, ri) => {
				const yTop = ri === 0 ? 0 : labelH + rowH + gap;
				svg
					.append('text')
					.attr('x', 0)
					.attr('y', yTop + 11)
					.attr('fill', 'var(--text-muted)')
					.attr('font-size', '10px')
					.text(y);
			});

			const legY = labelH + rowH + gap + labelH + rowH + 8;
			const leg = svg.append('g').attr('transform', `translate(0,${legY})`);
			const nLeg = raceKeys.length;
			const slot = w / nLeg;
			raceKeys.forEach((k, i) => {
				const lx = i * slot;
				leg
					.append('rect')
					.attr('x', lx)
					.attr('y', 0)
					.attr('width', 6)
					.attr('height', 6)
					.attr('fill', raceColors[i]);
				leg
					.append('text')
					.attr('x', lx + 8)
					.attr('y', 5)
					.attr('fill', 'var(--text-muted)')
					.attr('font-size', '8px')
					.text(raceLegendLabels[i] ?? k);
			});
		}

		draw();
		ro = new ResizeObserver(() => draw());
		ro.observe(node);

		return {
			update(newParams) {
				params = newParams;
				draw();
			},
			destroy() {
				ro.disconnect();
				d3.select(node).selectAll('*').remove();
			}
		};
	}
</script>

<div class="tract-detail" data-meta-y-vars={meta.yVariables?.length ?? 0}>
	<div class="head">
		<h3 class="title">Selected tracts ({selectedList.length})</h3>
		<div class="head-actions">
			{#if !hideBulkActions}
				<button type="button" class="action-btn" onclick={selectAllFiltered}
					title="Select all {filteredGisjoins.length} tracts that pass current filters">
					Select all ({filteredGisjoins.length})
				</button>
			{/if}
			{#if selectedList.length > 0}
				<button type="button" class="action-btn clear" onclick={() => panelState.clearSelection()}>
					Clear
				</button>
			{/if}
		</div>
	</div>

	{#if mapChoroplethDetail}
		<div class="map-choropleth-pin" role="region" aria-label="Map selection summary">
			<div class="map-choropleth-pin__head">
				<div>
					<p class="map-choropleth-pin__kicker">Selected tract</p>
					<p class="map-choropleth-pin__title">{mapChoroplethDetail.title}</p>
				</div>
				<div class="map-choropleth-pin__actions">
					<button
						type="button"
						class="map-choropleth-pin__btn"
						disabled={!onChoroplethZoom}
						onclick={() => onChoroplethZoom?.(mapChoroplethDetail.gisjoin)}
					>
						Zoom to tract
					</button>
					<button
						type="button"
						class="map-choropleth-pin__btn map-choropleth-pin__btn--ghost"
						onclick={() => panelState.clearSelection()}
					>
						Clear
					</button>
				</div>
			</div>
			<div class="map-choropleth-pin__topline">
				<span class="map-choropleth-pin__cohort">{mapChoroplethDetail.cohortLabel}</span>
				{#if mapChoroplethDetail.description}
					<span class="map-choropleth-pin__desc">{mapChoroplethDetail.description}</span>
				{/if}
			</div>
			<div class="map-choropleth-pin__primary">
				<div class="map-choropleth-pin__hero">
					<span class="map-choropleth-pin__lbl">Housing growth</span>
					<span class="map-choropleth-pin__hero-val">
						{mapChoroplethDetail.huGrowth == null
							? '—'
							: `${d3.format('.1f')(mapChoroplethDetail.huGrowth)}%`}
					</span>
				</div>
				<div class="map-choropleth-pin__hero">
					<span class="map-choropleth-pin__lbl">Cohort avg.</span>
					<span class="map-choropleth-pin__hero-val">
						{mapChoroplethDetail.cohortAvgHu == null
							? '—'
							: `${d3.format('.1f')(mapChoroplethDetail.cohortAvgHu)}%`}
					</span>
				</div>
			</div>
			<div class="map-choropleth-pin__stats">
				<div>
					<span class="map-choropleth-pin__lbl">TOD share</span>
					<span class="map-choropleth-pin__stat-val">
						{mapChoroplethDetail.todShare == null
							? '—'
							: `${d3.format('.1f')(mapChoroplethDetail.todShare * 100)}%`}
					</span>
				</div>
				<div>
					<span class="map-choropleth-pin__lbl">Housing stock increase</span>
					<span class="map-choropleth-pin__stat-val">
						{mapChoroplethDetail.stockIncrease == null
							? '—'
							: `${d3.format('.1f')(mapChoroplethDetail.stockIncrease)}%`}
					</span>
				</div>
				<div>
					<span class="map-choropleth-pin__lbl">New units</span>
					<span class="map-choropleth-pin__stat-val">
						{mapChoroplethDetail.newUnits == null
							? '—'
							: d3.format(',.0f')(mapChoroplethDetail.newUnits)}
					</span>
				</div>
				<div>
					<span class="map-choropleth-pin__lbl">Selected tracts</span>
					<span class="map-choropleth-pin__stat-val">{mapChoroplethDetail.countSelected}</span>
				</div>
			</div>
		</div>
	{/if}

	{#if selectedList.length === 0}
		<p class="empty">Click tracts on the map or points on the scatter plot to see details here.</p>
	{:else if sidebarMode === 'compact'}
		<div class="detail-tabs" role="tablist" aria-label="Detail view">
			<button
				type="button"
				role="tab"
				class="detail-tab"
				aria-selected={activeTab === 'aggregate'}
				onclick={() => (activeTab = 'aggregate')}
			>
				Aggregate
			</button>
			<button
				type="button"
				role="tab"
				class="detail-tab"
				aria-selected={activeTab === 'latest'}
				onclick={() => (activeTab = 'latest')}
			>
				Latest tract
			</button>
		</div>
		<div class="scroll scroll--compact">
			{#if activeTab === 'aggregate'}
				{#if aggregate}
					{@render aggregateCard()}
				{/if}
			{:else if focusGisjoin}
				{@render tractCard(focusGisjoin)}
			{/if}
		</div>
	{:else}
		<div class="scroll">
			{#if aggregate}
				{@render aggregateCard()}
			{/if}

			{#if selectedList.length <= 10}
			{#each selectedList as gid (gid)}
				{@render tractCard(gid)}
			{/each}
			{:else}
				<p class="overflow-note">Individual tract cards are hidden when more than 10 tracts are selected. See aggregate summary above.</p>
			{/if}
		</div>
	{/if}
</div>

{#snippet aggregateCard()}
				<article class="card aggregate-card">
					<header class="card-head">
						<div>
							<div class="tract-id">Aggregate ({aggregate.tractCount} tracts)</div>
						</div>
						<div class="period-pill">{period.startY}–{period.endY}</div>
					</header>
					<table class="metrics">
						<thead><tr><th scope="col">Metric</th><th scope="col" class="num">{period.startY}</th><th scope="col" class="num">{period.endY}</th></tr></thead>
						<tbody>
							<tr><td>Population</td><td class="num">{fmtInt(aggregate.popStart)}</td><td class="num">{fmtInt(aggregate.popEnd)}</td></tr>
							<tr><td>Housing units</td><td class="num">{fmtInt(aggregate.huStart)}</td><td class="num">{fmtInt(aggregate.huEnd)}</td></tr>
							{#if aggregate.huStart > 0}
								<tr>
									<td>HU change (census)</td>
									<td colspan="2" class="num">{fmtInt(aggregate.huChange)} ({fmtPctChange((aggregate.huChange / aggregate.huStart) * 100)})</td>
								</tr>
							{/if}
						</tbody>
					</table>
					<section class="axis-inspection">
						<h4 class="subhead">X-axis variables (aggregate)</h4>
						<p class="axis-note">
							Full labels from chart metadata. Census net HU change is from decennial counts (not
							MassBuilds). New units and new affordable (MassBuilds) are summed across the
							selection; other MassBuilds X metrics are means of per-tract scatter values under
							current development filters.
						</p>
						<table class="axis-metrics">
							<thead>
								<tr>
									<th scope="col">Metric</th>
									<th scope="col" class="num">Value</th>
								</tr>
							</thead>
							<tbody>
								{#each xVarsForDisplay as xv (xv.key)}
									<tr>
										<td class="axis-metric-label">{xv.label}</td>
										<td class="num">{formatXAxisValue(xv.key, aggregate.xStats[xv.key])}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</section>
					<section class="axis-inspection">
						<h4 class="subhead">Y-axis variables — mean ({period.tag.replace('_', '–')})</h4>
						<p class="axis-note">
							All tract-level change fields available on the scatter Y axis, with full metadata
							labels.
						</p>
						{#each groupedYVars as group (group.cat)}
							<h5 class="axis-group-title">{group.catLabel}</h5>
							<table class="axis-metrics">
								<thead>
									<tr>
										<th scope="col">Metric</th>
										<th scope="col" class="num">Mean</th>
									</tr>
								</thead>
								<tbody>
									{#each group.vars as yv (yv.key)}
										<tr>
											<td class="axis-metric-label">{yv.label}</td>
											<td class="num">
												{formatYAxisValue(yv.key, aggregate.yMeans[`${yv.key}_${period.tag}`])}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						{/each}
					</section>
					<section class="dev">
						<h4 class="subhead">Development totals ({period.tag.replace('_', '–')})</h4>
						<ul class="dev-grid">
							<li><span class="lbl">New units (MassBuilds)</span><span class="val">{fmtInt(aggregate.totalNewUnits)}</span></li>
							<li><span class="lbl">New affordable</span><span class="val">{fmtInt(aggregate.totalAffordable)}</span></li>
							<li><span class="lbl">Affordable share</span><span class="val">{aggregate.totalNewUnits ? fmtShare(aggregate.totalAffordable / aggregate.totalNewUnits) : '—'}</span></li>
							<li><span class="lbl">Multifamily share</span><span class="val">{aggregate.totalNewUnits ? fmtShare(aggregate.totalMultifam / aggregate.totalNewUnits) : '—'}</span></li>
						</ul>
					</section>
				</article>

{/snippet}

{#snippet tractCard(gid)}
	{@const t = tractByGisjoin.get(gid)}
				<article class="card">
					{#if !t}
						<p class="missing">No tract data for <span class="mono">{gid}</span>.</p>
					{:else}
					<header class="card-head">
						<div>
							<div class="tract-id mono">{t.gisjoin}</div>
							<div class="county">{t.county ?? '—'}</div>
						</div>
						<div class="period-pill">{period.startY}–{period.endY}</div>
					</header>

					{#if t.nom_2000_crosswalked || t.nom_2020_crosswalked}
						<div class="crosswalk-note">
							{#if t.nom_2000_crosswalked && t.nom_2020_crosswalked}
								2000 &amp; 2020 data crosswalked to 2010 geography
							{:else if t.nom_2000_crosswalked}
								2000 data crosswalked to 2010 geography
							{:else}
								2020 data crosswalked to 2010 geography
							{/if}
						</div>
					{/if}

					<table class="metrics">
							<thead>
								<tr>
									<th scope="col">Metric</th>
									<th scope="col" class="num">{period.startY}</th>
									<th scope="col" class="num">{period.endY}</th>
								</tr>
							</thead>
							<tbody>
								<tr>
									<td>Population</td>
									<td class="num">{fmtInt(t[`pop_${period.startY}`])}</td>
									<td class="num">{fmtInt(t[`pop_${period.endY}`])}</td>
								</tr>
								<tr>
									<td>Minority %</td>
									<td class="num">{fmtPctVal(t[`minority_pct_${period.startY}`])}</td>
									<td class="num">{fmtPctVal(t[`minority_pct_${period.endY}`])}</td>
								</tr>
								<tr>
									<td>Housing units</td>
									<td class="num">{fmtInt(t[`total_hu_${period.startY}`])}</td>
									<td class="num">{fmtInt(t[`total_hu_${period.endY}`])}</td>
								</tr>
								{#if t[`total_hu_${period.startY}`] != null && t[`total_hu_${period.endY}`] != null}
									<tr>
										<td>HU change (census)</td>
										<td colspan="2" class="num">
											{fmtInt(t[`total_hu_${period.endY}`] - t[`total_hu_${period.startY}`])} ({fmtPctChange(((t[`total_hu_${period.endY}`] - t[`total_hu_${period.startY}`]) / t[`total_hu_${period.startY}`]) * 100)})
										</td>
									</tr>
								{/if}
								<tr>
									<td>Owner-occupied %</td>
									<td class="num">{fmtPctVal(t[`owner_pct_${period.startY}`])}</td>
									<td class="num">{fmtPctVal(t[`owner_pct_${period.endY}`])}</td>
								</tr>
								<tr>
									<td>Median income</td>
									<td class="num">{fmtMoney(t[`median_income_${period.startY}`])}</td>
									<td class="num">{fmtMoney(t[`median_income_${period.endY}`])}</td>
								</tr>
							</tbody>
						</table>

						<section class="axis-inspection">
							<h4 class="subhead">X-axis variables (tract)</h4>
							<p class="axis-note">
								Census % HU change uses decennial housing stock at period start as the baseline; MassBuilds metrics use filtered
								developments (same as scatter).
							</p>
							<table class="axis-metrics">
								<thead>
									<tr>
										<th scope="col">Metric</th>
										<th scope="col" class="num">Value</th>
									</tr>
								</thead>
								<tbody>
									{#each xVarsForDisplay as xv (xv.key)}
										<tr>
											<td class="axis-metric-label">{xv.label}</td>
											<td class="num">
												{formatXAxisValue(
													xv.key,
													getScatterXValue(t, t.gisjoin, xv.key, panelDevAgg, panelState.timePeriod)
												)}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</section>

						<section class="axis-inspection">
							<h4 class="subhead">Y-axis variables ({period.tag.replace('_', '–')})</h4>
							<p class="axis-note">All census tract change metrics selectable as scatter Y.</p>
							{#each groupedYVars as group (group.cat)}
								<h5 class="axis-group-title">{group.catLabel}</h5>
								<table class="axis-metrics">
									<thead>
										<tr>
											<th scope="col">Metric</th>
											<th scope="col" class="num">Value</th>
										</tr>
									</thead>
									<tbody>
										{#each group.vars as yv (yv.key)}
											<tr>
												<td class="axis-metric-label">{yv.label}</td>
												<td class="num">
													{formatYAxisValue(yv.key, t[`${yv.key}_${period.tag}`])}
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							{/each}
						</section>

						{@const devKey = `${t.gisjoin}_${period.tag}`}
						{@const devAgg = devByTractDecade.get(devKey)}
						<section class="dev">
							<h4 class="subhead">Development ({period.tag.replace('_', '–')})</h4>
							<ul class="dev-grid">
								<li>
									<span class="lbl">New units</span>
									<span class="val">{fmtInt(devAgg?.new_units)}</span>
								</li>
								<li>
									<span class="lbl">New affordable</span>
									<span class="val">{fmtInt(devAgg?.new_affordable)}</span>
								</li>
								<li>
									<span class="lbl">Affordable share</span>
									<span class="val">{devAgg?.new_units ? fmtShare(devAgg.new_affordable / devAgg.new_units) : '—'}</span>
								</li>
								<li>
									<span class="lbl">Multifamily share</span>
									<span class="val">{devAgg?.new_units ? fmtShare(devAgg.multifam / devAgg.new_units) : '—'}</span>
								</li>
							</ul>
						</section>

						<section class="transit">
							<h4 class="subhead">Transit access</h4>
							<ul class="transit-row">
								<li>
									<span class="lbl">MBTA stops (tract + buffer)</span>
									<span class="val">{fmtInt(t.transit_stops)}</span>
								</li>
								<li>
									<span class="lbl">Rapid transit</span>
									<span class="val">{fmtBool(t.has_rail)}</span>
								</li>
								<li>
									<span class="lbl">Commuter rail</span>
									<span class="val">{fmtBool(t.has_commuter_rail)}</span>
								</li>
								<li>
									<span class="lbl">Area (mi²)</span>
									<span class="val">{t.area_sq_mi != null ? d3.format('.3f')(t.area_sq_mi) : '—'}</span>
								</li>
							</ul>
						</section>

						<section class="race">
							<h4 class="subhead">Racial composition (share of tract pop.)</h4>
							<div
								class="race-host"
								use:raceComposition={{ tract: t, startY: period.startY, endY: period.endY }}
							></div>
						</section>
					{/if}
				</article>

{/snippet}

<style>
	.tract-detail {
		padding: 10px 12px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 8px;
	}

	/* Mirrors PocNhgisTractMap ``poc-detail`` styling for the choropleth summary moved into this sidebar. */
	.map-choropleth-pin {
		display: grid;
		gap: 6px;
		margin-bottom: 10px;
		padding: 8px 10px;
		border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
		background: color-mix(in srgb, var(--accent) 5%, var(--bg-card));
		border-radius: var(--radius-sm);
	}

	.map-choropleth-pin__head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 10px;
	}

	.map-choropleth-pin__kicker {
		margin: 0 0 2px;
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--accent);
	}

	.map-choropleth-pin__title {
		margin: 0;
		font-size: 0.82rem;
		font-weight: 700;
		color: var(--text);
	}

	.map-choropleth-pin__actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 5px;
	}

	.map-choropleth-pin__btn {
		border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-card));
		color: var(--text);
		padding: 0.26rem 0.52rem;
		font-size: 0.64rem;
		font-weight: 700;
		cursor: pointer;
	}

	.map-choropleth-pin__btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.map-choropleth-pin__btn--ghost {
		border-color: var(--border);
		background: var(--bg-card);
	}

	.map-choropleth-pin__desc {
		margin: 0;
		font-size: 0.63rem;
		line-height: 1.22;
		color: var(--text-muted);
	}

	.map-choropleth-pin__cohort {
		display: inline-flex;
		align-items: center;
		padding: 0.18rem 0.5rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-card));
		font-weight: 700;
		color: var(--text);
	}

	.map-choropleth-pin__topline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}

	.map-choropleth-pin__primary {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px;
	}

	.map-choropleth-pin__hero {
		display: grid;
		gap: 2px;
		padding: 5px 7px;
		border-radius: 10px;
		background: color-mix(in srgb, var(--accent) 7%, var(--bg-card));
		border: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border));
	}

	.map-choropleth-pin__lbl {
		display: block;
		font-size: 0.58rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.map-choropleth-pin__hero-val {
		font-size: 0.92rem;
		font-weight: 800;
		line-height: 1.1;
		color: var(--text);
	}

	.map-choropleth-pin__stats {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px 8px;
	}

	.map-choropleth-pin__stat-val {
		display: block;
		margin-top: 2px;
		font-size: 0.76rem;
		font-weight: 700;
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}

	.head-actions {
		display: flex;
		gap: 6px;
	}

	.title {
		font-size: 0.8125rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.action-btn {
		padding: 4px 10px;
		font-size: 0.72rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: var(--bg-panel);
		color: var(--accent);
		cursor: pointer;
		white-space: nowrap;
	}

	.action-btn:hover {
		background: var(--bg-hover);
	}

	.action-btn.clear {
		color: var(--text-muted);
	}

	.aggregate-card {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 5%, var(--bg-panel));
	}

	.overflow-note {
		font-size: 0.8rem;
		color: var(--text-muted);
		font-style: italic;
		padding: 4px 0;
	}

	.empty {
		font-size: 0.875rem;
		color: var(--text-muted);
	}

	.scroll {
		display: flex;
		flex-direction: column;
		gap: 10px;
		max-height: min(420px, 55vh);
		overflow-y: auto;
		padding-right: 2px;
	}

	.scroll--compact {
		max-height: min(72vh, 900px);
	}

	.detail-tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 3px;
		margin-bottom: 8px;
		background: var(--bg-panel);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}

	.detail-tab {
		flex: 1;
		min-width: 6rem;
		padding: 6px 10px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
	}

	.detail-tab[aria-selected='true'] {
		background: var(--bg-hover);
		color: var(--accent);
	}

	.card {
		padding: 10px 12px;
		background: var(--bg-panel);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text);
	}

	.card-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 10px;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--border);
	}

	.tract-id {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text);
	}

	.county {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin-top: 2px;
	}

	.period-pill {
		font-size: 0.65rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--accent);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 3px 8px;
		background: color-mix(in srgb, var(--bg-card) 70%, transparent);
		flex-shrink: 0;
	}

	.mono {
		font-family: var(--font-mono);
	}

	.crosswalk-note {
		font-size: 0.625rem;
		color: var(--text-muted);
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
		border-radius: var(--radius-sm);
		padding: 3px 8px;
		margin-bottom: 8px;
		line-height: 1.3;
	}

	.missing {
		font-size: 0.8125rem;
		color: var(--text-muted);
	}

	.metrics {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.75rem;
		margin-bottom: 10px;
	}

	.metrics th,
	.metrics td {
		padding: 4px 6px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
	}

	.metrics th {
		text-align: left;
		color: var(--text-muted);
		font-weight: 600;
	}

	.metrics .num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.subhead {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		margin-bottom: 6px;
	}

	.axis-inspection,
	.dev,
	.transit,
	.race {
		margin-top: 10px;
	}

	.axis-note {
		font-size: 0.68rem;
		color: var(--text-muted);
		line-height: 1.35;
		margin: 0 0 8px;
	}

	.axis-group-title {
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--text-muted);
		margin: 10px 0 6px;
	}

	.axis-group-title:first-of-type {
		margin-top: 0;
	}

	.axis-metrics {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.72rem;
		margin-bottom: 4px;
	}

	.axis-metrics th,
	.axis-metrics td {
		padding: 4px 6px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
		vertical-align: top;
	}

	.axis-metrics th {
		text-align: left;
		color: var(--text-muted);
		font-weight: 600;
	}

	.axis-metric-label {
		hyphens: auto;
		word-break: break-word;
		padding-right: 8px;
		line-height: 1.3;
	}

	.dev-grid {
		list-style: none;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px 10px;
		font-size: 0.75rem;
	}

	.transit-row {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 8px 14px;
		font-size: 0.75rem;
	}

	.dev-grid li,
	.transit-row li {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.lbl {
		color: var(--text-muted);
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.val {
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}

	.race-host {
		width: 100%;
		min-height: 52px;
	}

	.race-host :global(svg) {
		display: block;
		max-width: 100%;
	}
</style>
