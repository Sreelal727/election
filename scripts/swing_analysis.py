#!/usr/bin/env python3
"""
Swing Vote Analysis - Booth Level.

Identifies and categorizes swing votes at each booth using:
1. Anti-incumbency swing (LDF erosion 2021→2024)
2. T20 redistribution (T20→NDA split)
3. BDJS defection (Ezhava LDF→NDA)
4. New voter swing (first-time voters since 2021)
5. Turnout differential swing
6. Genuine cross-voting swing

Usage:
    python3 scripts/swing_analysis.py --constituency kochi
"""
import csv
import json
import os
import argparse
from collections import defaultdict


def load_booth_data(constituency_key):
    path = f'data/constituencies/{constituency_key}/booth_data.csv'
    booths = {}
    with open(path, encoding='utf-8') as f:
        for r in csv.DictReader(f):
            booths[int(r['Booth_No'])] = r
    return booths


def load_vote_arithmetic(constituency_key):
    path = f'data/constituencies/{constituency_key}/vote_arithmetic.json'
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def safe_int(v):
    try:
        return int(v or 0)
    except (ValueError, TypeError):
        return 0


def analyze_swing(constituency_key):
    booths = load_booth_data(constituency_key)
    arith = load_vote_arithmetic(constituency_key)

    if not booths:
        print("No booth data found")
        return

    print(f"{'=' * 80}")
    print(f"  SWING VOTE ANALYSIS - {constituency_key.upper()}")
    print(f"  {len(booths)} booths analyzed")
    print(f"{'=' * 80}")

    results = []
    totals = defaultdict(int)

    for bno in sorted(booths.keys()):
        b = booths[bno]

        udf21 = safe_int(b.get('UDF_2021'))
        ldf21 = safe_int(b.get('LDF_2021'))
        t20_21 = safe_int(b.get('T20_2021'))
        nda21 = safe_int(b.get('NDA_BJP_2021'))
        total_21 = udf21 + ldf21 + t20_21 + nda21

        udf24 = safe_int(b.get('UDF_2024'))
        ldf24 = safe_int(b.get('LDF_2024'))
        nda24 = safe_int(b.get('NDA_2024'))
        total_24 = udf24 + ldf24 + nda24

        zone = b.get('Zone', '')
        btype = b.get('Type', '')
        location = b.get('Location', '')

        # ========================================
        # SWING TYPE 1: Anti-Incumbency (LDF erosion)
        # ========================================
        # LDF lost votes from 2021 Assembly to 2024 Parliament
        # This is the raw anti-incumbency signal
        anti_inc_raw = ldf21 - ldf24 if total_24 > 0 else 0
        anti_inc_pct = (anti_inc_raw / ldf21 * 100) if ldf21 > 0 else 0

        # Classify intensity
        if anti_inc_pct > 60:
            anti_inc_level = 'EXTREME'
        elif anti_inc_pct > 40:
            anti_inc_level = 'HIGH'
        elif anti_inc_pct > 20:
            anti_inc_level = 'MODERATE'
        elif anti_inc_pct > 0:
            anti_inc_level = 'LOW'
        else:
            anti_inc_level = 'NONE'  # LDF gained or held

        # ========================================
        # SWING TYPE 2: T20 Redistribution
        # ========================================
        # T20 had votes in 2021. Now T20 joined NDA.
        # Split: 65% NDA, 25% UDF, 10% floating
        t20_to_nda = round(t20_21 * 0.65)
        t20_to_udf = round(t20_21 * 0.25)
        t20_floating = t20_21 - t20_to_nda - t20_to_udf

        # Classify T20 impact
        if t20_21 > 200:
            t20_impact = 'VERY HIGH'
        elif t20_21 > 100:
            t20_impact = 'HIGH'
        elif t20_21 > 50:
            t20_impact = 'MODERATE'
        elif t20_21 > 0:
            t20_impact = 'LOW'
        else:
            t20_impact = 'NONE'

        # ========================================
        # SWING TYPE 3: BDJS Defection (Ezhava LDF→NDA)
        # ========================================
        # BDJS joined NDA, pulling Ezhava votes from LDF
        # Estimate: affects Hindu OBC-heavy booths
        # Proxy: booths where NDA_2024 > NDA_2021 AND LDF dropped
        # The excess NDA growth beyond T20 addition = BDJS effect
        expected_nda_24 = nda21 + t20_to_nda  # BJP base + T20 loyalists
        if total_24 > 0:
            bdjs_swing = max(0, nda24 - expected_nda_24)  # Extra NDA votes = BDJS
        else:
            bdjs_swing = 0

        # ========================================
        # SWING TYPE 4: Genuine UDF Growth
        # ========================================
        # UDF votes in 2024 minus (UDF 2021 + T20-to-UDF transfer)
        # This is genuine new support for UDF
        expected_udf_24 = udf21 + t20_to_udf
        if total_24 > 0:
            genuine_udf_growth = max(0, udf24 - expected_udf_24)
        else:
            genuine_udf_growth = 0

        # ========================================
        # SWING TYPE 5: Turnout Differential
        # ========================================
        # If 2024 had higher turnout than 2021, extra voters came out
        # These extra voters tend to be anti-incumbent
        turnout_diff = total_24 - total_21 if total_24 > 0 and total_21 > 0 else 0

        # ========================================
        # SWING TYPE 6: Net Swing Classification
        # ========================================
        # Total swing = how much the race shifted at this booth
        udf_swing = (udf24 - udf21) if total_24 > 0 else 0
        ldf_swing = (ldf24 - ldf21) if total_24 > 0 else 0

        # Classify booth swing status
        if total_24 == 0:
            swing_class = 'NO DATA'
        elif udf_swing > 150:
            swing_class = 'STRONG UDF SWING'
        elif udf_swing > 50:
            swing_class = 'UDF SWING'
        elif udf_swing > 0:
            swing_class = 'SLIGHT UDF SWING'
        elif ldf_swing > 0:
            swing_class = 'LDF HOLDS'
        else:
            swing_class = 'BOTH DECLINE (NDA GAINS)'

        # ========================================
        # TOTAL SWING VOTES at this booth
        # ========================================
        # Swing votes = voters who changed their party preference
        total_swing_votes = (
            abs(anti_inc_raw) +  # LDF voters who left
            t20_21 +             # All T20 voters are "swinging" somewhere
            bdjs_swing +         # BDJS defection
            abs(turnout_diff)    # New/lost turnout
        )
        # Avoid double counting: cap at total booth size
        total_swing_votes = min(total_swing_votes, total_21)

        # Swing as % of booth
        swing_pct = (total_swing_votes / total_21 * 100) if total_21 > 0 else 0

        # Classify volatility
        if swing_pct > 60:
            volatility = 'EXTREME'
        elif swing_pct > 40:
            volatility = 'HIGH'
        elif swing_pct > 25:
            volatility = 'MODERATE'
        else:
            volatility = 'LOW'

        row = {
            'Booth_No': bno,
            'Location': location,
            'Zone': zone,
            'Type': btype,
            # 2021 votes
            'UDF_2021': udf21,
            'LDF_2021': ldf21,
            'T20_2021': t20_21,
            'NDA_2021': nda21,
            'Total_2021': total_21,
            # 2024 votes
            'UDF_2024': udf24,
            'LDF_2024': ldf24,
            'NDA_2024': nda24,
            'Total_2024': total_24,
            # Swing Type 1: Anti-incumbency
            'Anti_Inc_Votes': anti_inc_raw,
            'Anti_Inc_Pct': round(anti_inc_pct, 1),
            'Anti_Inc_Level': anti_inc_level,
            # Swing Type 2: T20 redistribution
            'T20_to_NDA': t20_to_nda,
            'T20_to_UDF': t20_to_udf,
            'T20_Floating': t20_floating,
            'T20_Impact': t20_impact,
            # Swing Type 3: BDJS defection
            'BDJS_Swing': bdjs_swing,
            # Swing Type 4: Genuine UDF growth
            'Genuine_UDF_Growth': genuine_udf_growth,
            # Swing Type 5: Turnout differential
            'Turnout_Diff': turnout_diff,
            # Swing Type 6: Classification
            'UDF_Swing': udf_swing,
            'LDF_Swing': ldf_swing,
            'Swing_Class': swing_class,
            # Totals
            'Total_Swing_Votes': total_swing_votes,
            'Swing_Pct': round(swing_pct, 1),
            'Volatility': volatility,
        }
        results.append(row)

        # Accumulate totals
        totals['anti_inc'] += max(0, anti_inc_raw)
        totals['t20_to_nda'] += t20_to_nda
        totals['t20_to_udf'] += t20_to_udf
        totals['t20_floating'] += t20_floating
        totals['bdjs'] += bdjs_swing
        totals['genuine_udf'] += genuine_udf_growth
        totals['turnout_diff'] += abs(turnout_diff)
        totals['total_swing'] += total_swing_votes

    # ========================================
    # PRINT SUMMARY
    # ========================================
    print(f"\n  SWING VOTE BREAKDOWN")
    print(f"  {'─' * 55}")
    print(f"  {'Category':<35} {'Votes':>8} {'% of Total':>10}")
    print(f"  {'─' * 55}")

    total_all_votes = sum(safe_int(b.get('UDF_2021', 0)) + safe_int(b.get('LDF_2021', 0)) +
                          safe_int(b.get('T20_2021', 0)) + safe_int(b.get('NDA_BJP_2021', 0))
                          for b in booths.values())

    categories = [
        ('Anti-Incumbency (LDF erosion)', totals['anti_inc']),
        ('T20 → NDA (loyal base)', totals['t20_to_nda']),
        ('T20 → UDF (anti-BJP)', totals['t20_to_udf']),
        ('T20 → Floating', totals['t20_floating']),
        ('BDJS Defection (LDF→NDA)', totals['bdjs']),
        ('Genuine UDF Growth', totals['genuine_udf']),
        ('Turnout Differential', totals['turnout_diff']),
    ]

    for cat, votes in categories:
        pct = votes / total_all_votes * 100 if total_all_votes > 0 else 0
        bar = '█' * int(pct)
        print(f"  {cat:<35} {votes:>8,} {pct:>9.1f}% {bar}")

    print(f"  {'─' * 55}")
    print(f"  {'TOTAL SWING POOL':<35} {totals['total_swing']:>8,}")

    # Volatility distribution
    vol_counts = defaultdict(int)
    for r in results:
        vol_counts[r['Volatility']] += 1
    print(f"\n  BOOTH VOLATILITY DISTRIBUTION")
    for v in ['EXTREME', 'HIGH', 'MODERATE', 'LOW']:
        count = vol_counts.get(v, 0)
        print(f"    {v:<12}: {count:>3} booths {'█' * count}")

    # Swing class distribution
    print(f"\n  SWING CLASSIFICATION")
    swing_counts = defaultdict(int)
    for r in results:
        swing_counts[r['Swing_Class']] += 1
    for cls, count in sorted(swing_counts.items(), key=lambda x: -x[1]):
        print(f"    {cls:<25}: {count:>3} booths")

    # Top swing booths
    print(f"\n  TOP 15 HIGHEST SWING BOOTHS")
    print(f"  {'Booth':>5} {'Swing%':>7} {'SwingV':>7} {'Vol':>8} {'Anti-Inc':>8} {'T20':>5} {'Class':<22} Location")
    print(f"  {'─' * 95}")
    for r in sorted(results, key=lambda x: -x['Swing_Pct'])[:15]:
        print(f"  {r['Booth_No']:>5} {r['Swing_Pct']:>6.1f}% {r['Total_Swing_Votes']:>7,} "
              f"{r['Volatility']:>8} {r['Anti_Inc_Votes']:>8,} {r['T20_2021']:>5,} "
              f"{r['Swing_Class']:<22} {r['Location'][:30]}")

    # Save CSV
    out_dir = f'data/constituencies/{constituency_key}'
    csv_path = os.path.join(out_dir, 'swing_analysis.csv')
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=results[0].keys())
        writer.writeheader()
        writer.writerows(results)
    print(f"\n  Saved: {csv_path}")

    # Save summary JSON
    summary = {
        'constituency': constituency_key,
        'booths_analyzed': len(results),
        'swing_breakdown': {cat: votes for cat, votes in categories},
        'total_swing_pool': totals['total_swing'],
        'volatility_distribution': dict(vol_counts),
        'swing_classification': dict(swing_counts),
        'methodology': {
            'anti_incumbency': 'LDF_2021 - LDF_2024 per booth (direct erosion)',
            't20_redistribution': 'T20_2021 * split (65% NDA, 25% UDF, 10% float)',
            'bdjs_defection': 'NDA_2024 - (NDA_2021 + T20_to_NDA) = excess NDA = BDJS effect',
            'genuine_udf_growth': 'UDF_2024 - (UDF_2021 + T20_to_UDF) = new UDF support',
            'turnout_differential': 'abs(Total_2024 - Total_2021) = mobilization change',
            'total_swing': 'Sum of all swing types, capped at booth total (avoid double count)',
        }
    }
    summary_path = os.path.join(out_dir, 'swing_summary.json')
    with open(summary_path, 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"  Saved: {summary_path}")
    print(f"{'=' * 80}")

    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Booth-level swing vote analysis')
    parser.add_argument('--constituency', required=True)
    args = parser.parse_args()
    analyze_swing(args.constituency.lower())
