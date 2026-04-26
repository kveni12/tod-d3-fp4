<script>
	import { base } from '$app/paths';
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import FilterPanel from '$lib/components/FilterPanel.svelte';
	import PocNhgisTractMap from '$lib/components/PocNhgisTractMap.svelte';
	import TractDetail from '$lib/components/TractDetail.svelte';
	import { createPanelState } from '$lib/stores/panelState.svelte.js';
	import { tractData, developments } from '$lib/stores/data.svelte.js';
	import { buildFilteredData } from '$lib/utils/derived.js';
	import { buildNhgisLikeRows, buildTractDevClassMap } from '$lib/utils/mainPocTractModel.js';

	/**
	 * Defer the TOD scatter chunk + cohort ``buildTodAnalysisData`` work until after the first
	 * frames, so the main thread is not contending with ``loadAllData`` JSON apply + first map draw.
	 */
	let loadTodSection = $state(false);
	onMount(() => {
		let raf2 = 0;
		const raf1 = requestAnimationFrame(() => {
			raf2 = requestAnimationFrame(() => {
				loadTodSection = true;
			});
		});
		return () => {
			cancelAnimationFrame(raf1);
			if (raf2) cancelAnimationFrame(raf2);
		};
	});

	const playgroundPanel = createPanelState('playground');
	playgroundPanel.xVar = 'pct_stock_increase';
	playgroundPanel.yVar = 'median_income_change_pct';

	const ALLOWED_X_KEYS = [
		'pct_stock_increase',
		'tod_pct_stock_increase',
		'nontod_pct_stock_increase',
		'affordable_share'
	];

	$effect(() => {
		if (!ALLOWED_X_KEYS.includes(playgroundPanel.xVar)) {
			playgroundPanel.xVar = 'pct_stock_increase';
		}
	});

	const filteredData = $derived.by(() => buildFilteredData(tractData, developments, playgroundPanel));
	const filteredTracts = $derived(filteredData.filteredTracts);
	const filteredDevs = $derived(filteredData.filteredDevs);

	const devClassByGj = $derived.by(() =>
		buildTractDevClassMap(
			filteredTracts,
			filteredDevs,
			{ timePeriod: playgroundPanel.timePeriod },
			playgroundPanel.transitDistanceMi,
			{
				minUnitsPerProject: playgroundPanel.minUnitsPerProject,
				minDevMultifamilyRatioPct: playgroundPanel.minDevMultifamilyRatioPct,
				minDevAffordableRatioPct: playgroundPanel.minDevAffordableRatioPct,
				includeRedevelopment: playgroundPanel.includeRedevelopment
			},
			playgroundPanel.sigDevMinPctStockIncrease,
			playgroundPanel.todFractionCutoff
		)
	);

	const nhgisRows = $derived.by(() =>
		buildNhgisLikeRows(filteredTracts, devClassByGj, playgroundPanel.timePeriod)
	);

	/** Bound from ``PocNhgisTractMap`` for the choropleth summary in ``TractDetail``. */
	let mapFocusedTractDetail = $state(null);
	let mapViewActions = $state(null);
</script>

<section class="playground-root">
	<div class="playground-hero card">
		<p class="playground-eyebrow">Map Playground</p>
		<h1>Explore the choropleth without the full scroll story</h1>
		<p class="playground-lead">
			The map uses the same short five-step sequence as the main playground view—baseline growth, TOD/non-TOD outlines,
			mismatch outlines, projects, and a final sandbox for the X-axis metric plus optional overlays—controlled with
			arrows or the dropdown instead of scroll-sync. FilterPanel and tract detail work as usual; pan and zoom stay enabled.
		</p>
		<p class="playground-link">
			<a href={`${base}/`}>Back to the guided story</a>
		</p>
	</div>

	<div class="playground-grid">
		<aside class="playground-side">
			<div class="card playground-panel">
				<h4>Controls</h4>
				<p class="playground-note">
					Dynamically control all plots.
				</p>
				<FilterPanel panelState={playgroundPanel} allowedXKeys={ALLOWED_X_KEYS} />
			</div>

			<div class="card playground-panel">
				<h4>Selected tract detail</h4>
				<p class="playground-note">
					Click one or more tracts on the map to pin.
				</p>
				<TractDetail
					panelState={playgroundPanel}
					sidebarMode="compact"
					hideBulkActions
					allowedXAxisKeys={ALLOWED_X_KEYS}
					mapChoroplethDetail={mapFocusedTractDetail}
					onChoroplethZoom={(gisjoin) => mapViewActions?.zoomToTract?.(gisjoin)}
				/>
			</div>
		</aside>

		<div class="playground-main">
			<div class="card playground-map-card">
				<div class="playground-map-head">
					<div>
						<p class="playground-map-kicker">Interactive map</p>
						<h2>Choropleth playground</h2>
					</div>
					<!-- <p class="playground-map-note">
					Blue means stronger housing growth, red means weaker or negative growth, and overlays can be
					switched on and off as needed.
				</p> -->
				</div>

				<div class="playground-map-wrap">
					<PocNhgisTractMap
						panelState={playgroundPanel}
						tractList={filteredTracts}
						nhgisRows={nhgisRows}
						metricsDevelopments={filteredDevs}
						playgroundStoryCarousel={true}
						bind:mapFocusedTractDetail
						bind:mapViewActions
					/>
				</div>
			</div>

			<!-- Same column as the map so the sticky left column (controls + tract detail) spans map + scatters. -->
			<!-- Client-only + deferred: scatters + cohort re-run the heavy TOD path; do not start on first paint. -->
			{#if browser && loadTodSection}
				{#await import('$lib/components/PlaygroundTodScatters.svelte')}
					<p class="playground-tod-loading card" aria-live="polite">Loading TOD analysis charts…</p>
				{:then mod}
					{@const PlaygroundTodScatters = mod.default}
					<PlaygroundTodScatters panelState={playgroundPanel} />
				{:catch}
					<p class="playground-tod-fail card">TOD analysis charts could not be loaded. Try refreshing the page.</p>
				{/await}
			{/if}
		</div>
	</div>
</section>

<style>
	.playground-root {
		max-width: 1440px;
		margin: 0 auto;
		padding: 28px 20px 56px;
		display: grid;
		gap: 18px;
	}

	.card {
		background: #fffdf8;
		border: 1px solid #d8d2c7;
		border-radius: 18px;
		box-shadow: 0 14px 34px rgba(31, 36, 48, 0.08);
	}

	.playground-hero {
		padding: 24px 26px;
	}

	.playground-eyebrow {
		margin: 0 0 8px;
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #00843d;
	}

	.playground-hero h1,
	.playground-panel h2,
	.playground-map-card h2 {
		margin: 0 0 10px;
		font-family: Helvetica, Arial, sans-serif;
		color: #1f2430;
	}

	.playground-hero h1 {
		font-size: clamp(1.9rem, 4vw, 2.9rem);
		line-height: 1.08;
	}

	.playground-lead,
	.playground-link,
	.playground-note,
	.playground-map-note {
		margin: 0;
		color: #4b5563;
		line-height: 1.65;
	}

	.playground-link {
		margin-top: 12px;
	}

	.playground-link a {
		color: #00843d;
		font-weight: 700;
		text-decoration: none;
	}

	.playground-link a:hover {
		text-decoration: underline;
	}

	.playground-grid {
		display: grid;
		grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
		gap: 18px;
		align-items: start;
	}

	/* Map + TOD scatters: one column so the left ``aside`` row height includes both (sticky controls + detail). */
	.playground-main {
		display: flex;
		flex-direction: column;
		gap: 18px;
		min-width: 0;
	}

	.playground-side {
		display: grid;
		gap: 18px;
		position: sticky;
		top: 18px;
		/* Long filter + tract detail: allow internal scroll in short viewports while staying sticky. */
		max-height: calc(100vh - 36px);
		overflow-y: auto;
	}

	.playground-panel {
		padding: 18px 18px 20px;
	}

	.playground-note {
		margin-bottom: 10px;
		font-size: 0.7rem;
	}

	.playground-map-card {
		padding: 18px 18px 22px;
		display: grid;
		gap: 14px;
	}

	.playground-map-head {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		align-items: end;
	}

	.playground-map-kicker {
		margin: 0 0 6px;
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #00843d;
	}

	.playground-map-note {
		max-width: 440px;
		font-size: 0.94rem;
	}

	.playground-map-wrap {
		min-height: 760px;
	}

	@media (max-width: 1180px) {
		.playground-grid {
			grid-template-columns: 1fr;
		}

		.playground-side {
			position: static;
		}

		.playground-map-head {
			flex-direction: column;
			align-items: start;
		}
	}

	@media (max-width: 720px) {
		.playground-root {
			padding-inline: 14px;
		}

		.playground-hero,
		.playground-panel,
		.playground-map-card {
			padding-inline: 16px;
		}

		.playground-map-wrap {
			min-height: 620px;
		}
	}

	.playground-tod-loading,
	.playground-tod-fail {
		margin-top: 12px;
		padding: 16px 18px;
		font-size: 0.92rem;
		color: #4b5563;
	}

	/* D3-injected tooltips: match warm card + readable text (same idea as the guided story) */
	:global(.playground-root .tod-intensity-wrap .scatter-tooltip),
	:global(.playground-root .tod-aff-wrap .scatter-tooltip) {
		color: #1f2430;
		border-color: #d8d2c7;
		box-shadow: 0 14px 34px rgba(31, 36, 48, 0.08);
	}
</style>
