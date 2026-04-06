#!/usr/bin/env python3
"""
Monte Carlo Election Simulator for Kerala 2026 Assembly Elections.

Methodology:
1. Base vote share from 2021 assembly election (front-wise)
2. Apply swing adjustment from LSG 2020→2025 results (district-level)
3. Apply dampening factor (LSG swing != assembly swing; historically ~40-60%)
4. Model each front's vote share as a Normal distribution
5. Run N simulations, determine winner in each
6. Output: win probability per front per constituency
"""
import csv
import json
import random
import math
import os

random.seed(42)

# --- Configuration ---
NUM_SIMULATIONS = 1000000
SWING_DAMPENING = 0.45  # LSG swing translates to ~45% of that in assembly elections
VOLATILITY_BASE = 4.0   # Base standard deviation in vote share points
VOLATILITY_MARGIN_FACTOR = 0.03  # Add volatility for close seats

# --- District mapping for constituencies ---
DISTRICT_MAP = {}
with open('data/candidates_2026.csv', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        DISTRICT_MAP[int(row['Constituency_No'])] = row['District']

# --- Load 2021 results ---
results_2021 = {}
with open('data/election_2021_results.csv', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        cno = int(row['Constituency_No'])
        results_2021[cno] = {
            'name': row['Constituency'],
            'ldf_vs': float(row['LDF_VoteShare']),
            'udf_vs': float(row['UDF_VoteShare']),
            'nda_vs': float(row['NDA_VoteShare']),
            'winner_front': row['Winner_Front'],
            'margin': int(row['Margin']),
            'total_votes': int(row['Total_Votes']),
        }

# --- Load 2016 results for historical volatility ---
# Map constituency names to front vote shares
results_2016 = {}
LDF_2016 = {'CPM', 'CPI', 'JD(S)', 'NCP', 'RSP', 'INL', 'CMPKSC', 'KEC(B)', 'Congress(S)', 'NSC'}
UDF_2016 = {'INC', 'IUML', 'KEC(M)', 'KEC(J)', 'JD(U)', 'KEC'}
NDA_2016 = {'BJP'}

with open('data/election_2016_results.csv', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        cno = int(row['Constituency_No'])
        w_party = row['Winner_Party']
        r_party = row['Runner_Up_Party']
        w_votes = int(row['Winner_Votes'])
        r_votes = int(row['Runner_Up_Votes'])

        # Approximate front-wise vote share from winner/runner-up
        # This is rough but gives us a sense of 2016→2021 swing per constituency
        results_2016[cno] = {
            'name': row['Constituency'],
            'winner_party': w_party,
            'runner_up_party': r_party,
            'margin': int(row['Margin']),
        }

# --- Load LSG swing data ---
lsg_swing = {}
with open('data/lsg_district_swing.csv', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        lsg_swing[row['District']] = {
            'ldf': float(row['LDF_Swing']),
            'udf': float(row['UDF_Swing']),
            'nda': float(row['NDA_Swing']),
        }

# --- Load 2026 candidates ---
candidates_2026 = {}
with open('data/candidates_2026.csv', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        candidates_2026[int(row['Constituency_No'])] = row

# --- Compute adjusted vote shares and run simulation ---
output = []

for cno in range(1, 141):
    r21 = results_2021.get(cno)
    if not r21:
        continue

    district = DISTRICT_MAP.get(cno, '')
    swing = lsg_swing.get(district, {'ldf': 0, 'udf': 0, 'nda': 0})
    cand = candidates_2026.get(cno, {})

    # Base vote shares from 2021
    base_ldf = r21['ldf_vs']
    base_udf = r21['udf_vs']
    base_nda = r21['nda_vs']
    base_oth = 100 - base_ldf - base_udf - base_nda

    # Apply dampened LSG swing
    adj_ldf = base_ldf + swing['ldf'] * SWING_DAMPENING
    adj_udf = base_udf + swing['udf'] * SWING_DAMPENING
    adj_nda = base_nda + swing['nda'] * SWING_DAMPENING

    # Ensure non-negative and normalize to ~100%
    adj_ldf = max(adj_ldf, 2)
    adj_udf = max(adj_udf, 2)
    adj_nda = max(adj_nda, 2)
    total_adj = adj_ldf + adj_udf + adj_nda + base_oth
    adj_ldf = adj_ldf / total_adj * 100
    adj_udf = adj_udf / total_adj * 100
    adj_nda = adj_nda / total_adj * 100

    # Historical volatility: seats that were close in 2021 have higher uncertainty
    margin_pct = r21['margin'] / r21['total_votes'] * 100
    volatility = VOLATILITY_BASE + VOLATILITY_MARGIN_FACTOR * (30 - min(margin_pct, 30))

    # Check 2016 swing for additional volatility info
    r16 = results_2016.get(cno)
    if r16:
        # If the seat changed hands between 2016 and 2021, it's more volatile
        if r16['winner_party'] in UDF_2016 and r21['winner_front'] == 'LDF':
            volatility += 1.0
        elif r16['winner_party'] in LDF_2016 and r21['winner_front'] == 'UDF':
            volatility += 1.0

    # --- Monte Carlo Simulation ---
    wins = {'LDF': 0, 'UDF': 0, 'NDA': 0}

    for _ in range(NUM_SIMULATIONS):
        # Sample vote shares from normal distributions
        sim_ldf = random.gauss(adj_ldf, volatility)
        sim_udf = random.gauss(adj_udf, volatility)
        sim_nda = random.gauss(adj_nda, volatility * 0.7)  # NDA typically less volatile

        # Determine winner
        if sim_ldf >= sim_udf and sim_ldf >= sim_nda:
            wins['LDF'] += 1
        elif sim_udf >= sim_ldf and sim_udf >= sim_nda:
            wins['UDF'] += 1
        else:
            wins['NDA'] += 1

    ldf_prob = wins['LDF'] / NUM_SIMULATIONS * 100
    udf_prob = wins['UDF'] / NUM_SIMULATIONS * 100
    nda_prob = wins['NDA'] / NUM_SIMULATIONS * 100

    # Classification
    max_prob = max(ldf_prob, udf_prob, nda_prob)
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

    output.append({
        'Constituency_No': cno,
        'Constituency': r21['name'],
        'District': district,
        'LDF_Candidate': cand.get('LDF_Candidate', ''),
        'LDF_Party': cand.get('LDF_Party', ''),
        'UDF_Candidate': cand.get('UDF_Candidate', ''),
        'UDF_Party': cand.get('UDF_Party', ''),
        'NDA_Candidate': cand.get('NDA_Candidate', ''),
        'NDA_Party': cand.get('NDA_Party', ''),
        'Base_LDF': round(base_ldf, 2),
        'Base_UDF': round(base_udf, 2),
        'Base_NDA': round(base_nda, 2),
        'Adjusted_LDF': round(adj_ldf, 2),
        'Adjusted_UDF': round(adj_udf, 2),
        'Adjusted_NDA': round(adj_nda, 2),
        'LDF_Win_Prob': round(ldf_prob, 2),
        'UDF_Win_Prob': round(udf_prob, 2),
        'NDA_Win_Prob': round(nda_prob, 2),
        'Category': category,
        'Margin_2021': r21['margin'],
        'Winner_2021': r21['winner_front'],
        'Volatility': round(volatility, 2),
    })

# --- Write CSV output ---
with open('data/predictions_2026.csv', 'w', newline='', encoding='utf-8') as f:
    writer = csv.DictWriter(f, fieldnames=output[0].keys())
    writer.writeheader()
    writer.writerows(output)

# --- Write JSON for web app ---
with open('data/predictions_2026.json', 'w', encoding='utf-8') as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

# --- Aggregate seat projections ---
# Run aggregate simulation
aggregate_sims = 10000
seat_counts = {'LDF': [], 'UDF': [], 'NDA': []}

for sim in range(aggregate_sims):
    seats = {'LDF': 0, 'UDF': 0, 'NDA': 0}
    for o in output:
        r = random.random() * 100
        if r < o['LDF_Win_Prob']:
            seats['LDF'] += 1
        elif r < o['LDF_Win_Prob'] + o['UDF_Win_Prob']:
            seats['UDF'] += 1
        else:
            seats['NDA'] += 1
    for front in seats:
        seat_counts[front].append(seats[front])

# Compute stats
def percentile(data, p):
    data_sorted = sorted(data)
    idx = int(len(data_sorted) * p / 100)
    return data_sorted[min(idx, len(data_sorted) - 1)]

summary = {}
for front in ['LDF', 'UDF', 'NDA']:
    vals = seat_counts[front]
    summary[front] = {
        'mean': round(sum(vals) / len(vals), 1),
        'median': percentile(vals, 50),
        'p5': percentile(vals, 5),
        'p25': percentile(vals, 25),
        'p75': percentile(vals, 75),
        'p95': percentile(vals, 95),
        'min': min(vals),
        'max': max(vals),
    }

# Count category distribution
categories = {}
for o in output:
    cat = o['Category']
    categories[cat] = categories.get(cat, 0) + 1

# Print summary
print("=" * 60)
print("  KERALA 2026 ASSEMBLY ELECTION - MONTE CARLO PREDICTION")
print("=" * 60)
print(f"  Simulations: {NUM_SIMULATIONS:,} per constituency, {aggregate_sims:,} aggregate")
print(f"  Swing dampening: {SWING_DAMPENING:.0%} of LSG swing")
print()
print("  SEAT PROJECTIONS (Median [5th - 95th percentile])")
print("  " + "-" * 50)
for front in ['LDF', 'UDF', 'NDA']:
    s = summary[front]
    print(f"  {front}: {s['median']:>3} seats  [{s['p5']:>3} - {s['p95']:>3}]  (mean: {s['mean']})")
print()
print("  CONSTITUENCY CATEGORIES")
print("  " + "-" * 50)
for cat, count in sorted(categories.items(), key=lambda x: -x[1]):
    print(f"  {cat:<20}: {count}")
print()

# Save summary
summary_data = {
    'seat_projections': summary,
    'categories': categories,
    'config': {
        'num_simulations': NUM_SIMULATIONS,
        'swing_dampening': SWING_DAMPENING,
        'volatility_base': VOLATILITY_BASE,
    },
    'seat_distributions': seat_counts,
}
with open('data/summary_2026.json', 'w', encoding='utf-8') as f:
    json.dump(summary_data, f, ensure_ascii=False, indent=2)

print("  Output files:")
print("    data/predictions_2026.csv")
print("    data/predictions_2026.json")
print("    data/summary_2026.json")
