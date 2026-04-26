<script>
	/**
	 * TOD Analysis scatters for ``/playground``: intensity vs affordability toggle; Y axis and
	 * cohort summary follow ``panelState.yVar`` (Time & Axes in the filter panel), same as the map.
	 */
	import { browser } from '$app/environment';
	import TodIntensityScatter from '$lib/components/TodIntensityScatter.svelte';
	import TodAffordabilityScatter from '$lib/components/TodAffordabilityScatter.svelte';
	import { tractData, developments, meta } from '$lib/stores/data.svelte.js';
	import {
		cohortYMeansForPanel,
		selectedTractsYWeightedMean,
		yMetricDisplayKind,
		formatYMetricSummary
	} from '$lib/utils/derived.js';

	let { panelState } = $props();

	/** TOD intensity (XY from MassBuilds + census) vs affordable-share view (TOD-dominated tracts). */
	let scatterMode = $state(/** @type {'intensity' | 'affordability'} */ ('intensity'));

	/** Same dependency key as ``ExploreTractSection``, including ``yVar`` for the active demographic. */
	const cohortSummaryKey = $derived(
		JSON.stringify({
			y: panelState.yVar,
			tp: panelState.timePeriod,
			n: tractData.length,
			dn: developments.length,
			stops: panelState.minStops,
			tdMi: panelState.transitDistanceMi,
			sig: panelState.sigDevMinPctStockIncrease,
			todCut: panelState.todFractionCutoff,
			huSrc: panelState.huChangeSource,
			minPop: panelState.minPopulation,
			minDens: panelState.minPopDensity,
			sel: [...panelState.selectedTracts].sort().join('\t')
		})
	);

	const cohortStats = $derived.by(() => {
		void cohortSummaryKey;
		// Skip when stores are not filled yet (or during SSR) — avoids a duplicate ``buildTodAnalysisData`` pass.
		if (!browser || !tractData.length || !developments.length) return null;
		const raw = cohortYMeansForPanel(tractData, panelState, developments);
		if (!raw) return null;
		const yMeta = meta.yVariables?.find((v) => v.key === raw.yBase);
		const kind = yMetricDisplayKind(yMeta);
		const selRaw = selectedTractsYWeightedMean(
			tractData,
			panelState,
			panelState.selectedTracts
		);
		return {
			...raw,
			displayLabel: yMeta?.label ?? raw.yBase,
			kind,
			fmtTod: formatYMetricSummary(raw.meanTod, kind),
			fmtCtrl: formatYMetricSummary(raw.meanNonTod, kind),
			fmtMinimal: formatYMetricSummary(raw.meanMinimal, kind),
			fmtSelected: formatYMetricSummary(selRaw?.mean ?? NaN, kind),
			nSel: selRaw?.nSelected ?? 0,
			nSelWithY: selRaw?.nWithY ?? 0
		};
	});
</script>

<div class="playground-tod">
	<div class="playground-tod-head">
		<div>
			<p class="playground-tod-kicker">TOD analysis</p>
			<h2 class="playground-tod-title">Scatter plots</h2>
			<p class="playground-tod-hint">
				These use the same controls as the map. Compare any demographic change against
		        any development change. Brush/select the plot to add tracts to the selection.
			</p>
		</div>
		<div class="playground-tod-toggle" role="group" aria-label="TOD scatter type">
			<button
				type="button"
				class="playground-tod-toggle-btn"
				class:active={scatterMode === 'intensity'}
				onclick={() => (scatterMode = 'intensity')}
			>
				TOD intensity
			</button>
			<button
				type="button"
				class="playground-tod-toggle-btn"
				class:active={scatterMode === 'affordability'}
				onclick={() => (scatterMode = 'affordability')}
			>
				Affordable TOD share
			</button>
		</div>
	</div>

	<div class="playground-cohortstrip" aria-label="Cohort summary for the selected Y variable">
		{#if cohortStats}
			<div
				class="cohort-summary"
				role="region"
				aria-label="Population-weighted averages: {cohortStats.displayLabel}"
			>
				<p class="cohort-summary-heading">{cohortStats.displayLabel}</p>
				<div class="cohort-summary-grid cohort-summary-grid--four">
					<div class="cohort-pill cohort-pill--tod">
						<span class="cohort-pill-label">TOD-dominated</span>
						<span class="cohort-pill-value">{cohortStats.fmtTod}</span>
						<span class="cohort-pill-n">
							{cohortStats.nTodWithY} / {cohortStats.nTod} tracts with data
						</span>
					</div>
					<div class="cohort-pill cohort-pill--ctrl">
						<span class="cohort-pill-label">non-TOD-dominated (sig. dev)</span>
						<span class="cohort-pill-value">{cohortStats.fmtCtrl}</span>
						<span class="cohort-pill-n">
							{cohortStats.nNonTodWithY} / {cohortStats.nNonTod} tracts with data
						</span>
					</div>
					<div class="cohort-pill cohort-pill--minimal">
						<span class="cohort-pill-label">Minimal development</span>
						<span class="cohort-pill-value">{cohortStats.fmtMinimal}</span>
						<span class="cohort-pill-n">
							{cohortStats.nMinimalWithY} / {cohortStats.nMinimal} tracts with data
						</span>
					</div>
					<div class="cohort-pill cohort-pill--picked">
						<span class="cohort-pill-label">Selected tracts</span>
						<span class="cohort-pill-value">{cohortStats.fmtSelected}</span>
						<span class="cohort-pill-n">
							{#if cohortStats.nSel === 0}
								None — click the map or scatter
							{:else}
								{cohortStats.nSelWithY} / {cohortStats.nSel} selected with data
							{/if}
						</span>
					</div>
				</div>
			</div>
			<p class="cohort-summary-note cohort-summary-note--strip">
				Means weighted by tract {cohortStats.weightLabel} (same as the tract bar chart and scatter Y).
			</p>
		{/if}
	</div>

	<div class="playground-tod-body">
		<div class="scatter-container scatter-container--playground">
			{#if scatterMode === 'intensity'}
				<TodIntensityScatter {panelState} wideLayout showTrimControl={true} />
			{:else}
				<TodAffordabilityScatter {panelState} />
			{/if}
		</div>
	</div>
</div>

<style>
	/* Match ``playground-map-card`` on ``/playground`` (page ``.card`` is scoped and does not apply here). */
	.playground-tod {
		--bg: #f5f2eb;
		--paper: #fffdf8;
		--ink: #1f2430;
		--muted: #5e6573;
		--accent: #00843d;
		--line: #d8d2c7;
		background: #fffdf8;
		border: 1px solid #d8d2c7;
		border-radius: 18px;
		box-shadow: 0 14px 34px rgba(31, 36, 48, 0.08);
		padding: 18px 18px 22px;
		display: grid;
		gap: 14px;
	}

	@media (max-width: 720px) {
		.playground-tod {
			padding-inline: 16px;
		}
	}

	.playground-tod-head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 14px;
	}

	.playground-tod-kicker {
		margin: 0 0 6px;
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--accent);
	}

	.playground-tod-title {
		margin: 0 0 8px;
		font-family: Helvetica, Arial, sans-serif;
		font-size: clamp(1.15rem, 2.2vw, 1.45rem);
		color: var(--ink);
	}

	.playground-tod-hint {
		margin: 0;
		max-width: 72ch;
		font-size: 0.94rem;
		line-height: 1.65;
		color: var(--muted);
	}

	.playground-tod-toggle {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 3px;
		background: var(--bg);
		border: 1px solid rgba(120, 114, 102, 0.18);
		border-radius: 999px;
		flex-shrink: 0;
	}

	.playground-tod-toggle-btn {
		border: none;
		background: transparent;
		padding: 6px 12px;
		border-radius: 999px;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
		cursor: pointer;
	}

	.playground-tod-toggle-btn.active {
		background: var(--paper);
		color: var(--accent);
		box-shadow: 0 1px 3px rgba(31, 36, 48, 0.12);
	}

	.playground-tod-body {
		min-width: 0;
	}

	.playground-tod-body :global(.tod-intensity-wrap.wide),
	.playground-tod-body :global(.tod-aff-wrap) {
		width: 100%;
	}

	.scatter-container--playground {
		min-width: 0;
		/* 60% of card width — SVGs are responsive so plot scales to ~60% in both dimensions. */
		width: 60%;
		margin-inline: auto;
	}

	/* Cohort summary strip (``ExploreTractSection``) */
	.playground-cohortstrip {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.cohort-summary {
		padding: 10px 12px 12px;
		background: var(--paper);
		border: 1px solid rgba(120, 114, 102, 0.14);
		border-radius: 12px;
	}

	.cohort-summary-heading {
		margin: 0 0 6px;
		font-size: 0.65rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
	}

	.cohort-summary-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px;
	}

	@media (min-width: 900px) {
		.cohort-summary-grid--four {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}

	.cohort-pill {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px 8px;
		border-radius: 8px;
		border: 1px solid var(--line, #d8d2c7);
		min-width: 0;
		background: var(--bg, #f5f2eb);
	}

	.cohort-pill--tod {
		background: color-mix(in srgb, var(--accent) 10%, var(--paper));
		border-color: color-mix(in srgb, var(--accent) 35%, var(--line, #d8d2c7));
	}

	.cohort-pill--tod .cohort-pill-value {
		color: var(--accent);
	}

	/* Non-TOD cohort: MBTA Orange Line (``MBTA_ORANGE`` / non-TOD fit in ``TodIntensityScatter``). */
	.cohort-pill--ctrl {
		background: color-mix(in srgb, #ed8b00 10%, var(--paper));
		border-color: color-mix(in srgb, #ed8b00 35%, var(--line, #d8d2c7));
	}

	.cohort-pill--ctrl .cohort-pill-value {
		color: #ed8b00;
	}

	.cohort-pill--minimal {
		background: color-mix(in srgb, #64748b 10%, var(--paper));
		border-color: color-mix(in srgb, #64748b 32%, var(--line, #d8d2c7));
	}

	.cohort-pill--minimal .cohort-pill-value {
		color: #475569;
	}

	.cohort-pill--picked {
		background: color-mix(in srgb, #facc15 18%, var(--paper));
		border-color: color-mix(in srgb, #facc15 38%, var(--line, #d8d2c7));
	}

	.cohort-pill--picked .cohort-pill-value {
		color: #be9a07;
	}

	.cohort-pill-label {
		font-size: 0.58rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
	}

	.cohort-pill-value {
		font-size: 0.95rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--ink);
		line-height: 1.2;
	}

	.cohort-pill-n {
		font-size: 0.58rem;
		color: var(--muted);
		line-height: 1.2;
	}

	.cohort-summary-note {
		margin: 0;
		font-size: 0.62rem;
		line-height: 1.35;
		color: var(--muted);
	}

	.cohort-summary-note--strip {
		padding: 0 2px 4px;
	}
</style>
