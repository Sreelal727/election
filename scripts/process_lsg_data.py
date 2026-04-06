#!/usr/bin/env python3
"""Process LSG 2020 and 2025 data to compute district-wise front vote shares and swing."""
import csv
import os

def process_lsg(filepath):
    """Compute district-wise vote totals by front."""
    district_votes = {}
    with open(filepath, encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            dist = row['District']
            front = row['Front']
            votes = int(row['Votes']) if row['Votes'].strip() else 0

            if dist not in district_votes:
                district_votes[dist] = {'LDF': 0, 'UDF': 0, 'NDA': 0, 'OTH': 0, 'Total': 0}

            if front in district_votes[dist]:
                district_votes[dist][front] += votes
            else:
                district_votes[dist]['OTH'] += votes
            district_votes[dist]['Total'] += votes

    return district_votes


lsg_2020 = process_lsg('data/lsg_2020.csv')
lsg_2025 = process_lsg('data/lsg_2025.csv')

# Compute vote shares and swing
results = []
for dist in sorted(lsg_2025.keys()):
    d25 = lsg_2025[dist]
    d20 = lsg_2020.get(dist, {'LDF': 0, 'UDF': 0, 'NDA': 0, 'Total': 1})

    t25 = d25['Total'] or 1
    t20 = d20['Total'] or 1

    ldf_25 = d25['LDF'] / t25 * 100
    udf_25 = d25['UDF'] / t25 * 100
    nda_25 = d25['NDA'] / t25 * 100

    ldf_20 = d20['LDF'] / t20 * 100
    udf_20 = d20['UDF'] / t20 * 100
    nda_20 = d20['NDA'] / t20 * 100

    results.append({
        'District': dist,
        'LDF_2020': round(ldf_20, 2),
        'UDF_2020': round(udf_20, 2),
        'NDA_2020': round(nda_20, 2),
        'LDF_2025': round(ldf_25, 2),
        'UDF_2025': round(udf_25, 2),
        'NDA_2025': round(nda_25, 2),
        'LDF_Swing': round(ldf_25 - ldf_20, 2),
        'UDF_Swing': round(udf_25 - udf_20, 2),
        'NDA_Swing': round(nda_25 - nda_20, 2),
    })

# Write output
output_file = 'data/lsg_district_swing.csv'
with open(output_file, 'w', newline='', encoding='utf-8') as f:
    writer = csv.DictWriter(f, fieldnames=results[0].keys())
    writer.writeheader()
    writer.writerows(results)

print(f"District-wise LSG swing data saved to {output_file}")
print(f"\n{'District':<20} {'LDF_20':>7} {'UDF_20':>7} {'NDA_20':>7} | {'LDF_25':>7} {'UDF_25':>7} {'NDA_25':>7} | {'LDF_Sw':>7} {'UDF_Sw':>7} {'NDA_Sw':>7}")
print("-" * 110)
for r in results:
    print(f"{r['District']:<20} {r['LDF_2020']:>7} {r['UDF_2020']:>7} {r['NDA_2020']:>7} | {r['LDF_2025']:>7} {r['UDF_2025']:>7} {r['NDA_2025']:>7} | {r['LDF_Swing']:>7} {r['UDF_Swing']:>7} {r['NDA_Swing']:>7}")

# State-wide averages
avg_ldf_sw = sum(r['LDF_Swing'] for r in results) / len(results)
avg_udf_sw = sum(r['UDF_Swing'] for r in results) / len(results)
avg_nda_sw = sum(r['NDA_Swing'] for r in results) / len(results)
print(f"\nState avg swing: LDF={avg_ldf_sw:+.2f}, UDF={avg_udf_sw:+.2f}, NDA={avg_nda_sw:+.2f}")
