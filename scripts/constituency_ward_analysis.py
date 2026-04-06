#!/usr/bin/env python3
"""
Constituency-Level Ward Analysis for Kerala 2026 Predictions.

Goes deeper than district-level swing by computing ward-wise
LSG swing within a specific constituency's local bodies.
This gives a much more granular picture than the district average.

Usage:
    python scripts/constituency_ward_analysis.py --constituency kalamassery
"""
import csv
import json
import argparse
import os
from collections import defaultdict

# Local bodies that fall within Kalamassery Assembly Constituency
# Kalamassery constituency covers: Kalamassery Municipality + parts of nearby panchayats
CONSTITUENCY_LOCAL_BODIES = {
    'kalamassery': {
        'district': 'Ernakulam',
        'constituency_no': 77,
        'local_bodies': {
            'municipality': ['Kalamassery'],
            'grama_panchayat': ['Thrikkakara', 'Cheranalloor', 'Kadungalloor'],
            'block_panchayat': ['Aluva'],
        },
        'description': 'Kalamassery Assembly Constituency - Ernakulam District',
    },
    'kochi': {
        'district': 'Ernakulam',
        'constituency_no': 80,
        'local_bodies': {
            'corporation': ['Kochi'],
            'grama_panchayat': ['Chellanam', 'Kumbalanghy', 'Mulavukadu'],
            'block_panchayat': ['Palluruthy'],
        },
        'description': 'Kochi Assembly Constituency - Ernakulam District',
    },
}


def load_lsg_data(filepath, target_district, target_bodies):
    """Load LSG data filtered by district and local body names."""
    data = []
    all_body_names = set()
    for bodies in target_bodies.values():
        all_body_names.update(b.lower() for b in bodies)

    with open(filepath, encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row['District'] != target_district:
                continue
            body_name = row['Local Body'].strip()
            if body_name.lower() in all_body_names:
                data.append(row)
    return data


def compute_ward_results(ward_rows):
    """Given all candidate rows for a ward, compute front-wise vote shares."""
    front_votes = defaultdict(int)
    total_votes = 0
    for row in ward_rows:
        votes = int(row['Votes'])
        front = row['Front']
        front_votes[front] += votes
        total_votes += votes

    if total_votes == 0:
        return None

    return {
        'total_votes': total_votes,
        'LDF': front_votes.get('LDF', 0),
        'UDF': front_votes.get('UDF', 0),
        'NDA': front_votes.get('NDA', 0),
        'OTH': front_votes.get('OTH', 0),
        'LDF_share': round(front_votes.get('LDF', 0) / total_votes * 100, 2),
        'UDF_share': round(front_votes.get('UDF', 0) / total_votes * 100, 2),
        'NDA_share': round(front_votes.get('NDA', 0) / total_votes * 100, 2),
        'OTH_share': round(front_votes.get('OTH', 0) / total_votes * 100, 2),
    }


def analyze_constituency(constituency_key):
    """Run full ward-level analysis for a constituency."""
    config = CONSTITUENCY_LOCAL_BODIES[constituency_key]
    district = config['district']
    local_bodies = config['local_bodies']
    cno = config['constituency_no']

    print(f"{'=' * 70}")
    print(f"  DEEP WARD-LEVEL ANALYSIS: {config['description']}")
    print(f"{'=' * 70}")

    # Load both years
    data_2020 = load_lsg_data('data/lsg_2020.csv', district, local_bodies)
    data_2025 = load_lsg_data('data/lsg_2025.csv', district, local_bodies)

    print(f"\n  Records loaded: 2020={len(data_2020)}, 2025={len(data_2025)}")

    # Group by local body → ward
    def group_by_ward(data):
        grouped = defaultdict(lambda: defaultdict(list))
        for row in data:
            body = row['Local Body']
            ward = row['Ward Name']
            grouped[body][ward].append(row)
        return grouped

    wards_2020 = group_by_ward(data_2020)
    wards_2025 = group_by_ward(data_2025)

    # Compute ward-level results for each year
    results_by_body = {}

    for year_label, wards_grouped in [('2020', wards_2020), ('2025', wards_2025)]:
        for body_name, wards in wards_grouped.items():
            if body_name not in results_by_body:
                results_by_body[body_name] = {'2020': {}, '2025': {}}
            for ward_name, ward_rows in wards.items():
                result = compute_ward_results(ward_rows)
                if result:
                    results_by_body[body_name][year_label][ward_name] = result

    # Compute aggregate swing per local body
    body_swings = {}
    all_ward_details = []

    for body_name, years in results_by_body.items():
        print(f"\n  --- {body_name} ---")

        # Aggregate vote shares for each year
        for year in ['2020', '2025']:
            total = sum(w['total_votes'] for w in years[year].values())
            ldf = sum(w['LDF'] for w in years[year].values())
            udf = sum(w['UDF'] for w in years[year].values())
            nda = sum(w['NDA'] for w in years[year].values())

            if total > 0:
                print(f"  {year}: LDF={ldf/total*100:.1f}% UDF={udf/total*100:.1f}% "
                      f"NDA={nda/total*100:.1f}% ({len(years[year])} wards, {total:,} votes)")

        # Compute swing
        if years['2020'] and years['2025']:
            totals = {}
            for year in ['2020', '2025']:
                t = sum(w['total_votes'] for w in years[year].values())
                totals[year] = {
                    'LDF': sum(w['LDF'] for w in years[year].values()) / t * 100 if t else 0,
                    'UDF': sum(w['UDF'] for w in years[year].values()) / t * 100 if t else 0,
                    'NDA': sum(w['NDA'] for w in years[year].values()) / t * 100 if t else 0,
                    'total_votes': t,
                }

            swing = {
                'LDF': round(totals['2025']['LDF'] - totals['2020']['LDF'], 2),
                'UDF': round(totals['2025']['UDF'] - totals['2020']['UDF'], 2),
                'NDA': round(totals['2025']['NDA'] - totals['2020']['NDA'], 2),
                'weight': totals['2025']['total_votes'],  # weight by voter count
            }
            body_swings[body_name] = swing
            print(f"  SWING: LDF={swing['LDF']:+.1f}% UDF={swing['UDF']:+.1f}% NDA={swing['NDA']:+.1f}%")

        # Ward-level details for export
        for ward_name, w25 in years['2025'].items():
            w20 = years['2020'].get(ward_name, None)
            detail = {
                'local_body': body_name,
                'ward': ward_name,
                'votes_2025': w25['total_votes'],
                'LDF_share_2025': w25['LDF_share'],
                'UDF_share_2025': w25['UDF_share'],
                'NDA_share_2025': w25['NDA_share'],
                'winner_2025': max(['LDF', 'UDF', 'NDA'], key=lambda f: w25[f]),
            }
            if w20:
                detail['LDF_swing'] = round(w25['LDF_share'] - w20['LDF_share'], 2)
                detail['UDF_swing'] = round(w25['UDF_share'] - w20['UDF_share'], 2)
                detail['NDA_swing'] = round(w25['NDA_share'] - w20['NDA_share'], 2)
            all_ward_details.append(detail)

    # Compute weighted constituency-level swing from local bodies
    total_weight = sum(s['weight'] for s in body_swings.values())
    if total_weight > 0:
        constituency_swing = {
            'LDF': round(sum(s['LDF'] * s['weight'] for s in body_swings.values()) / total_weight, 2),
            'UDF': round(sum(s['UDF'] * s['weight'] for s in body_swings.values()) / total_weight, 2),
            'NDA': round(sum(s['NDA'] * s['weight'] for s in body_swings.values()) / total_weight, 2),
        }
    else:
        constituency_swing = {'LDF': 0, 'UDF': 0, 'NDA': 0}

    print(f"\n{'=' * 70}")
    print(f"  CONSTITUENCY-LEVEL WEIGHTED SWING (from {len(body_swings)} local bodies)")
    print(f"  LDF: {constituency_swing['LDF']:+.2f}%")
    print(f"  UDF: {constituency_swing['UDF']:+.2f}%")
    print(f"  NDA: {constituency_swing['NDA']:+.2f}%")
    print(f"  (vs District-level Ernakulam swing used in current model)")
    print(f"{'=' * 70}")

    # Compute ward-level stats
    ldf_wards = sum(1 for w in all_ward_details if w['winner_2025'] == 'LDF')
    udf_wards = sum(1 for w in all_ward_details if w['winner_2025'] == 'UDF')
    nda_wards = sum(1 for w in all_ward_details if w['winner_2025'] == 'NDA')
    print(f"\n  Ward winners (2025): LDF={ldf_wards} UDF={udf_wards} NDA={nda_wards}")

    # Save outputs
    out_dir = f'data/constituencies/{constituency_key}'
    os.makedirs(out_dir, exist_ok=True)

    ward_csv_path = os.path.join(out_dir, 'ward_analysis.csv')
    if all_ward_details:
        # Collect all possible fields across all rows
        all_fields = []
        seen = set()
        for row in all_ward_details:
            for key in row:
                if key not in seen:
                    all_fields.append(key)
                    seen.add(key)
        with open(ward_csv_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=all_fields, extrasaction='ignore')
            writer.writeheader()
            writer.writerows(all_ward_details)
        print(f"\n  Ward details saved: {ward_csv_path}")

    swing_path = os.path.join(out_dir, 'constituency_swing.json')
    swing_output = {
        'constituency_no': cno,
        'constituency': config['description'],
        'district': district,
        'local_body_swings': body_swings,
        'weighted_constituency_swing': constituency_swing,
        'ward_count_2025': len(all_ward_details),
        'ward_winners_2025': {'LDF': ldf_wards, 'UDF': udf_wards, 'NDA': nda_wards},
        'total_voters_2025': total_weight,
    }
    with open(swing_path, 'w', encoding='utf-8') as f:
        json.dump(swing_output, f, ensure_ascii=False, indent=2)
    print(f"  Swing data saved: {swing_path}")

    return swing_output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Constituency ward-level LSG analysis')
    parser.add_argument('--constituency', default='kalamassery',
                        choices=list(CONSTITUENCY_LOCAL_BODIES.keys()),
                        help='Constituency to analyze')
    args = parser.parse_args()
    analyze_constituency(args.constituency)
