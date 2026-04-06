#!/usr/bin/env python3
"""
Estimate per-booth/part vote counts for a constituency.

Combines:
1. SIR electoral roll (registered voters per part)
2. Booth-level historical data (2021 + 2024 MP patterns)
3. Deep prediction vote share adjustments

For parts that map to known booths (via booth_data.csv), uses booth-specific
historical patterns. For unmapped parts, uses constituency-level averages.

Output: CSV with per-part estimated votes for LDF, UDF, NDA.
"""
import csv
import json
import os
import argparse
from collections import defaultdict


def load_sir_data(constituency_key):
    """Load SIR voter counts per part."""
    path = f'data/constituencies/{constituency_key}/sir_voters.csv'
    parts = {}
    with open(path, encoding='utf-8') as f:
        for r in csv.DictReader(f):
            pno = int(r['part_no'])
            total = int(r['total'])
            male = int(r['male'])
            female = int(r['female'])
            parts[pno] = {
                'part_no': pno,
                'sir_total': total,
                'sir_male': male,
                'sir_female': female,
                'method': r['method'],
                'filename': r['filename'],
            }
    return parts


def load_booth_data(constituency_key):
    """Load historical booth-level data with 2021 + 2024 results."""
    path = f'data/constituencies/{constituency_key}/booth_data.csv'
    if not os.path.exists(path):
        return {}
    booths = {}
    with open(path, encoding='utf-8') as f:
        for r in csv.DictReader(f):
            bno = int(r['Booth_No'])
            booths[bno] = r
    return booths


def load_deep_prediction(constituency_key):
    """Load deep prediction for overall vote shares."""
    path = f'data/constituencies/{constituency_key}/deep_prediction.json'
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def load_vote_arithmetic(constituency_key):
    """Load vote arithmetic for total voter context."""
    path = f'data/constituencies/{constituency_key}/vote_arithmetic.json'
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def estimate_booth_votes(constituency_key):
    """Generate per-part vote estimates."""
    sir_parts = load_sir_data(constituency_key)
    booth_data = load_booth_data(constituency_key)
    pred = load_deep_prediction(constituency_key)
    arith = load_vote_arithmetic(constituency_key)

    adj = pred['adjusted_vote_shares']
    ve = pred['vote_estimates']
    total_sir = sum(p['sir_total'] for p in sir_parts.values())

    # Fix suspicious SIR entries (year 2026 misreads, part numbers as totals)
    avg_sir = total_sir / len(sir_parts) if sir_parts else 600
    clean_parts = {pno: p for pno, p in sir_parts.items()
                   if p['sir_total'] > 50 and p['sir_total'] < 2000
                   and not (p['sir_male'] == 2026 or p['sir_total'] == 2026)}
    if clean_parts:
        avg_sir = sum(p['sir_total'] for p in clean_parts.values()) / len(clean_parts)

    for pno, p in sir_parts.items():
        if pno not in clean_parts:
            p['sir_total'] = round(avg_sir)
            p['sir_corrected'] = True
        else:
            p['sir_corrected'] = False

    total_sir_corrected = sum(p['sir_total'] for p in sir_parts.values())

    # Historical turnout (2021 Kochi: ~77%)
    TURNOUT = 0.77

    # Build part-to-booth mapping
    # In Kochi: 240 parts map to 157 booths
    # Approximate mapping: parts are assigned to booths roughly in order
    # Parts 1-2 → Booth 1, Parts 3-4 → Booth 2, etc. (not always 2:1)
    # Better approach: use booth historical patterns to weight
    num_parts = len(sir_parts)
    num_booths = len(booth_data)

    # Compute booth-level vote share patterns from 2021 data
    booth_patterns = {}
    if booth_data:
        for bno, b in booth_data.items():
            u21 = int(b.get('UDF_2021', 0) or 0)
            l21 = int(b.get('LDF_2021', 0) or 0)
            t20_21 = int(b.get('T20_2021', 0) or 0)
            nda21 = int(b.get('NDA_BJP_2021', 0) or 0)
            total_21 = u21 + l21 + t20_21 + nda21
            if total_21 == 0:
                continue

            # 2024 MP data
            u24 = int(b.get('UDF_2024', 0) or 0)
            l24 = int(b.get('LDF_2024', 0) or 0)
            n24 = int(b.get('NDA_2024', 0) or 0)
            total_24 = u24 + l24 + n24

            # Compute 2026 estimated shares for this booth
            # Blend: 40% based on 2021 adjusted + 60% based on 2024 trends
            if total_24 > 0:
                # 2024 MP shares (strong recent signal)
                mp_udf = u24 / total_24
                mp_ldf = l24 / total_24
                mp_nda = n24 / total_24

                # 2021 assembly shares (base)
                asm_udf = u21 / total_21
                asm_ldf = l21 / total_21
                # T20 votes split: 65% NDA, 25% UDF, 10% scattered
                t20_nda = t20_21 * 0.65 / total_21
                t20_udf = t20_21 * 0.25 / total_21
                asm_nda = (nda21 / total_21) + t20_nda
                asm_udf_adj = asm_udf + t20_udf
                asm_ldf_adj = asm_ldf * 0.85  # Anti-incumbency

                # Blend 2024 (60%) + adjusted 2021 (40%)
                est_udf = mp_udf * 0.55 + asm_udf_adj * 0.45
                est_ldf = mp_ldf * 0.55 + asm_ldf_adj * 0.45
                est_nda = mp_nda * 0.55 + asm_nda * 0.45
            else:
                # No 2024 data - use 2021 with T20 adjustment
                asm_udf = u21 / total_21
                asm_ldf = l21 / total_21
                t20_nda = t20_21 * 0.65 / total_21
                t20_udf = t20_21 * 0.25 / total_21
                est_udf = asm_udf + t20_udf
                est_ldf = asm_ldf * 0.85
                est_nda = (nda21 / total_21) + t20_nda

            # Normalize
            total_est = est_udf + est_ldf + est_nda
            if total_est > 0:
                booth_patterns[bno] = {
                    'udf_share': est_udf / total_est,
                    'ldf_share': est_ldf / total_est,
                    'nda_share': est_nda / total_est,
                    'location': b.get('Location', ''),
                    'zone': b.get('Zone', ''),
                    'type': b.get('Type', ''),
                    'verdict': b.get('Verdict_2026', ''),
                }

    # Map parts to booths (approximate: distribute parts across booths)
    # ratio ≈ 240/157 ≈ 1.53 parts per booth
    part_to_booth = {}
    if num_booths > 0:
        ratio = num_parts / num_booths
        sorted_parts = sorted(sir_parts.keys())
        for i, pno in enumerate(sorted_parts):
            booth_idx = min(int(i / ratio) + 1, num_booths)
            part_to_booth[pno] = booth_idx

    # Generate estimates
    output = []
    for pno in sorted(sir_parts.keys()):
        p = sir_parts[pno]
        registered = p['sir_total']
        est_polled = round(registered * TURNOUT)

        # Get booth-specific pattern if available
        mapped_booth = part_to_booth.get(pno, 0)
        bp = booth_patterns.get(mapped_booth, None)

        if bp:
            udf_votes = round(est_polled * bp['udf_share'])
            ldf_votes = round(est_polled * bp['ldf_share'])
            nda_votes = round(est_polled * bp['nda_share'])
            location = bp['location']
            zone = bp['zone']
            booth_type = bp['type']
            verdict = bp['verdict']
            est_method = 'booth_pattern'
        else:
            # Use constituency-level adjusted shares
            udf_votes = round(est_polled * adj['UDF'] / 100)
            ldf_votes = round(est_polled * adj['LDF'] / 100)
            nda_votes = round(est_polled * adj['NDA'] / 100)
            location = ''
            zone = ''
            booth_type = ''
            verdict = ''
            est_method = 'constituency_avg'

        # Determine predicted winner for this part
        if udf_votes >= ldf_votes and udf_votes >= nda_votes:
            winner = 'UDF'
        elif ldf_votes >= nda_votes:
            winner = 'LDF'
        else:
            winner = 'NDA'

        margin = max(udf_votes, ldf_votes, nda_votes) - sorted([udf_votes, ldf_votes, nda_votes])[-2]

        output.append({
            'Part_No': pno,
            'Mapped_Booth': mapped_booth,
            'Location': location,
            'Zone': zone,
            'Booth_Type': booth_type,
            'Registered_Voters': registered,
            'SIR_Corrected': 'Y' if p['sir_corrected'] else '',
            'Est_Polled': est_polled,
            'Est_UDF': udf_votes,
            'Est_LDF': ldf_votes,
            'Est_NDA': nda_votes,
            'Est_Winner': winner,
            'Est_Margin': margin,
            'Verdict_2026': verdict,
            'Est_Method': est_method,
        })

    # Save CSV
    out_dir = f'data/constituencies/{constituency_key}'
    csv_path = os.path.join(out_dir, 'estimated_booth_votes.csv')
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=output[0].keys())
        writer.writeheader()
        writer.writerows(output)

    # Print summary
    total_udf = sum(r['Est_UDF'] for r in output)
    total_ldf = sum(r['Est_LDF'] for r in output)
    total_nda = sum(r['Est_NDA'] for r in output)
    udf_wins = sum(1 for r in output if r['Est_Winner'] == 'UDF')
    ldf_wins = sum(1 for r in output if r['Est_Winner'] == 'LDF')
    nda_wins = sum(1 for r in output if r['Est_Winner'] == 'NDA')

    print(f"{'=' * 70}")
    print(f"  BOOTH-WISE VOTE ESTIMATES - {constituency_key.upper()}")
    print(f"{'=' * 70}")
    print(f"  Total parts: {len(output)}")
    print(f"  Registered voters: {total_sir_corrected:,}")
    print(f"  Est. turnout: {TURNOUT:.0%}")
    print(f"  Est. polled: {round(total_sir_corrected * TURNOUT):,}")
    print()
    print(f"  {'Front':<6} {'Est. Votes':>12} {'Parts Won':>10}")
    print(f"  {'-'*6} {'-'*12} {'-'*10}")
    print(f"  {'UDF':<6} {total_udf:>12,} {udf_wins:>10}")
    print(f"  {'LDF':<6} {total_ldf:>12,} {ldf_wins:>10}")
    print(f"  {'NDA':<6} {total_nda:>12,} {nda_wins:>10}")
    print(f"\n  Est. margin: {total_udf - total_ldf:,} (UDF over LDF)")
    print(f"\n  Saved: {csv_path}")

    # Also print top battleground parts
    close = sorted([r for r in output if r['Est_Margin'] < 30], key=lambda x: x['Est_Margin'])
    if close:
        print(f"\n  TIGHTEST PARTS (margin < 30 votes):")
        for r in close[:15]:
            print(f"    Part {r['Part_No']:>3} (Booth {r['Mapped_Booth']:>3}): "
                  f"UDF={r['Est_UDF']} LDF={r['Est_LDF']} NDA={r['Est_NDA']} "
                  f"→ {r['Est_Winner']} by {r['Est_Margin']} | {r['Location']}")

    print(f"{'=' * 70}")
    return output


CONSTITUENCIES = {
    'kochi': True,
    'kalamassery': True,
}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Estimate per-booth votes')
    parser.add_argument('--constituency', required=True)
    args = parser.parse_args()
    estimate_booth_votes(args.constituency.lower())
