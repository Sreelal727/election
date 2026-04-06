#!/usr/bin/env python3
"""
Deep Constituency Prediction - Enhanced Monte Carlo with multiple layers.

Layers:
1. Base: 2021 Assembly election results (same as main model)
2. District swing: LSG 2020→2025 district-level (dampened)
3. Constituency swing: Ward-level LSG swing within constituency local bodies
4. Booth-level intel: 2024 Parliament data + booth classification + vote arithmetic
5. Sentiment adjustment: Social media + ground reports
6. Volatility: Historical flips + margin closeness + ward-level variance + booth variance

Usage:
    python scripts/deep_prediction.py --constituency kalamassery
    python scripts/deep_prediction.py --constituency kochi
"""
import csv
import json
import random
import math
import os
import argparse
from collections import defaultdict

random.seed(42)

NUM_SIMULATIONS = 1_000_000

# --- Weight configuration for swing layers ---
# How much each layer contributes to the final adjusted vote share
LAYER_WEIGHTS = {
    'district_swing': 0.30,       # District-level LSG swing (broad signal)
    'constituency_swing': 0.50,   # Ward-level swing within constituency (precise signal)
    'sentiment': 0.20,            # Social media / ground reports (soft signal)
}
SWING_DAMPENING = 0.45  # Same as main model
VOLATILITY_BASE = 4.0

# --- Front mappings for 2016 ---
LDF_2016 = {'CPM', 'CPI', 'JD(S)', 'NCP', 'RSP', 'INL'}
UDF_2016 = {'INC', 'IUML', 'KEC(M)', 'KEC(J)', 'JD(U)', 'KEC'}


def load_base_data(constituency_no):
    """Load 2021 results, 2016 results, 2026 candidates for a constituency."""
    # 2021 results
    result_2021 = None
    with open('data/election_2021_results.csv', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            if int(row['Constituency_No']) == constituency_no:
                result_2021 = {
                    'name': row['Constituency'],
                    'ldf_vs': float(row['LDF_VoteShare']),
                    'udf_vs': float(row['UDF_VoteShare']),
                    'nda_vs': float(row['NDA_VoteShare']),
                    'winner_front': row['Winner_Front'],
                    'margin': int(row['Margin']),
                    'total_votes': int(row['Total_Votes']),
                }
                break

    # 2016 results
    result_2016 = None
    with open('data/election_2016_results.csv', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            if int(row['Constituency_No']) == constituency_no:
                result_2016 = {
                    'winner_party': row['Winner_Party'],
                    'margin': int(row['Margin']),
                }
                break

    # 2026 candidates
    candidates = {}
    with open('data/candidates_2026.csv', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            if int(row['Constituency_No']) == constituency_no:
                candidates = row
                break

    return result_2021, result_2016, candidates


def load_district_swing(district):
    """Load district-level LSG swing."""
    with open('data/lsg_district_swing.csv', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            if row['District'] == district:
                return {
                    'LDF': float(row['LDF_Swing']),
                    'UDF': float(row['UDF_Swing']),
                    'NDA': float(row['NDA_Swing']),
                }
    return {'LDF': 0, 'UDF': 0, 'NDA': 0}


def load_constituency_swing(constituency_key):
    """Load ward-level constituency swing (from constituency_ward_analysis.py output)."""
    filepath = f'data/constituencies/{constituency_key}/constituency_swing.json'
    if not os.path.exists(filepath):
        print(f"  [WARN] No ward-level swing data. Run constituency_ward_analysis.py first.")
        return None

    with open(filepath, encoding='utf-8') as f:
        data = json.load(f)
    return data.get('weighted_constituency_swing', None)


def load_sentiment(constituency_key):
    """Load sentiment adjustment."""
    filepath = f'data/constituencies/{constituency_key}/sentiment_data.json'
    if not os.path.exists(filepath):
        return None

    with open(filepath, encoding='utf-8') as f:
        data = json.load(f)

    adj = data.get('computed_sentiment_adjustment', {})
    if adj.get('confidence', 'low') == 'low' and adj.get('weights_used', 0) == 0:
        return None  # No real data yet

    return {
        'LDF': adj.get('LDF_adjustment', 0),
        'UDF': adj.get('UDF_adjustment', 0),
        'NDA': adj.get('NDA_adjustment', 0),
        'confidence': adj.get('confidence', 'low'),
    }


def load_booth_data(constituency_key):
    """Load booth-level data and vote arithmetic if available."""
    arith_path = f'data/constituencies/{constituency_key}/vote_arithmetic.json'
    booth_path = f'data/constituencies/{constituency_key}/booth_data.csv'

    arithmetic = None
    if os.path.exists(arith_path):
        with open(arith_path, encoding='utf-8') as f:
            arithmetic = json.load(f)

    booths = []
    if os.path.exists(booth_path):
        with open(booth_path, encoding='utf-8') as f:
            for row in csv.DictReader(f):
                booths.append(row)

    return arithmetic, booths


def compute_booth_level_projection(arithmetic, booths):
    """
    Compute vote share projections from booth-level data and vote arithmetic.

    This uses actual 2024 Parliament data and T20→NDA analysis to project
    2026 Assembly vote shares — a much more precise signal than LSG swing.
    """
    if not arithmetic:
        return None

    projections = arithmetic.get('vote_block_projections_2026', {})
    if not projections:
        return None

    # Use midpoint of projected ranges
    udf_proj = (projections['UDF']['min'] + projections['UDF']['max']) / 2
    ldf_proj = (projections['LDF']['min'] + projections['LDF']['max']) / 2
    nda_proj = (projections['NDA']['min'] + projections['NDA']['max']) / 2
    total_proj = udf_proj + ldf_proj + nda_proj

    vote_shares = {
        'UDF': round(udf_proj / total_proj * 100, 2),
        'LDF': round(ldf_proj / total_proj * 100, 2),
        'NDA': round(nda_proj / total_proj * 100, 2),
    }

    # Compute booth-level stats for volatility
    booth_stats = None
    if booths:
        # Count booth types
        type_counts = defaultdict(int)
        for b in booths:
            btype = b.get('Type', '')
            type_counts[btype] += 1

        # Compute 2024 Parliament-based swing
        total_udf_24 = 0
        total_ldf_24 = 0
        total_nda_24 = 0
        counted = 0
        for b in booths:
            try:
                u24 = int(b.get('UDF_2024', 0) or 0)
                l24 = int(b.get('LDF_2024', 0) or 0)
                n24 = int(b.get('NDA_2024', 0) or 0)
                if u24 + l24 + n24 > 0:
                    total_udf_24 += u24
                    total_ldf_24 += l24
                    total_nda_24 += n24
                    counted += 1
            except (ValueError, TypeError):
                continue

        mp_2024_shares = None
        if counted > 0:
            total_24 = total_udf_24 + total_ldf_24 + total_nda_24
            if total_24 > 0:
                mp_2024_shares = {
                    'UDF': round(total_udf_24 / total_24 * 100, 2),
                    'LDF': round(total_ldf_24 / total_24 * 100, 2),
                    'NDA': round(total_nda_24 / total_24 * 100, 2),
                }

        booth_stats = {
            'type_counts': dict(type_counts),
            'mp_2024_shares': mp_2024_shares,
            'booths_counted': counted,
        }

    return {
        'vote_shares': vote_shares,
        'booth_stats': booth_stats,
        'source': 'booth_data + vote_arithmetic (2016-2024 multi-election analysis)',
    }


def load_ward_variance(constituency_key):
    """Compute ward-level vote share variance to inform volatility."""
    filepath = f'data/constituencies/{constituency_key}/ward_analysis.csv'
    if not os.path.exists(filepath):
        return None

    shares = {'LDF': [], 'UDF': [], 'NDA': []}
    with open(filepath, encoding='utf-8') as f:
        for row in csv.DictReader(f):
            for front in ['LDF', 'UDF', 'NDA']:
                val = row.get(f'{front}_share_2025')
                if val:
                    shares[front].append(float(val))

    if not shares['LDF']:
        return None

    # Compute std deviation of ward-level vote shares
    variances = {}
    for front, vals in shares.items():
        if len(vals) > 1:
            mean = sum(vals) / len(vals)
            variance = sum((v - mean) ** 2 for v in vals) / (len(vals) - 1)
            variances[front] = math.sqrt(variance)
        else:
            variances[front] = 0

    return variances


def run_deep_prediction(constituency_key, constituency_no, district):
    """Run enhanced prediction with all layers."""
    print(f"\n{'=' * 70}")
    print(f"  DEEP PREDICTION MODEL - {constituency_key.upper()}")
    print(f"{'=' * 70}")

    # Layer 0: Base data
    r21, r16, candidates = load_base_data(constituency_no)
    if not r21:
        print(f"  ERROR: No 2021 data for constituency {constituency_no}")
        return

    base = {'LDF': r21['ldf_vs'], 'UDF': r21['udf_vs'], 'NDA': r21['nda_vs']}
    base_oth = 100 - base['LDF'] - base['UDF'] - base['NDA']

    print(f"\n  Layer 0 - BASE (2021 Results):")
    print(f"    LDF: {base['LDF']:.2f}%  UDF: {base['UDF']:.2f}%  NDA: {base['NDA']:.2f}%")

    # Layer 1: District-level swing
    dist_swing = load_district_swing(district)
    print(f"\n  Layer 1 - DISTRICT SWING (Ernakulam LSG 2020→2025):")
    print(f"    LDF: {dist_swing['LDF']:+.2f}%  UDF: {dist_swing['UDF']:+.2f}%  NDA: {dist_swing['NDA']:+.2f}%")

    # Layer 2: Constituency-level ward swing
    const_swing = load_constituency_swing(constituency_key)
    if const_swing:
        print(f"\n  Layer 2 - CONSTITUENCY WARD SWING (local bodies within constituency):")
        print(f"    LDF: {const_swing['LDF']:+.2f}%  UDF: {const_swing['UDF']:+.2f}%  NDA: {const_swing['NDA']:+.2f}%")
    else:
        const_swing = dist_swing  # Fallback to district
        print(f"\n  Layer 2 - CONSTITUENCY WARD SWING: [not available, using district]")

    # Layer 3: Booth-level intel (2024 MP data + vote arithmetic)
    arithmetic, booths = load_booth_data(constituency_key)
    booth_projection = compute_booth_level_projection(arithmetic, booths)
    has_booth_data = booth_projection is not None

    if has_booth_data:
        bvs = booth_projection['vote_shares']
        print(f"\n  Layer 3 - BOOTH-LEVEL INTEL (2024 MP + vote arithmetic):")
        print(f"    Projected: LDF={bvs['LDF']:.2f}% UDF={bvs['UDF']:.2f}% NDA={bvs['NDA']:.2f}%")
        if booth_projection['booth_stats']:
            bs = booth_projection['booth_stats']
            print(f"    Booth types: {bs['type_counts']}")
            if bs['mp_2024_shares']:
                mp = bs['mp_2024_shares']
                print(f"    2024 MP actual: LDF={mp['LDF']:.1f}% UDF={mp['UDF']:.1f}% NDA={mp['NDA']:.1f}%")
        if arithmetic:
            gc = arithmetic.get('game_changer_2026', {})
            if gc.get('T20_joined_NDA'):
                t20v = gc.get('T20_2021_votes', 0)
                print(f"    GAME CHANGER: T20 joined NDA ({t20v:,} votes in 2021 now split)")
                split = gc.get('T20_voter_split_2026', {})
                for grp, info in split.items():
                    print(f"      {grp}: ~{info['votes']:,} votes → {info.get('reason', '')}")
    else:
        print(f"\n  Layer 3 - BOOTH-LEVEL INTEL: [no data]")

    # Layer 4: Sentiment
    sentiment = load_sentiment(constituency_key)
    if sentiment:
        print(f"\n  Layer 4 - SENTIMENT ADJUSTMENT (confidence: {sentiment['confidence']}):")
        print(f"    LDF: {sentiment['LDF']:+.2f}%  UDF: {sentiment['UDF']:+.2f}%  NDA: {sentiment['NDA']:+.2f}%")
    else:
        sentiment = {'LDF': 0, 'UDF': 0, 'NDA': 0, 'confidence': 'none'}
        print(f"\n  Layer 4 - SENTIMENT ADJUSTMENT: [no data yet]")

    # --- Compute final adjusted vote shares ---
    if has_booth_data:
        # When we have booth-level data with 2024 MP + vote arithmetic,
        # it's the strongest signal. Use weighted blend:
        # Booth projection (50%) + LSG swing-adjusted (35%) + sentiment (15%)
        bvs = booth_projection['vote_shares']

        # Compute LSG swing-adjusted shares (same as before but combined)
        lsg_adj = {}
        for front in ['LDF', 'UDF', 'NDA']:
            # Blend district + constituency swing
            if const_swing:
                blended = dist_swing[front] * 0.35 + const_swing[front] * 0.65
            else:
                blended = dist_swing[front]
            lsg_adj[front] = base[front] + blended * SWING_DAMPENING
        # Normalize LSG-adjusted
        lsg_total = sum(max(v, 2) for v in lsg_adj.values()) + base_oth
        for front in lsg_adj:
            lsg_adj[front] = max(lsg_adj[front], 2) / lsg_total * 100

        # Blend: booth (50%) + LSG (35%) + sentiment (15% if available, else redistribute)
        w_booth = 0.50
        w_lsg = 0.35
        w_sent = 0.15
        if sentiment['confidence'] == 'none':
            w_booth = 0.58
            w_lsg = 0.42
            w_sent = 0.0

        adj = {}
        for front in ['LDF', 'UDF', 'NDA']:
            adj[front] = (
                bvs[front] * w_booth +
                lsg_adj[front] * w_lsg +
                (lsg_adj[front] + sentiment.get(front, 0)) * w_sent
            )

        print(f"\n  BLENDED (booth={w_booth:.0%}, LSG={w_lsg:.0%}, sentiment={w_sent:.0%}):")
        print(f"    Booth proj:  LDF={bvs['LDF']:.1f}% UDF={bvs['UDF']:.1f}% NDA={bvs['NDA']:.1f}%")
        print(f"    LSG-adjusted: LDF={lsg_adj['LDF']:.1f}% UDF={lsg_adj['UDF']:.1f}% NDA={lsg_adj['NDA']:.1f}%")

    else:
        # No booth data — use original LSG-based approach
        w = LAYER_WEIGHTS
        if sentiment['confidence'] == 'none':
            total_swing_w = w['district_swing'] + w['constituency_swing'] + w['sentiment']
            effective_w = {
                'district_swing': w['district_swing'] / (w['district_swing'] + w['constituency_swing']) * total_swing_w,
                'constituency_swing': w['constituency_swing'] / (w['district_swing'] + w['constituency_swing']) * total_swing_w,
                'sentiment': 0,
            }
        else:
            effective_w = w

        blended_swing = {}
        for front in ['LDF', 'UDF', 'NDA']:
            blended_swing[front] = (
                dist_swing[front] * effective_w['district_swing'] +
                const_swing[front] * effective_w['constituency_swing'] +
                sentiment.get(front, 0) * effective_w['sentiment']
            )

        print(f"\n  BLENDED SWING (weights: district={effective_w['district_swing']:.0%}, "
              f"constituency={effective_w['constituency_swing']:.0%}, "
              f"sentiment={effective_w['sentiment']:.0%}):")
        print(f"    LDF: {blended_swing['LDF']:+.2f}%  UDF: {blended_swing['UDF']:+.2f}%  NDA: {blended_swing['NDA']:+.2f}%")

        adj = {}
        for front in ['LDF', 'UDF', 'NDA']:
            adj[front] = base[front] + blended_swing[front] * SWING_DAMPENING

    # Ensure non-negative and normalize
    for front in adj:
        adj[front] = max(adj[front], 2)
    total_adj = sum(adj.values()) + base_oth
    for front in adj:
        adj[front] = adj[front] / total_adj * 100

    print(f"\n  FINAL ADJUSTED VOTE SHARES:")
    print(f"    LDF: {adj['LDF']:.2f}%  UDF: {adj['UDF']:.2f}%  NDA: {adj['NDA']:.2f}%")

    # --- Volatility ---
    margin_pct = r21['margin'] / r21['total_votes'] * 100
    volatility = VOLATILITY_BASE + 0.03 * (30 - min(margin_pct, 30))

    # Flip bonus
    if r16:
        if r16['winner_party'] in UDF_2016 and r21['winner_front'] == 'LDF':
            volatility += 1.0
        elif r16['winner_party'] in LDF_2016 and r21['winner_front'] == 'UDF':
            volatility += 1.0

    # Ward-level variance bonus
    ward_var = load_ward_variance(constituency_key)
    ward_vol_bonus = 0
    if ward_var:
        avg_ward_var = sum(ward_var.values()) / len(ward_var)
        ward_vol_bonus = min(avg_ward_var * 0.1, 1.5)  # Cap at 1.5
        volatility += ward_vol_bonus

    # Booth-level variance bonus (if booth data shows high fragmentation)
    booth_vol_bonus = 0
    if has_booth_data and arithmetic:
        # 3-way contest increases volatility
        nda_proj = arithmetic.get('vote_block_projections_2026', {}).get('NDA', {})
        nda_min = nda_proj.get('min', 0)
        if nda_min >= 20000:  # Credible 3-way contest
            booth_vol_bonus = 1.5
        elif nda_min >= 10000:  # NDA is a factor
            booth_vol_bonus = 1.0
        volatility += booth_vol_bonus

        # If seat changed hands multiple times, add more
        hist = arithmetic.get('historical_results', {})
        winners = [v.get('winner', '') for v in hist.values() if v.get('winner')]
        changes = sum(1 for i in range(1, len(winners)) if winners[i] != winners[i-1])
        if changes >= 3:
            volatility += 0.5  # Highly volatile seat

    vol_parts = f"base={VOLATILITY_BASE}"
    vol_parts += f", margin={0.03 * (30 - min(margin_pct, 30)):.2f}"
    if r16:
        vol_parts += ", flip=+1.0"
    if ward_vol_bonus > 0:
        vol_parts += f", ward_var=+{ward_vol_bonus:.2f}"
    if booth_vol_bonus > 0:
        vol_parts += f", 3way_contest=+{booth_vol_bonus:.1f}"
    print(f"\n  VOLATILITY: {volatility:.2f} ({vol_parts})")

    # --- Monte Carlo ---
    wins = {'LDF': 0, 'UDF': 0, 'NDA': 0}
    margin_samples = []

    for i in range(NUM_SIMULATIONS):
        sim_ldf = random.gauss(adj['LDF'], volatility)
        sim_udf = random.gauss(adj['UDF'], volatility)
        sim_nda = random.gauss(adj['NDA'], volatility * 0.7)

        if sim_ldf >= sim_udf and sim_ldf >= sim_nda:
            wins['LDF'] += 1
        elif sim_udf >= sim_ldf and sim_udf >= sim_nda:
            wins['UDF'] += 1
        else:
            wins['NDA'] += 1

        # Track margin for winner confidence
        if i < 10000:
            vals = sorted([(sim_ldf, 'LDF'), (sim_udf, 'UDF'), (sim_nda, 'NDA')], reverse=True)
            margin_samples.append(vals[0][0] - vals[1][0])

    probs = {f: round(wins[f] / NUM_SIMULATIONS * 100, 2) for f in wins}

    # Classification
    max_prob = max(probs.values())
    if max_prob >= 90:
        category = 'Safe'
    elif max_prob >= 70:
        category = 'Likely'
    elif max_prob >= 55:
        category = 'Lean'
    else:
        category = 'Toss-up'
    predicted_winner = max(wins, key=wins.get)
    category = f"{category} {predicted_winner}"

    avg_margin = sum(margin_samples) / len(margin_samples)

    # --- Vote share estimation ---
    # Estimate total voters from arithmetic or 2021 data
    total_voters = r21['total_votes']
    if arithmetic:
        total_voters = arithmetic.get('total_voters_2026', total_voters)
        # Also use scenario-based estimates if available
        scenarios = arithmetic.get('scenarios', {})
        vote_block_proj = arithmetic.get('vote_block_projections_2026', {})

    # Compute estimated votes from adjusted percentages
    est_votes = {}
    for front in ['LDF', 'UDF', 'NDA']:
        est_votes[front] = {
            'vote_share_pct': round(adj[front], 2),
            'estimated_votes': round(adj[front] / 100 * total_voters),
        }

    # If we have vote arithmetic projections, blend with them
    if has_booth_data and arithmetic:
        vbp = arithmetic.get('vote_block_projections_2026', {})
        for front in ['LDF', 'UDF', 'NDA']:
            if front in vbp:
                arith_mid = (vbp[front]['min'] + vbp[front]['max']) / 2
                # Blend: 60% arithmetic (direct estimates), 40% model-derived
                blended_votes = arith_mid * 0.6 + est_votes[front]['estimated_votes'] * 0.4
                est_votes[front]['arithmetic_estimate'] = round(arith_mid)
                est_votes[front]['blended_estimate'] = round(blended_votes)
                est_votes[front]['range'] = [vbp[front]['min'], vbp[front]['max']]

    # Compute margin estimate
    vote_list = [(est_votes[f].get('blended_estimate', est_votes[f]['estimated_votes']), f) for f in est_votes]
    vote_list.sort(reverse=True)
    est_margin = vote_list[0][0] - vote_list[1][0]
    est_winner = vote_list[0][1]

    print(f"\n{'=' * 70}")
    print(f"  PREDICTION RESULTS ({NUM_SIMULATIONS:,} simulations)")
    print(f"{'=' * 70}")
    print(f"  {'Front':<6} {'Win Prob':>10} {'Est. Votes':>12} {'Range':>18}  Candidate")
    print(f"  {'-'*6} {'-'*10} {'-'*12} {'-'*18}  {'-'*30}")
    for front in ['LDF', 'UDF', 'NDA']:
        ev = est_votes[front]
        vote_est = ev.get('blended_estimate', ev['estimated_votes'])
        rng = ev.get('range', None)
        rng_str = f"{rng[0]:,}-{rng[1]:,}" if rng else f"~{vote_est:,}"
        cand_name = candidates.get(f'{front}_Candidate', 'TBD')
        cand_party = candidates.get(f'{front}_Party', '')
        print(f"  {front:<6} {probs[front]:>9.2f}% {vote_est:>11,} {rng_str:>18}  {cand_name} ({cand_party})")

    print(f"\n  Category: {category}")
    print(f"  Est. winning margin: ~{est_margin:,} votes ({est_winner})")
    print(f"  Total voters: ~{total_voters:,}")

    # Compare with main model
    main_pred_path = 'data/predictions_2026.json'
    if os.path.exists(main_pred_path):
        with open(main_pred_path, encoding='utf-8') as f:
            main_preds = json.load(f)
        for p in main_preds:
            if p['Constituency_No'] == constituency_no:
                print(f"\n  --- COMPARISON WITH MAIN MODEL ---")
                print(f"  Main model: LDF={p['LDF_Win_Prob']}% UDF={p['UDF_Win_Prob']}% NDA={p['NDA_Win_Prob']}% [{p['Category']}]")
                print(f"  Deep model: LDF={probs['LDF']}% UDF={probs['UDF']}% NDA={probs['NDA']}% [{category}]")
                diff = {f: round(probs[f] - p[f'{f}_Win_Prob'], 2) for f in ['LDF', 'UDF', 'NDA']}
                print(f"  Delta:      LDF={diff['LDF']:+.2f}% UDF={diff['UDF']:+.2f}% NDA={diff['NDA']:+.2f}%")
                break

    # Save deep prediction
    out_dir = f'data/constituencies/{constituency_key}'
    os.makedirs(out_dir, exist_ok=True)

    deep_output = {
        'constituency_no': constituency_no,
        'constituency': r21['name'],
        'district': district,
        'candidates': {
            'LDF': f"{candidates.get('LDF_Candidate', '')} ({candidates.get('LDF_Party', '')})",
            'UDF': f"{candidates.get('UDF_Candidate', '')} ({candidates.get('UDF_Party', '')})",
            'NDA': f"{candidates.get('NDA_Candidate', '')} ({candidates.get('NDA_Party', '')})",
        },
        'layers': {
            'base_2021': base,
            'district_swing': dist_swing,
            'constituency_swing': const_swing if const_swing != dist_swing else None,
            'booth_projection': booth_projection if has_booth_data else None,
            'sentiment': sentiment if sentiment['confidence'] != 'none' else None,
            'has_booth_data': has_booth_data,
        },
        'adjusted_vote_shares': {k: round(v, 2) for k, v in adj.items()},
        'vote_estimates': est_votes,
        'total_voters': total_voters,
        'estimated_margin': est_margin,
        'estimated_winner': est_winner,
        'volatility': round(volatility, 2),
        'win_probabilities': probs,
        'category': category,
        'avg_simulated_margin': round(avg_margin, 2),
        'comparison_with_main': None,
    }

    # Add comparison
    if os.path.exists(main_pred_path):
        with open(main_pred_path, encoding='utf-8') as f:
            for p in json.load(f):
                if p['Constituency_No'] == constituency_no:
                    deep_output['comparison_with_main'] = {
                        'main_probs': {f: p[f'{f}_Win_Prob'] for f in ['LDF', 'UDF', 'NDA']},
                        'main_category': p['Category'],
                        'delta': {f: round(probs[f] - p[f'{f}_Win_Prob'], 2) for f in ['LDF', 'UDF', 'NDA']},
                    }
                    break

    pred_path = os.path.join(out_dir, 'deep_prediction.json')
    with open(pred_path, 'w', encoding='utf-8') as f:
        json.dump(deep_output, f, ensure_ascii=False, indent=2)

    print(f"\n  Output saved: {pred_path}")
    print(f"{'=' * 70}")

    return deep_output


# Constituency configurations
CONSTITUENCIES = {
    'kalamassery': {'no': 77, 'district': 'Ernakulam'},
    'kochi': {'no': 80, 'district': 'Ernakulam'},
}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Deep constituency prediction')
    parser.add_argument('--constituency', default='kalamassery',
                        choices=list(CONSTITUENCIES.keys()))
    args = parser.parse_args()

    config = CONSTITUENCIES[args.constituency]
    run_deep_prediction(args.constituency, config['no'], config['district'])
