"""
Pipeline: raw data -> dashboard JSON.

Reads NHGIS census CSVs, MassBuilds CSV, and MBTA GeoJSON from data/raw/.
Optional HUD ``LIHTCPUB.csv`` (see ``LIHTC_CSV_CANDIDATES``) imputes missing
MassBuilds ``affrd_unit`` values where a Massachusetts LIHTC record matches
by location, placed-in-service year, and unit count.
Downloads 2020 MA census tract boundaries (cached after first run).
Writes processed JSON to static/data/ for the SvelteKit dashboard.
"""

import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Point

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "static" / "data"

# NHGIS GISJOIN uses: G + state(2) + 0 + county(3) + 0 + tract(6)
# Census GEOID is:     state(2) + county(3) + tract(6)

def gisjoin_to_geoid(gj):
    return gj[1:3] + gj[4:7] + gj[8:]

def geoid_to_gisjoin(geoid):
    return f"G{geoid[0:2]}0{geoid[2:5]}0{geoid[5:]}"

def safe_pct(num, denom):
    """Percentage that handles 0/NaN denominators."""
    return (num / denom.replace(0, np.nan) * 100).round(2)


# ═══════════════════════════════════════════════════════════════════
# Step 1: Tract boundaries
# ═══════════════════════════════════════════════════════════════════

def load_tracts():
    cache = RAW / "tracts_boundary.geojson"
    if cache.exists():
        print("  Loading cached tract boundaries...")
        return gpd.read_file(cache)

    # NHGIS data is standardized to 2010 geography — use 2010 tract boundaries
    urls = [
        "https://www2.census.gov/geo/tiger/GENZ2010/gz_2010_25_140_00_500k.zip",
        "https://www2.census.gov/geo/tiger/TIGER2010/TRACT/2010/tl_2010_25_tract10.zip",
    ]
    for url in urls:
        try:
            print(f"  Downloading {url} ...")
            gdf = gpd.read_file(url)
            gdf = gdf.to_crs(epsg=4326)
            gdf.to_file(cache, driver="GeoJSON")
            print(f"  Got {len(gdf)} tracts")
            return gdf
        except Exception as exc:
            print(f"    Failed: {exc}")

    sys.exit(
        "Could not download tract boundaries. Download MA tracts "
        "manually and save as data/raw/tracts_boundary.geojson"
    )


def find_geoid_col(gdf):
    """Find the GEOID column in a Census GeoDataFrame."""
    for c in ["GEOID", "GEOID10", "GEOID20", "GEO_ID"]:
        if c in gdf.columns:
            return c
    return None


def normalize_geoid(raw):
    """Strip any Census prefix like '1400000US' from a GEOID string."""
    s = str(raw)
    if "US" in s:
        s = s.split("US")[-1]
    return s


# ═══════════════════════════════════════════════════════════════════
# Step 1b: NHGIS geographic crosswalks (2000→2010 and 2020→2010)
# ═══════════════════════════════════════════════════════════════════

# Massachusetts state-level tract crosswalks from NHGIS (FIPS 25)
CROSSWALK_URLS = {
    "2000_2010": "https://secure-assets.ipums.org/nhgis/crosswalks/nhgis_tr2000_tr2010_state/nhgis_tr2000_tr2010_25.zip",
    "2020_2010": "https://secure-assets.ipums.org/nhgis/crosswalks/nhgis_tr2020_tr2010_state/nhgis_tr2020_tr2010_25.zip",
}

# Census Bureau relationship files (freely available, no auth required).
# Used as a fallback when NHGIS crosswalks aren't locally available.
_CENSUS_REL_URLS = {
    "2020_2010": "https://www2.census.gov/geo/docs/maps-data/data/rel2020/tract/tab20_tract20_tract10_st25.txt",
    "2000_2010": "https://www2.census.gov/geo/docs/maps-data/data/rel/trf_txt/ma25trf.txt",
}

# B71 income-bin boundaries for median estimation via linear interpolation.
# 15 bins: AA through AO, matching the NHGIS "Households by Income" table.
_B71_SUFFIXES = [
    "AA", "AB", "AC", "AD", "AE", "AF", "AG", "AH",
    "AI", "AJ", "AK", "AL", "AM", "AN", "AO",
]
_B71_LOWER = np.array([
    0, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000,
    45_000, 50_000, 60_000, 75_000, 100_000, 125_000, 150_000,
], dtype=float)
_B71_UPPER = np.array([
    10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000, 45_000,
    50_000, 60_000, 75_000, 100_000, 125_000, 150_000, 250_000,
], dtype=float)


def _build_crosswalk_2020_2010_from_census():
    """Build a 2020→2010 tract crosswalk from Census Bureau relationship file.

    Uses area-based weights (land-area overlap proportions) as a freely
    available proxy for the NHGIS population-interpolation weights.

    Returns
    -------
    pandas.DataFrame
        Columns ``gjoin_src``, ``gjoin_tgt``, ``wt_pop``, ``wt_hh``.
    """
    url = _CENSUS_REL_URLS["2020_2010"]
    print(f"    Downloading Census Bureau tract relationship: {url} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        raw = pd.read_csv(resp, sep="|", dtype=str)

    raw["AREALAND_TRACT_20"] = pd.to_numeric(raw["AREALAND_TRACT_20"], errors="coerce")
    raw["AREALAND_PART"] = pd.to_numeric(raw["AREALAND_PART"], errors="coerce")

    with np.errstate(divide="ignore", invalid="ignore"):
        wt = raw["AREALAND_PART"] / raw["AREALAND_TRACT_20"].replace(0, np.nan)
    raw["wt"] = wt.fillna(0)

    raw["gjoin_src"] = raw["GEOID_TRACT_20"].apply(geoid_to_gisjoin)
    raw["gjoin_tgt"] = raw["GEOID_TRACT_10"].apply(geoid_to_gisjoin)

    out = raw[["gjoin_src", "gjoin_tgt", "wt"]].copy()
    out["wt_pop"] = out["wt"]
    out["wt_hh"] = out["wt"]
    return out.drop(columns=["wt"])


def _build_crosswalk_2000_2010_from_census():
    """Build a 2000→2010 tract crosswalk from Census Bureau tract relationship file.

    The Census Bureau file (``ma25trf.txt``) is already at the tract level
    and includes population- and housing-unit-based weight percentages
    derived from 2010 block-level counts.

    Returns
    -------
    pandas.DataFrame
        Columns ``gjoin_src``, ``gjoin_tgt``, ``wt_pop``, ``wt_hh``.
    """
    url = _CENSUS_REL_URLS["2000_2010"]
    print(f"    Downloading Census Bureau tract relationship: {url} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        raw = pd.read_csv(resp, header=None, dtype=str)

    # 30-column header (from trfheader.txt)
    cols = [
        "STATE00", "COUNTY00", "TRACT00", "GEOID00", "POP00", "HU00",
        "PART00", "AREA00", "AREALAND00",
        "STATE10", "COUNTY10", "TRACT10", "GEOID10", "POP10", "HU10",
        "PART10", "AREA10", "AREALAND10",
        "AREAPT", "AREALANDPT",
        "AREAPCT00PT", "ARELANDPCT00PT", "AREAPCT10PT", "AREALANDPCT10PT",
        "POP10PT", "POPPCT00", "POPPCT10",
        "HU10PT", "HUPCT00", "HUPCT10",
    ]
    raw.columns = cols[:len(raw.columns)]

    # POPPCT00 / HUPCT00 = % of 2000 tract's population/HU in this overlap part
    raw["wt_pop"] = pd.to_numeric(raw["POPPCT00"], errors="coerce").fillna(0) / 100.0
    raw["wt_hh"] = pd.to_numeric(raw["HUPCT00"], errors="coerce").fillna(0) / 100.0

    raw["gjoin_src"] = raw["GEOID00"].str.strip().apply(geoid_to_gisjoin)
    raw["gjoin_tgt"] = raw["GEOID10"].str.strip().apply(geoid_to_gisjoin)

    return raw[["gjoin_src", "gjoin_tgt", "wt_pop", "wt_hh"]].copy()


def load_crosswalk(key):
    """Load a tract crosswalk for Massachusetts.

    Resolution order:

    1. Cached NHGIS CSV (``data/raw/census/nhgis_tr*_25.csv``)
    2. Cached NHGIS zip (same dir, ``.zip``)
    3. NHGIS direct download (requires free IPUMS registration)
    4. Census Bureau relationship files (free, no auth -- area-based weights)

    Parameters
    ----------
    key : str
        One of ``"2000_2010"`` or ``"2020_2010"``.

    Returns
    -------
    pandas.DataFrame
        Columns ``gjoin_src``, ``gjoin_tgt``, plus weight columns
        (``wt_pop``, ``wt_hh``).
    """
    url = CROSSWALK_URLS[key]
    src_year, tgt_year = key.split("_")
    cache_dir = RAW / "census"
    basename = f"nhgis_tr{src_year}_tr{tgt_year}_25"
    cache_csv = cache_dir / f"{basename}.csv"
    cache_zip = cache_dir / f"{basename}.zip"

    if cache_csv.exists():
        print(f"  Loading cached crosswalk {cache_csv.name} ...")
        df = pd.read_csv(cache_csv, dtype=str)
    elif cache_zip.exists():
        print(f"  Extracting cached crosswalk {cache_zip.name} ...")
        with zipfile.ZipFile(cache_zip) as zf:
            csv_names = [n for n in zf.namelist() if n.endswith(".csv")]
            if not csv_names:
                sys.exit(f"No CSV found inside {cache_zip}")
            with zf.open(csv_names[0]) as f:
                raw_bytes = f.read()
            df = pd.read_csv(io.BytesIO(raw_bytes), dtype=str)
            cache_csv.write_bytes(raw_bytes)
        print(f"    Extracted to {cache_csv.name}")
    else:
        # Try NHGIS direct download first
        nhgis_ok = False
        print(f"  Attempting NHGIS download: {url} ...")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req) as resp:
                zdata = resp.read()
            if zdata[:2] == b"PK":
                with zipfile.ZipFile(io.BytesIO(zdata)) as zf:
                    csv_names = [n for n in zf.namelist() if n.endswith(".csv")]
                    if csv_names:
                        with zf.open(csv_names[0]) as f:
                            raw_bytes = f.read()
                        df = pd.read_csv(io.BytesIO(raw_bytes), dtype=str)
                        cache_dir.mkdir(parents=True, exist_ok=True)
                        cache_csv.write_bytes(raw_bytes)
                        nhgis_ok = True
                        print(f"    Cached as {cache_csv.name}")
        except Exception:
            pass

        if not nhgis_ok:
            print("    NHGIS requires authentication; falling back to Census Bureau ...")
            builders = {
                "2020_2010": _build_crosswalk_2020_2010_from_census,
                "2000_2010": _build_crosswalk_2000_2010_from_census,
            }
            df = builders[key]()
            cache_dir.mkdir(parents=True, exist_ok=True)
            df.to_csv(cache_csv, index=False)
            print(f"    Built and cached as {cache_csv.name}")

    src_gj = f"GJOIN{src_year}"
    tgt_gj = f"GJOIN{tgt_year}"
    col_map = {}
    for orig in df.columns:
        upper = orig.upper().strip()
        if upper == src_gj:
            col_map[orig] = "gjoin_src"
        elif upper == tgt_gj:
            col_map[orig] = "gjoin_tgt"
        elif upper.startswith("WT_") or upper == "WEIGHT":
            col_map[orig] = orig.strip().lower()
    df = df.rename(columns=col_map)

    for c in df.columns:
        if c.startswith("wt_") or c == "weight":
            df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0)

    df = df.dropna(subset=["gjoin_src", "gjoin_tgt"])
    df = df[df["gjoin_src"].str.strip() != ""]
    df = df[df["gjoin_tgt"].str.strip() != ""]

    print(
        f"    {len(df)} crosswalk records "
        f"({df['gjoin_src'].nunique()} source -> "
        f"{df['gjoin_tgt'].nunique()} target tracts)"
    )
    return df


# ═══════════════════════════════════════════════════════════════════
# Step 2: Standardised census (2010 geography, decennial years)
# ═══════════════════════════════════════════════════════════════════

def load_standardized():
    path = RAW / "census" / "nhgis0006_ts_geog2010_tract.csv"
    print(f"  Reading {path.name} ...")
    # skiprows=[1] drops the NHGIS human-readable descriptive header row
    df = pd.read_csv(path, encoding="latin-1", skiprows=[1])

    out = pd.DataFrame({"gisjoin": df["GISJOIN"], "county": df["COUNTY"]})

    std_years = [1990, 2000, 2010, 2020]
    other_race_codes = ["CM1AC", "CM1AE", "CM1AF", "CM1AG"]

    for y in std_years:
        Y = str(y)
        out[f"pop_{Y}"] = pd.to_numeric(df[f"CL8AA{Y}"], errors="coerce")

        # Race (CM1: 7 categories; some subcategories missing in 1990)
        out[f"white_{Y}"] = pd.to_numeric(df[f"CM1AA{Y}"], errors="coerce")
        out[f"black_{Y}"] = pd.to_numeric(df[f"CM1AB{Y}"], errors="coerce")
        out[f"asian_{Y}"] = pd.to_numeric(df[f"CM1AD{Y}"], errors="coerce")
        other_parts = []
        for c in other_race_codes:
            col = f"{c}{Y}"
            if col in df.columns:
                other_parts.append(pd.to_numeric(df[col], errors="coerce").fillna(0))
        out[f"other_race_{Y}"] = (
            sum(other_parts) if other_parts else pd.Series(0.0, index=df.index)
        )
        # Hispanic ethnicity: not in this NHGIS extract; zeros reserve a UI category for future data.
        out[f"hispanic_{Y}"] = 0.0

        # Housing
        out[f"total_hu_{Y}"] = pd.to_numeric(df[f"CM7AA{Y}"], errors="coerce")
        out[f"occupied_{Y}"] = pd.to_numeric(df[f"CM9AA{Y}"], errors="coerce")
        out[f"vacant_{Y}"] = pd.to_numeric(df[f"CM9AB{Y}"], errors="coerce")
        out[f"owner_{Y}"] = pd.to_numeric(df[f"CN1AA{Y}"], errors="coerce")
        out[f"renter_{Y}"] = pd.to_numeric(df[f"CN1AB{Y}"], errors="coerce")

        # Tenure × race – keep just minority-owner & minority-renter totals.
        # Missing CY5A* columns must align to df.index (empty default Series breaks sum).
        owner_minority = sum(
            pd.to_numeric(
                df.get(f"CY5A{s}{Y}", pd.Series(0.0, index=df.index)),
                errors="coerce",
            ).fillna(0)
            for s in ["B", "C", "D", "E", "F"]
        )
        out[f"owner_minority_{Y}"] = owner_minority

    # Derived percentages
    for y in std_years:
        Y = str(y)
        out[f"minority_pct_{Y}"] = safe_pct(
            out[f"pop_{Y}"] - out[f"white_{Y}"], out[f"pop_{Y}"]
        )
        out[f"owner_pct_{Y}"] = safe_pct(out[f"owner_{Y}"], out[f"occupied_{Y}"])
        out[f"vacancy_rate_{Y}"] = safe_pct(out[f"vacant_{Y}"], out[f"total_hu_{Y}"])
        out[f"minority_owner_pct_{Y}"] = safe_pct(
            out[f"owner_minority_{Y}"], out[f"owner_{Y}"]
        )

    # Decade / long-window changes (tags match dashboard ``timePeriod`` keys)
    for s, e, tag in [
        (1990, 2000, "90_00"),
        (2000, 2010, "00_10"),
        (2010, 2020, "10_20"),
        # 20-year decennial window (matches default dashboard ``timePeriod`` ``00_20``).
        (2000, 2020, "00_20"),
        (1990, 2020, "90_20"),
    ]:
        S, E = str(s), str(e)
        out[f"pop_change_pct_{tag}"] = safe_pct(
            out[f"pop_{E}"] - out[f"pop_{S}"], out[f"pop_{S}"]
        )
        for metric in ["minority_pct", "owner_pct", "vacancy_rate", "minority_owner_pct"]:
            out[f"{metric}_change_{tag}"] = (
                out[f"{metric}_{E}"] - out[f"{metric}_{S}"]
            ).round(2)

    print(f"    {len(out)} tracts, {len(out.columns)} columns")
    return out


# ═══════════════════════════════════════════════════════════════════
# Step 3: Nominal census — crosswalk-based geographic harmonisation
# ═══════════════════════════════════════════════════════════════════


def _extract_nom_counts(df, gjoin_col, nhgis_code):
    """Extract raw count variables from the nominal CSV for one time point.

    Parameters
    ----------
    df : pandas.DataFrame
        Full nominal CSV (string dtypes).
    gjoin_col : str
        Column identifying geography for this vintage (e.g. ``"GJOIN2000"``).
    nhgis_code : str
        NHGIS time-point suffix (``"1990"``, ``"2000"``, ``"105"``, ``"205"``).

    Returns
    -------
    pandas.DataFrame
        One row per source tract with ``gjoin`` plus raw count columns.
    """
    mask = df[gjoin_col].notna() & (df[gjoin_col].str.strip() != "")
    sub = df.loc[mask].copy()
    idx = sub.index

    def _num(col_name):
        if col_name not in sub.columns:
            return pd.Series(np.nan, index=idx)
        return pd.to_numeric(sub[col_name], errors="coerce")

    out = pd.DataFrame({"gjoin": sub[gjoin_col].values}, index=idx)

    # Nativity (AT5)
    out["native"] = _num(f"AT5AA{nhgis_code}").values
    out["foreign_born"] = _num(f"AT5AB{nhgis_code}").values

    # Education 25+ (B69)
    out["edu_lt9"] = _num(f"B69AA{nhgis_code}").values
    out["edu_some"] = _num(f"B69AB{nhgis_code}").values
    out["edu_bach"] = _num(f"B69AC{nhgis_code}").values

    # Poverty (AX7)
    out["pov_below"] = _num(f"AX7AA{nhgis_code}").values
    out["pov_above"] = _num(f"AX7AB{nhgis_code}").values

    # Transportation: 8 top-level C53 categories → total workers
    mode_sfx = ["AA", "AI", "AO", "AP", "AQ", "AR", "AS", "AT"]
    tw = np.zeros(len(sub))
    for s in mode_sfx:
        col = f"C53{s}{nhgis_code}"
        if col in sub.columns:
            tw += pd.to_numeric(sub[col], errors="coerce").fillna(0).values
    out["total_workers"] = tw
    out["transit_workers"] = _num(f"C53AI{nhgis_code}").values
    out["drove_alone"] = _num(f"C53AB{nhgis_code}").values

    # Commute time
    out["agg_travel_time"] = _num(f"C98AA{nhgis_code}").values
    out["commuters"] = _num(f"CW0AA{nhgis_code}").values

    # Income bins B71 (15 categories, household-based)
    for sfx in _B71_SUFFIXES:
        out[f"b71_{sfx.lower()}"] = _num(f"B71{sfx}{nhgis_code}").values

    # Direct median income B79 (fallback when bins are unavailable)
    out["median_income_direct"] = _num(f"B79AA{nhgis_code}").values

    return out.reset_index(drop=True)


def _apply_crosswalk(counts_df, xw_df, pop_wt="wt_pop", hh_wt="wt_hh"):
    """Apply crosswalk weights to move count data onto 2010 tract geography.

    Parameters
    ----------
    counts_df : pandas.DataFrame
        Output of ``_extract_nom_counts`` with a ``gjoin`` column on source
        geography.
    xw_df : pandas.DataFrame
        Crosswalk with ``gjoin_src``, ``gjoin_tgt``, and weight columns.
    pop_wt : str
        Weight column for person-based counts.
    hh_wt : str
        Weight column for household-based counts.

    Returns
    -------
    pandas.DataFrame
        Same count columns, aggregated to target 2010 tracts (``gjoin``).
    """
    merged = counts_df.merge(
        xw_df[["gjoin_src", "gjoin_tgt", pop_wt, hh_wt]],
        left_on="gjoin",
        right_on="gjoin_src",
        how="inner",
    )

    pw = merged[pop_wt]
    hw = merged[hh_wt]

    pop_cols = [
        "native", "foreign_born", "edu_lt9", "edu_some", "edu_bach",
        "pov_below", "pov_above", "total_workers", "transit_workers",
        "drove_alone", "agg_travel_time", "commuters",
    ]
    for c in pop_cols:
        merged[c] = merged[c] * pw

    b71_cols = [f"b71_{sfx.lower()}" for sfx in _B71_SUFFIXES]
    for c in b71_cols:
        merged[c] = merged[c] * hw

    # Population-weighted average for direct median (fallback path)
    merged["_med_x_pw"] = merged["median_income_direct"] * pw
    merged["_pw_sum"] = pw

    agg_cols = pop_cols + b71_cols + ["_med_x_pw", "_pw_sum"]
    grouped = merged.groupby("gjoin_tgt")[agg_cols].sum()
    grouped["median_income_direct"] = (
        grouped["_med_x_pw"] / grouped["_pw_sum"].replace(0, np.nan)
    )
    grouped = grouped.drop(columns=["_med_x_pw", "_pw_sum"])
    grouped = grouped.reset_index().rename(columns={"gjoin_tgt": "gjoin"})

    return grouped


def _estimate_median_from_bins(df):
    """Estimate median household income from crosswalked B71 bin counts.

    Uses linear interpolation within the bin that contains the 50th
    percentile household.

    Parameters
    ----------
    df : pandas.DataFrame
        Must contain columns ``b71_aa`` … ``b71_ao``.

    Returns
    -------
    pandas.Series
        Estimated median income, NaN where total households <= 0.
    """
    bin_cols = [f"b71_{sfx.lower()}" for sfx in _B71_SUFFIXES]
    bins = df[bin_cols].fillna(0).values  # (N, 15)

    totals = bins.sum(axis=1)
    half = totals / 2.0
    cum = np.cumsum(bins, axis=1)

    # First bin where cumulative count >= half
    exceeded = cum >= half[:, np.newaxis]
    j = np.argmax(exceeded, axis=1)

    prev_cum = np.where(j > 0, cum[np.arange(len(df)), j - 1], 0.0)
    bin_count = bins[np.arange(len(df)), j]

    with np.errstate(divide="ignore", invalid="ignore"):
        frac = np.where(bin_count > 0, (half - prev_cum) / bin_count, 0.0)

    medians = _B71_LOWER[j] + frac * (_B71_UPPER[j] - _B71_LOWER[j])
    medians = np.where(totals > 0, medians, np.nan)

    return pd.Series(medians, index=df.index)


def _derive_pct_columns(counts, label):
    """Compute dashboard percentage / rate columns from raw counts.

    Parameters
    ----------
    counts : pandas.DataFrame
        Count-level data on 2010 geography (after crosswalk, or direct).
    label : str
        Year label (``"1990"``, ``"2000"``, ``"2010"``, ``"2020"``).

    Returns
    -------
    pandas.DataFrame
        Columns ``gjoin`` plus ``foreign_born_pct_{label}``, ``median_income_{label}``,
        etc.
    """
    out = pd.DataFrame({"gjoin": counts["gjoin"].values}, index=counts.index)

    nat_total = counts["native"] + counts["foreign_born"]
    out[f"foreign_born_pct_{label}"] = safe_pct(counts["foreign_born"], nat_total)

    edu_total = counts["edu_lt9"] + counts["edu_some"] + counts["edu_bach"]
    out[f"bachelors_pct_{label}"] = safe_pct(counts["edu_bach"], edu_total)

    # Median income: prefer B71-bin estimate, fall back to direct B79
    med_bins = _estimate_median_from_bins(counts)
    med_direct = counts["median_income_direct"]
    out[f"median_income_{label}"] = med_bins.where(med_bins.notna(), med_direct).round(0)

    pov_total = counts["pov_below"] + counts["pov_above"]
    out[f"poverty_rate_{label}"] = safe_pct(counts["pov_below"], pov_total)

    tw = counts["total_workers"]
    out[f"transit_pct_{label}"] = safe_pct(counts["transit_workers"], tw)
    out[f"drove_alone_pct_{label}"] = safe_pct(counts["drove_alone"], tw)

    out[f"avg_travel_time_{label}"] = (
        counts["agg_travel_time"] / counts["commuters"].replace(0, np.nan)
    ).round(1)

    return out


def load_nominal(xw_2000_2010, xw_2020_2010):
    """Load nominal census data with crosswalk-based geographic harmonisation.

    Extracts 2000, 2010, and 2020 data from each vintage's native
    geography, then uses NHGIS crosswalks to place everything onto
    2010 census-tract geography before computing change metrics.

    1990 data is read from GJOIN2010 rows directly (no crosswalk).

    Parameters
    ----------
    xw_2000_2010 : pandas.DataFrame
        NHGIS crosswalk: 2000 tracts → 2010 tracts.
    xw_2020_2010 : pandas.DataFrame
        NHGIS crosswalk: 2020 tracts → 2010 tracts.

    Returns
    -------
    pandas.DataFrame
        One row per 2010 tract (``gjoin2010``), with level and change
        columns for all four time points plus crosswalk quality flags.
    """
    path = RAW / "census" / "nhgis0006_ts_nominal_tract.csv"
    print(f"  Reading {path.name} ...")
    df = pd.read_csv(path, encoding="latin-1", dtype=str, low_memory=False, skiprows=[1])

    # ── Extract raw counts for each time point ────────────────────
    print("    Extracting 1990 (GJOIN2010, code '1990') ...")
    raw_1990 = _extract_nom_counts(df, "GJOIN2010", "1990")
    print(f"      {len(raw_1990)} rows")

    print("    Extracting 2000 (GJOIN2000, code '2000') ...")
    raw_2000 = _extract_nom_counts(df, "GJOIN2000", "2000")
    print(f"      {len(raw_2000)} rows")

    print("    Extracting 2010 (GJOIN2010, code '105') ...")
    raw_2010 = _extract_nom_counts(df, "GJOIN2010", "105")
    print(f"      {len(raw_2010)} rows")

    print("    Extracting 2020 (GJOIN2020, code '205') ...")
    raw_2020 = _extract_nom_counts(df, "GJOIN2020", "205")
    print(f"      {len(raw_2020)} rows")

    # ── Crosswalk 2000 and 2020 onto 2010 geography ──────────────
    print("    Crosswalking 2000 -> 2010 geography ...")
    xw_counts_2000 = _apply_crosswalk(raw_2000, xw_2000_2010)
    print(f"      {len(xw_counts_2000)} target 2010 tracts")

    print("    Crosswalking 2020 -> 2010 geography ...")
    xw_counts_2020 = _apply_crosswalk(raw_2020, xw_2020_2010)
    print(f"      {len(xw_counts_2020)} target 2010 tracts")

    # 1990 and 2010 are already on 2010 geography (keyed by GJOIN2010)
    counts_1990 = raw_1990
    counts_2010 = raw_2010

    # ── Derive percentages for each time point ────────────────────
    pct_1990 = _derive_pct_columns(counts_1990, "1990")
    pct_2000 = _derive_pct_columns(xw_counts_2000, "2000")
    pct_2010 = _derive_pct_columns(counts_2010, "2010")
    pct_2020 = _derive_pct_columns(xw_counts_2020, "2020")

    # ── Merge all four time points onto the 2010 tract index ──────
    out = pct_2010.rename(columns={"gjoin": "gjoin2010"})
    for other in [pct_1990, pct_2000, pct_2020]:
        other_r = other.rename(columns={"gjoin": "gjoin2010"})
        out = out.merge(other_r, on="gjoin2010", how="left")

    # ── Crosswalk quality flags ───────────────────────────────────
    # A tract is marked as "crosswalked" for a year if the original
    # nominal CSV did NOT have data for that year on the GJOIN2010 row
    # (i.e. the crosswalk provided data the old pipeline would have missed).
    direct_2000_gj = set(
        df.loc[
            df["GJOIN2010"].notna()
            & (df["GJOIN2010"].str.strip() != "")
            & pd.to_numeric(df["B79AA2000"], errors="coerce").notna(),
            "GJOIN2010",
        ].unique()
    )
    direct_2020_gj = set(
        df.loc[
            df["GJOIN2010"].notna()
            & (df["GJOIN2010"].str.strip() != "")
            & pd.to_numeric(df["B79AA205"], errors="coerce").notna(),
            "GJOIN2010",
        ].unique()
    )
    out["nom_2000_crosswalked"] = ~out["gjoin2010"].isin(direct_2000_gj)
    out["nom_2020_crosswalked"] = ~out["gjoin2010"].isin(direct_2020_gj)

    # ── Compute change columns ────────────────────────────────────
    for s_label, e_label, tag in [
        ("1990", "2000", "90_00"),
        ("2000", "2010", "00_10"),
        ("2010", "2020", "10_20"),
        ("1990", "2020", "90_20"),
        ("2000", "2020", "00_20"),
    ]:
        for m in [
            "foreign_born_pct", "bachelors_pct", "poverty_rate",
            "transit_pct", "drove_alone_pct", "avg_travel_time",
        ]:
            cs, ce = f"{m}_{s_label}", f"{m}_{e_label}"
            if cs in out.columns and ce in out.columns:
                out[f"{m}_change_{tag}"] = (out[ce] - out[cs]).round(2)

        inc_s = f"median_income_{s_label}"
        inc_e = f"median_income_{e_label}"
        if inc_s in out.columns and inc_e in out.columns:
            out[f"median_income_change_pct_{tag}"] = safe_pct(
                out[inc_e] - out[inc_s], out[inc_s]
            )

    n_xw_2000 = out["nom_2000_crosswalked"].sum()
    n_xw_2020 = out["nom_2020_crosswalked"].sum()
    print(f"    {len(out)} tracts, {len(out.columns)} columns")
    print(f"    Crosswalked: {n_xw_2000} tracts for 2000, {n_xw_2020} for 2020")
    return out


# ═══════════════════════════════════════════════════════════════════
# Step 4: MassBuilds → per-tract development aggregates
# ═══════════════════════════════════════════════════════════════════

# HUD LIHTCPUB.csv: https://www.huduser.gov/portal/datasets/lihtc/property.html
# Place extracted ``LIHTCPUB.csv`` in ``data/raw/lihtc/`` (or ``data/raw/``).
LIHTC_CSV_CANDIDATES = (RAW / "lihtc" / "LIHTCPUB.csv", RAW / "LIHTCPUB.csv")

# Impute ``affrd_unit`` only when MassBuilds reports missing/0; match must satisfy
# distance, completion vs. placed-in-service year, and unit-count similarity.
LIHTC_MAX_DIST_M = 125.0
LIHTC_YEAR_TOL = 3
LIHTC_UNIT_RATIO_MIN = 0.5
LIHTC_UNIT_RATIO_MAX = 1.55


def resolve_lihtc_csv_path():
    """Return the first existing HUD LIHTC CSV path, or None."""
    for p in LIHTC_CSV_CANDIDATES:
        if p.exists():
            return p
    return None


def load_lihtc_ma_properties(path):
    """Load Massachusetts LIHTC projects with coordinates and unit counts.

    Parameters
    ----------
    path : Path
        Path to ``LIHTCPUB.csv`` from HUD's LIHTCPUB archive.

    Returns
    -------
    pandas.DataFrame or None
        Columns include ``hud_id``, ``latitude``, ``longitude``, ``li_units``,
        ``n_units``, ``yr_pis``. One row per ``hud_id`` (largest ``li_units``
        kept when duplicates exist). None if the file cannot be read.
    """
    try:
        df = pd.read_csv(path, encoding="latin-1", low_memory=False)
    except OSError:
        return None
    st = df.get("proj_st")
    if st is None:
        return None
    ma = df.loc[st.astype(str).str.strip().eq("MA")].copy()
    for c in ("latitude", "longitude", "li_units", "n_units", "yr_pis"):
        if c not in ma.columns:
            return None
        ma[c] = pd.to_numeric(ma[c], errors="coerce")
    ma = ma[
        ma["latitude"].notna()
        & ma["longitude"].notna()
        & (ma["li_units"] > 0)
        & ma["n_units"].gt(0)
    ]
    # Sentinel year in HUD files when unknown
    ma = ma[ma["yr_pis"].notna() & (ma["yr_pis"] != 9999)]
    if ma.empty:
        return None
    # Prefer the richest duplicate per hud_id (multi-record edge cases).
    ma = ma.sort_values("li_units", ascending=False).drop_duplicates(
        subset=["hud_id"], keep="first"
    )
    return ma.reset_index(drop=True)


def impute_massbuilds_affordable_from_lihtc(mb):
    """Fill ``affrd_unit`` from HUD LIHTC where MassBuilds has no count.

    Eligible rows are those with missing or zero ``affrd_unit`` and positive
    ``hu``. Each MassBuilds row is paired with at most one LIHTC ``hud_id`` and
    vice versa; pairs are chosen in order of increasing map distance after
    applying distance, year, and unit-count gates (module constants).

    Parameters
    ----------
    mb : pandas.DataFrame
        MassBuilds slice with ``latitude``, ``longitude``, ``hu``,
        ``completion_year``, ``affrd_unit``. ``affrd_source`` must already
        be ``\"mb\"`` for all rows (set by the caller). Mutated in place:
        ``affrd_unit`` is set to ``min(li_units, hu)`` for matches, and
        ``affrd_source`` becomes ``\"lihtc\"`` for those rows.

    Returns
    -------
    int
        Number of projects imputed from LIHTC.

    Notes
    -----
    LIHTC ``li_units`` are low-income tax-credit units, not identical to
    every local “affordable” definition MassBuilds might use; imputation is
    a best-effort bridge when MassBuilds reports no affordable count.
    """
    path = resolve_lihtc_csv_path()
    if path is None:
        return 0
    li = load_lihtc_ma_properties(path)
    if li is None or li.empty:
        print(f"    WARNING: could not load MA rows from {path.name}")
        return 0

    aff = pd.to_numeric(mb["affrd_unit"], errors="coerce")
    need_mask = (aff.isna() | (aff == 0)) & mb["hu"].gt(0)
    if not need_mask.any():
        return 0

    mb_need = mb.loc[need_mask]
    mb_geom = gpd.points_from_xy(
        mb_need["longitude"], mb_need["latitude"], crs="EPSG:4326"
    )
    mb_g = gpd.GeoDataFrame(mb_need, geometry=mb_geom, crs="EPSG:4326").to_crs(
        26986
    )
    li_geom = gpd.points_from_xy(
        li["longitude"], li["latitude"], crs="EPSG:4326"
    )
    li_g = gpd.GeoDataFrame(li, geometry=li_geom, crs="EPSG:4326").to_crs(26986)

    mx = mb_g.geometry.x.to_numpy()
    my = mb_g.geometry.y.to_numpy()
    lx = li_g.geometry.x.to_numpy()
    ly = li_g.geometry.y.to_numpy()
    dx = mx[:, np.newaxis] - lx[np.newaxis, :]
    dy = my[:, np.newaxis] - ly[np.newaxis, :]
    dist_m = np.sqrt(dx * dx + dy * dy)

    cy = mb_g["completion_year"].to_numpy(dtype=float).reshape(-1, 1)
    yp = li["yr_pis"].to_numpy(dtype=float).reshape(1, -1)
    year_ok = np.abs(cy - yp) <= LIHTC_YEAR_TOL

    hu = mb_g["hu"].to_numpy(dtype=float).reshape(-1, 1)
    nu = li["n_units"].to_numpy(dtype=float).reshape(1, -1)
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = hu / nu
    ratio_ok = (ratio >= LIHTC_UNIT_RATIO_MIN) & (ratio <= LIHTC_UNIT_RATIO_MAX)

    eligible = (dist_m <= LIHTC_MAX_DIST_M) & year_ok & ratio_ok
    dist_masked = np.where(eligible, dist_m, np.inf)
    best_j = np.argmin(dist_masked, axis=1)
    min_d = np.min(dist_masked, axis=1)
    mb_indices = mb_g.index.to_numpy()

    pairs = []
    for r in range(len(mb_g)):
        if not np.isfinite(min_d[r]):
            continue
        pairs.append((float(min_d[r]), int(mb_indices[r]), int(best_j[r])))
    pairs.sort(key=lambda x: x[0])

    used_mb = set()
    used_li = set()
    li_units_arr = li["li_units"].to_numpy()

    n_imputed = 0
    for _, mb_idx, j in pairs:
        if mb_idx in used_mb or j in used_li:
            continue
        used_mb.add(mb_idx)
        used_li.add(j)
        hu_val = int(mb.at[mb_idx, "hu"])
        li_ct = int(li_units_arr[j])
        mb.at[mb_idx, "affrd_unit"] = min(li_ct, hu_val)
        mb.at[mb_idx, "affrd_source"] = "lihtc"
        n_imputed += 1

    return n_imputed


def load_massbuilds(tracts_gdf):
    """Load MassBuilds and return (per-tract aggregates, individual project records).

    Returns
    -------
    pivot : DataFrame
        Per-tract aggregated development counts (for merging into tract data).
    projects : list[dict]
        Individual project records for client-side filtering / map overlay.
    """
    path = RAW / "massbuilds-20260322.csv"
    print(f"  Reading {path.name} ...")
    mb = pd.read_csv(path, encoding="latin-1", low_memory=False)

    mb = mb.dropna(subset=["latitude", "longitude"])
    mb["hu"] = pd.to_numeric(mb["hu"], errors="coerce").fillna(0)
    mb = mb[mb["hu"] > 0].copy()

    # Only include completed developments (exclude under-construction, planning, etc.)
    mb = mb[mb["status"].str.lower().str.strip() == "completed"].copy()

    year = pd.to_numeric(mb["year_compl"], errors="coerce").fillna(
        pd.to_numeric(mb["yrcomp_est"], errors="coerce")
    )
    mb["completion_year"] = year

    # Exclude projects without a valid completion year
    mb = mb[mb["completion_year"].notna()].copy()
    # np.select requires default dtype compatible with choicelist strings (not np.nan).
    mb["decade"] = np.select(
        [
            (year >= 1990) & (year < 2000),
            (year >= 2000) & (year < 2010),
            (year >= 2010) & (year <= 2025),
        ],
        ["90_00", "00_10", "10_20"],
        default="",
    )
    mb = mb[mb["decade"] != ""].copy()

    # Provenance for affordable unit counts (HUD fill-ins override in imputation).
    mb["affrd_source"] = "mb"
    n_lihtc = impute_massbuilds_affordable_from_lihtc(mb)
    if n_lihtc:
        print(f"    LIHTC imputation: filled affordable units for {n_lihtc} projects")

    geometry = [Point(xy) for xy in zip(mb["longitude"], mb["latitude"])]
    mb_gdf = gpd.GeoDataFrame(mb, geometry=geometry, crs="EPSG:4326")

    geoid_col = find_geoid_col(tracts_gdf)
    joined = gpd.sjoin(mb_gdf, tracts_gdf.to_crs(4326), how="left", predicate="within")

    if geoid_col and geoid_col in joined.columns:
        joined["gisjoin"] = (
            joined[geoid_col]
            .apply(normalize_geoid)
            .apply(lambda g: geoid_to_gisjoin(g) if len(g) == 11 else None)
        )
    else:
        print("    WARNING: no GEOID column found -- skipping spatial join")
        return pd.DataFrame(columns=["gisjoin"]), []

    for c in ["singfamhu", "smmultifam", "lgmultifam", "affrd_unit"]:
        joined[c] = pd.to_numeric(joined[c], errors="coerce").fillna(0)

    # MassBuilds sometimes reports affrd_unit > hu; cap so tract totals match denominators.
    joined["affrd_unit"] = joined[["affrd_unit", "hu"]].min(axis=1)

    joined = joined.dropna(subset=["gisjoin"])

    # Per-tract aggregates (all projects, no dev-level filtering)
    agg = (
        joined.groupby(["gisjoin", "decade"])
        .agg(
            new_units=("hu", "sum"),
            new_singfam=("singfamhu", "sum"),
            new_sm_multifam=("smmultifam", "sum"),
            new_lg_multifam=("lgmultifam", "sum"),
            new_affordable=("affrd_unit", "sum"),
        )
        .reset_index()
    )

    pivot = agg.pivot(index="gisjoin", columns="decade")
    pivot.columns = [f"{col}_{dec}" for col, dec in pivot.columns]
    pivot = pivot.fillna(0).reset_index()

    # Tract totals for 1990–2020 completions (excludes 2021+ still in 10_20 bucket)
    cy = joined["completion_year"]
    win = joined[cy.between(1990, 2020, inclusive="both")]
    if len(win) > 0:
        long_agg = (
            win.groupby("gisjoin")
            .agg(
                new_units=("hu", "sum"),
                new_singfam=("singfamhu", "sum"),
                new_sm_multifam=("smmultifam", "sum"),
                new_lg_multifam=("lgmultifam", "sum"),
                new_affordable=("affrd_unit", "sum"),
            )
            .reset_index()
        )
        rename_90_20 = {c: f"{c}_90_20" for c in long_agg.columns if c != "gisjoin"}
        long_agg = long_agg.rename(columns=rename_90_20)
        pivot = pivot.merge(long_agg, on="gisjoin", how="left")
        for c in rename_90_20.values():
            if c in pivot.columns:
                pivot[c] = pivot[c].fillna(0)

    # Individual project records for frontend
    bool_cols = ["mixed_use", "rdv", "ovr55", "asofright"]
    for c in bool_cols:
        if c in joined.columns:
            joined[c] = joined[c].fillna(False).astype(bool)

    projects = []
    for _, row in joined.iterrows():
        cy_val = row["completion_year"]
        cy_out = int(cy_val) if pd.notna(cy_val) else None
        projects.append({
            "gisjoin": row["gisjoin"],
            "lat": round(float(row["latitude"]), 5),
            "lon": round(float(row["longitude"]), 5),
            "hu": int(row["hu"]),
            "singfamhu": int(row["singfamhu"]),
            "smmultifam": int(row["smmultifam"]),
            "lgmultifam": int(row["lgmultifam"]),
            "affrd_unit": int(row["affrd_unit"]),
            "affrd_source": str(row.get("affrd_source", "mb")),
            "mixed_use": bool(row.get("mixed_use", False)),
            "rdv": bool(row.get("rdv", False)),
            "ovr55": bool(row.get("ovr55", False)),
            "asofright": bool(row.get("asofright", False)),
            "decade": row["decade"],
            "completion_year": cy_out,
            "name": str(row.get("name", "")) or "",
            "municipal": str(row.get("municipal", "")) or "",
        })

    print(f"    {len(mb)} projects -> {len(pivot)} tracts with development")
    print(f"    {len(projects)} individual project records exported")
    return pivot, projects


# ═══════════════════════════════════════════════════════════════════
# Step 5: MBTA stops → transit proximity per tract
# ═══════════════════════════════════════════════════════════════════

def load_mbta(tracts_gdf):
    stops_path = RAW / "mbta_stops" / "mbta_stops_collapsed.geojson"
    print(f"  Reading {stops_path.name} ...")
    stops_raw = gpd.read_file(stops_path)

    # Deduplicate co-located platforms: round coordinates and merge routes from
    # overlapping stops (child platforms at the same station share a location).
    stops_raw["_rlat"] = stops_raw.geometry.y.round(4)
    stops_raw["_rlon"] = stops_raw.geometry.x.round(4)
    dedup_rows = []
    for (rlat, rlon), grp in stops_raw.groupby(["_rlat", "_rlon"]):
        base = grp.iloc[0].copy()
        merged_routes = []
        seen_route_ids = set()
        merged_modes = set()
        for _, row in grp.iterrows():
            routes = row["routes"] if isinstance(row["routes"], list) else []
            for r in routes:
                rid = r.get("route_id")
                if rid not in seen_route_ids:
                    merged_routes.append(r)
                    seen_route_ids.add(rid)
        base["routes"] = merged_routes
        dedup_rows.append(base)
    stops_raw = gpd.GeoDataFrame(dedup_rows, geometry="geometry", crs=stops_raw.crs)
    stops_raw = stops_raw.drop(columns=["_rlat", "_rlon"], errors="ignore")
    print(f"    {len(stops_raw)} unique stop locations after dedup")

    def _parse_routes(routes_val):
        """Parse routes field (already a list of dicts from GeoJSON) into mode set and route details."""
        modes = set()
        route_details = []
        items = routes_val if isinstance(routes_val, list) else []
        for r in items:
            rt = int(r.get("route_type", -1))
            color = str(r.get("route_color", "")).strip()
            if not color.startswith("#") and color:
                color = f"#{color}"
            name = r.get("route_short_name") or r.get("route_long_name") or r.get("route_id", "")
            if rt in (0, 1):
                modes.add("rail")
                route_details.append({"name": str(name), "color": color, "type": "rail"})
            elif rt == 2:
                modes.add("commuter_rail")
                route_details.append({"name": str(name), "color": color, "type": "commuter_rail"})
            elif rt == 3:
                modes.add("bus")
                route_details.append({"name": str(name), "color": color, "type": "bus"})
        return modes, route_details

    parsed = stops_raw["routes"].apply(_parse_routes)
    stops_raw["modes"] = parsed.apply(lambda x: x[0])
    stops_raw["route_details"] = parsed.apply(lambda x: x[1])

    # Project everything to MA State Plane (metres)
    tracts_proj = tracts_gdf.to_crs(epsg=26986)
    stops_proj = stops_raw.to_crs(epsg=26986)

    # Buffer each tract polygon by 0.1 miles (160.934 m) and count stops inside
    BUFFER_MI = 0.1
    BUFFER_M = BUFFER_MI * 1609.344
    buffered = tracts_proj.copy()
    buffered["geometry"] = tracts_proj.geometry.buffer(BUFFER_M)

    # Spatial join: find which stops fall within each buffered tract
    sj = gpd.sjoin(stops_proj, buffered, how="inner", predicate="within")

    geoid_col = find_geoid_col(tracts_gdf)
    gisjoins = (
        tracts_gdf[geoid_col]
        .apply(normalize_geoid)
        .apply(lambda g: geoid_to_gisjoin(g) if len(g) == 11 else "")
    )
    idx_to_gj = dict(enumerate(gisjoins.values))

    # Aggregate per tract
    stop_counts = {}
    mode_flags = {}
    for tract_idx, grp in sj.groupby("index_right"):
        gj = idx_to_gj.get(tract_idx, "")
        if not gj:
            continue
        stop_counts[gj] = len(grp)
        modes = set()
        for _, row in grp.iterrows():
            m = row.get("modes", set())
            modes |= m if isinstance(m, set) else set(m)
        mode_flags[gj] = modes

    transit_rows = []
    for gj in gisjoins.values:
        count = stop_counts.get(gj, 0)
        modes = mode_flags.get(gj, set())
        transit_rows.append({
            "gisjoin": gj,
            "transit_stops": count,
            "has_rail": "rail" in modes,
            "has_commuter_rail": "commuter_rail" in modes,
            "has_bus": "bus" in modes,
            "is_tod": count > 0,
        })
    transit_df = pd.DataFrame(transit_rows)

    # Simplified stops for map overlay export
    stops_export = []
    for _, row in stops_raw.iterrows():
        if row.geometry is None:
            continue
        details = row.get("route_details", [])
        # Determine a single display color: prefer rail > commuter_rail > bus
        display_color = ""
        for prio_type in ["rail", "commuter_rail", "bus"]:
            for d in details:
                if d["type"] == prio_type and d["color"]:
                    display_color = d["color"]
                    break
            if display_color:
                break

        route_names = sorted(set(d["name"] for d in details if d["name"]))

        stops_export.append({
            "id": row.get("stop_id", ""),
            "name": row.get("stop_name", ""),
            "lat": round(row.geometry.y, 5),
            "lon": round(row.geometry.x, 5),
            "modes": sorted(row["modes"]),
            "color": display_color,
            "routes": route_names,
        })

    print(f"    {len(transit_df)} tracts, {transit_df['is_tod'].sum()} classified as TOD")
    return transit_df, stops_export, stops_proj


def attach_nearest_stop_to_projects(projects, stops_proj):
    """Attach nearest MBTA stop distance (m) and modes to each MassBuilds project (mutates list).

    Uses EPSG:26986 projected coordinates for metre-accurate distances.

    Parameters
    ----------
    projects : list[dict]
        Records from ``load_massbuilds`` with ``lat`` / ``lon``.
    stops_proj : geopandas.GeoDataFrame | None
        Deduped MBTA stops in EPSG:26986 with a ``modes`` column (set of str).

    Returns
    -------
    list[dict]
        Same list with ``nearest_stop_dist_m`` and ``nearest_stop_modes`` on each dict.
    """
    if not projects:
        return projects
    if stops_proj is None or len(stops_proj) == 0:
        for p in projects:
            p["nearest_stop_dist_m"] = None
            p["nearest_stop_modes"] = []
        return projects

    geom = [Point(p["lon"], p["lat"]) for p in projects]
    dev_gdf = gpd.GeoDataFrame({"_i": range(len(projects))}, geometry=geom, crs="EPSG:4326")
    dev_gdf = dev_gdf.to_crs(epsg=26986)

    # Must keep ``geometry`` — selecting only ``modes`` drops geometry and breaks ``sjoin_nearest``.
    right = stops_proj[["geometry", "modes"]].copy()
    joined = gpd.sjoin_nearest(dev_gdf, right, how="left", distance_col="nearest_stop_dist_m")
    # If multiple nearest ties exist, keep the smallest distance per project index
    joined = joined.sort_values("nearest_stop_dist_m").drop_duplicates("_i", keep="first")

    by_i = {}
    for _, row in joined.iterrows():
        i = int(row["_i"])
        dist = row["nearest_stop_dist_m"]
        modes = row.get("modes")
        by_i[i] = (dist, modes)

    for i, p in enumerate(projects):
        if i not in by_i:
            p["nearest_stop_dist_m"] = None
            p["nearest_stop_modes"] = []
            continue
        dist, modes = by_i[i]
        if dist is not None and pd.notna(dist):
            p["nearest_stop_dist_m"] = round(float(dist), 2)
        else:
            p["nearest_stop_dist_m"] = None
        if modes is None or (isinstance(modes, float) and pd.isna(modes)):
            p["nearest_stop_modes"] = []
        elif isinstance(modes, set):
            p["nearest_stop_modes"] = sorted(modes)
        elif isinstance(modes, (list, tuple)):
            p["nearest_stop_modes"] = sorted(set(str(x) for x in modes))
        else:
            p["nearest_stop_modes"] = []

    return projects


# ═══════════════════════════════════════════════════════════════════
# Step 6: Merge everything and export
# ═══════════════════════════════════════════════════════════════════

def build_variable_meta():
    """Return metadata for the dashboard's axis selectors."""
    y_vars = [
        # Category A – Displacement Proxies
        {"key": "owner_pct_change", "label": "Owner-Occupied Share Change (pp)", "cat": "A", "catLabel": "Displacement Proxies"},
        {"key": "minority_owner_pct_change", "label": "Minority Homeownership Change (pp)", "cat": "A", "catLabel": "Displacement Proxies"},
        {"key": "vacancy_rate_change", "label": "Vacancy Rate Change (pp)", "cat": "A", "catLabel": "Displacement Proxies"},
        # Category B – Succession Indicators
        {"key": "pop_change_pct", "label": "Population Change (%)", "cat": "B", "catLabel": "Succession Indicators"},
        {"key": "minority_pct_change", "label": "Minority Share Change (pp)", "cat": "B", "catLabel": "Succession Indicators"},
        {"key": "median_income_change_pct", "label": "Median Income Change (%)", "cat": "B", "catLabel": "Succession Indicators"},
        {"key": "poverty_rate_change", "label": "Poverty Rate Change (pp)", "cat": "B", "catLabel": "Succession Indicators"},
        {"key": "bachelors_pct_change", "label": "Bachelor's Degree Share Change (pp)", "cat": "B", "catLabel": "Succession Indicators"},
        {"key": "foreign_born_pct_change", "label": "Foreign-Born Share Change (pp)", "cat": "B", "catLabel": "Succession Indicators"},
        # Category C – TOD Outcomes
        {"key": "transit_pct_change", "label": "Transit Commute Share Change (pp)", "cat": "C", "catLabel": "TOD Outcomes"},
        {"key": "drove_alone_pct_change", "label": "Drove-Alone Share Change (pp)", "cat": "C", "catLabel": "TOD Outcomes"},
        {"key": "avg_travel_time_change", "label": "Avg Travel Time Change (min)", "cat": "C", "catLabel": "TOD Outcomes"},
    ]
    x_vars = [
        {
            "key": "census_hu_change",
            "label": "Census % HU change (decennial)",
            "source": "census",
            "sourceLabel": "Census (decennial)",
        },
        {
            "key": "pct_stock_increase",
            "label": "Housing stock increase (%)",
            "source": "massbuilds",
            "sourceLabel": "MassBuilds (filtered developments)",
        },
        {
            "key": "multifam_share",
            "label": "Multifamily share of new dev",
            "source": "massbuilds",
            "sourceLabel": "MassBuilds (filtered developments)",
        },
        {
            "key": "affordable_share",
            "label": "Affordable share of new dev",
            "source": "massbuilds",
            "sourceLabel": "MassBuilds + HUD LIHTC (matched fills)",
        },
        {
            "key": "affordable_stock_pct",
            "label": "Affordable increase / housing stock (%)",
            "source": "massbuilds",
            "sourceLabel": "MassBuilds + HUD LIHTC (matched fills)",
        },
        {
            "key": "multifam_stock_pct",
            "label": "Multifamily increase / housing stock (%)",
            "source": "massbuilds",
            "sourceLabel": "MassBuilds (filtered developments)",
        },
        {
            "key": "new_units",
            "label": "Total new units",
            "source": "massbuilds",
            "sourceLabel": "MassBuilds (filtered developments)",
        },
        {
            "key": "new_affordable",
            "label": "New affordable units",
            "source": "massbuilds",
            "sourceLabel": "MassBuilds + HUD LIHTC (matched fills)",
        },
    ]
    return {"yVariables": y_vars, "xVariables": x_vars}


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    print("\n[1/7] Tract boundaries")
    tracts_gdf = load_tracts()
    geoid_col = find_geoid_col(tracts_gdf)

    print("\n[2/7] NHGIS geographic crosswalks")
    xw_2000_2010 = load_crosswalk("2000_2010")
    xw_2020_2010 = load_crosswalk("2020_2010")

    print("\n[3/7] Standardised census data")
    std = load_standardized()

    print("\n[4/7] Nominal census data (crosswalk-harmonised)")
    nom = load_nominal(xw_2000_2010, xw_2020_2010)

    print("\n[5/7] MassBuilds development data")
    dev, projects_export = load_massbuilds(tracts_gdf)

    print("\n[6/7] MBTA transit data")
    transit_df, stops_export, stops_proj = load_mbta(tracts_gdf)

    print("\n[6b/7] Nearest stop distance per development")
    projects_export = attach_nearest_stop_to_projects(projects_export, stops_proj)

    # ── Merge ────────────────────────────────────────────────────
    print("\n[7/7] Merging & exporting ...")

    # Join nominal → standardised via GJOIN2010
    nom_clean = nom.rename(columns={"gjoin2010": "gisjoin"}).dropna(subset=["gisjoin"])
    merged = std.merge(nom_clean, on="gisjoin", how="left", suffixes=("", "_nom"))

    # Join development data
    if not dev.empty and "gisjoin" in dev.columns:
        merged = merged.merge(dev, on="gisjoin", how="left")

    # Join transit proximity
    if not transit_df.empty:
        merged = merged.merge(transit_df, on="gisjoin", how="left")

    # Fill NaN development/transit columns with 0 / False
    dev_cols = [c for c in merged.columns if c.startswith("new_")]
    for c in dev_cols:
        merged[c] = merged[c].fillna(0)
    if "transit_stops" in merged.columns:
        merged["transit_stops"] = merged["transit_stops"].fillna(0).astype(int)
    for c in ["has_rail", "has_commuter_rail", "has_bus", "is_tod"]:
        if c in merged.columns:
            merged[c] = merged[c].fillna(False).astype(bool)

    # Add centroid coordinates and area from tract boundaries
    tracts_proj = tracts_gdf.to_crs(epsg=26986)  # MA State Plane (meters)
    SQ_M_PER_SQ_MI = 2_589_988.11
    geoid_map = {}
    for idx, row in tracts_gdf.iterrows():
        raw_geoid = normalize_geoid(row[geoid_col])
        if len(raw_geoid) == 11:
            gj = geoid_to_gisjoin(raw_geoid)
            c = row.geometry.centroid
            area_sq_mi = round(tracts_proj.iloc[idx].geometry.area / SQ_M_PER_SQ_MI, 3)
            geoid_map[gj] = {
                "geoid": raw_geoid,
                "centlat": round(c.y, 5),
                "centlon": round(c.x, 5),
                "area_sq_mi": area_sq_mi,
            }

    merged["geoid"] = merged["gisjoin"].map(lambda g: geoid_map.get(g, {}).get("geoid", ""))
    merged["centlat"] = merged["gisjoin"].map(lambda g: geoid_map.get(g, {}).get("centlat"))
    merged["centlon"] = merged["gisjoin"].map(lambda g: geoid_map.get(g, {}).get("centlon"))
    merged["area_sq_mi"] = merged["gisjoin"].map(lambda g: geoid_map.get(g, {}).get("area_sq_mi"))

    # Census net housing unit change by period (decennial counts). App derives % growth vs period-start stock for maps/scatter X.
    for s, e, tag in [
        (1990, 2000, "90_00"),
        (2000, 2010, "00_10"),
        (2010, 2020, "10_20"),
        (2000, 2020, "00_20"),
        (1990, 2020, "90_20"),
    ]:
        S, E = str(s), str(e)
        c0, c1 = f"total_hu_{S}", f"total_hu_{E}"
        if c0 in merged.columns and c1 in merged.columns:
            merged[f"census_hu_change_{tag}"] = (
                pd.to_numeric(merged[c1], errors="coerce")
                - pd.to_numeric(merged[c0], errors="coerce")
            ).round(0)

    # ── Compute control-group averages (non-TOD tracts) ──────────
    if "is_tod" in merged.columns:
        control = merged[~merged["is_tod"]]
    else:
        control = merged
    change_cols = [c for c in merged.columns if "_change_" in c or c.startswith("pct_stock")]
    control_avgs = {}
    for tag in ["90_00", "00_10", "10_20", "90_20", "00_20"]:
        tag_cols = [c for c in change_cols if c.endswith(tag)]
        avgs = {}
        for c in tag_cols:
            if c in control.columns:
                val = control[c].mean()
                avgs[c] = round(float(val), 2) if pd.notna(val) else None
            else:
                avgs[c] = None
        control_avgs[tag] = avgs

    # ── Export JSON ──────────────────────────────────────────────

    # 1. tract_data.json -- one record per tract (NaN -> null)
    merged = merged.where(merged.notna(), None)
    records = json.loads(merged.to_json(orient="records"))
    (OUT / "tract_data.json").write_text(
        json.dumps(records, default=str), encoding="utf-8"
    )
    print(f"  tract_data.json  ({len(records)} tracts)")

    # 2. tracts.geojson – simplified boundaries
    tracts_out = tracts_gdf.copy()
    tracts_out["gisjoin"] = (
        tracts_out[geoid_col]
        .apply(normalize_geoid)
        .apply(lambda g: geoid_to_gisjoin(g) if len(g) == 11 else "")
    )
    keep_cols = ["gisjoin", "geometry"]
    tracts_out = tracts_out[keep_cols]
    tracts_out.to_file(OUT / "tracts.geojson", driver="GeoJSON")
    print(f"  tracts.geojson   ({len(tracts_out)} features)")

    # 3. developments.json – individual project records for client-side filtering
    (OUT / "developments.json").write_text(
        json.dumps(projects_export), encoding="utf-8"
    )
    print(f"  developments.json ({len(projects_export)} projects)")

    # 4. mbta_stops.json
    (OUT / "mbta_stops.json").write_text(
        json.dumps(stops_export), encoding="utf-8"
    )
    print(f"  mbta_stops.json  ({len(stops_export)} stops)")

    # 5. mbta_lines.geojson – copy from raw
    lines_src = RAW / "mbta_lines" / "lines.geojson"
    lines_gdf = gpd.read_file(lines_src)
    keep = ["route_id", "route_short_name", "route_long_name", "route_type", "route_color", "geometry"]
    keep = [c for c in keep if c in lines_gdf.columns]
    lines_gdf[keep].to_file(OUT / "mbta_lines.geojson", driver="GeoJSON")
    print(f"  mbta_lines.geojson ({len(lines_gdf)} routes)")

    # 6. meta.json
    meta = build_variable_meta()
    meta["controlAverages"] = control_avgs
    (OUT / "meta.json").write_text(
        json.dumps(meta, indent=2), encoding="utf-8"
    )
    print("  meta.json")

    print("\nDone.")


if __name__ == "__main__":
    main()
