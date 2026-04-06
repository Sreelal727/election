#!/usr/bin/env python3
"""Process raw 2021 Kerala election data into clean constituency-level results."""
import csv
import os

INPUT_FILE = os.path.join(os.path.dirname(__file__), '..', 'data', 'election_data_kerala_2021.csv')
TRENDS_FILE = os.path.join(os.path.dirname(__file__), '..', 'data', 'election_data_trends_2021.csv')
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), '..', 'data', 'election_2021_results.csv')

# Map full party names to short codes
PARTY_MAP = {
    'Communist Party of India  (Marxist)': 'CPM',
    'Communist Party of India (Marxist)': 'CPM',
    'Communist Party of India': 'CPI',
    'Indian National Congress': 'INC',
    'Indian Union Muslim League': 'IUML',
    'Bharatiya Janata Party': 'BJP',
    'Janata Dal  (Secular)': 'JD(S)',
    'Janata Dal (Secular)': 'JD(S)',
    'Janata Dal  (United)': 'JD(U)',
    'Kerala Congress  (M)': 'KEC(M)',
    'Kerala Congress (M)': 'KEC(M)',
    'Kerala Congress': 'KEC',
    'Kerala Congress (B)': 'KEC(B)',
    'Kerala Congress  (Jacob)': 'KEC(J)',
    'Kerala Congress (Jacob)': 'KEC(J)',
    'Nationalist Congress Party': 'NCP',
    'Revolutionary Socialist Party': 'RSP',
    'Indian National League': 'INL',
    'Loktantrik Janta Dal': 'LJD',
    'Janadhipathiya Kerala Congress': 'JKC',
    'Communist Marxist Party Kerala State Committee': 'CMPK',
    'Congress  (Secular)': 'Congress(S)',
    'National Secular Conference': 'NSC',
    'Rashtriya Janata Dal': 'RJD',
    'Bharath Dharma Jana Sena': 'BDJS',
    'Kerala Janapaksham (Secular),': 'KJP(S)',
    'Revolutionary Marxist Party of India': 'RMPI',
    'Independent': 'IND',
    'None of the Above': 'NOTA',
}

# LDF-backed independents in 2021 (constituency -> True)
LDF_INDEPENDENTS_2021 = {
    'Kunnamangalam', 'Koduvally', 'Nilambur', 'Thavanur', 'Chavara', 'Kunnathur', 'Pala',
}

# Front mapping - 2021 alliance composition
LDF_PARTIES = {'CPM', 'CPI', 'JD(S)', 'NCP', 'RSP', 'INL', 'LJD', 'CMPK', 'KEC(B)', 'KEC(M)', 'Congress(S)', 'NSC', 'RJD'}
UDF_PARTIES = {'INC', 'IUML', 'KEC', 'KEC(J)', 'JKC', 'JD(U)', 'RMPI'}
NDA_PARTIES = {'BJP', 'BDJS', 'KJP(S)'}

def get_front(party_short, constituency=None):
    if party_short in LDF_PARTIES:
        return 'LDF'
    elif party_short in UDF_PARTIES:
        return 'UDF'
    elif party_short in NDA_PARTIES:
        return 'NDA'
    elif party_short == 'IND' and constituency and constituency in LDF_INDEPENDENTS_2021:
        return 'LDF'
    return 'OTH'

def short_party(full_name):
    return PARTY_MAP.get(full_name.strip(), full_name.strip()[:10])

# Read trends file for constituency numbers
const_numbers = {}
with open(TRENDS_FILE, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f)
    for row in reader:
        name = row['Constituency'].strip().upper()
        const_numbers[name] = int(row['Constituency No'])

# Read and group candidates by constituency
constituencies = {}
current_const = None
with open(INPUT_FILE, 'r', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f)
    for row in reader:
        const = row['State']  # State column has constituency continuation
        if row['Constituency'].strip():
            current_const = row['Constituency'].strip()
        if current_const not in constituencies:
            constituencies[current_const] = []

        name = row['Candidates__Name'].strip()
        if name == 'NOTA':
            continue

        party_full = row['Candidates__Party'].strip()
        total_votes = int(row['Candidates__Total Votes'].strip()) if row['Candidates__Total Votes'].strip() else 0

        constituencies[current_const].append({
            'name': name,
            'party_full': party_full,
            'party': short_party(party_full),
            'votes': total_votes,
        })

# Process each constituency
results = []
for const_name, candidates in constituencies.items():
    # Sort by votes descending
    candidates.sort(key=lambda x: x['votes'], reverse=True)

    if len(candidates) < 2:
        continue

    winner = candidates[0]
    runner_up = candidates[1]

    # Calculate front-wise vote totals
    front_votes = {'LDF': 0, 'UDF': 0, 'NDA': 0, 'OTH': 0}
    total_votes = 0
    for c in candidates:
        front = get_front(c['party'], const_name)
        front_votes[front] += c['votes']
        total_votes += c['votes']

    const_upper = const_name.upper().strip()
    const_no = const_numbers.get(const_upper, 0)

    results.append({
        'Constituency_No': const_no,
        'Constituency': const_name,
        'Winner': winner['name'],
        'Winner_Party': winner['party'],
        'Winner_Front': get_front(winner['party'], const_name),
        'Winner_Votes': winner['votes'],
        'Runner_Up': runner_up['name'],
        'Runner_Up_Party': runner_up['party'],
        'Runner_Up_Front': get_front(runner_up['party'], const_name),
        'Runner_Up_Votes': runner_up['votes'],
        'Margin': winner['votes'] - runner_up['votes'],
        'Total_Votes': total_votes,
        'LDF_Votes': front_votes['LDF'],
        'UDF_Votes': front_votes['UDF'],
        'NDA_Votes': front_votes['NDA'],
        'LDF_VoteShare': round(front_votes['LDF'] / total_votes * 100, 2) if total_votes else 0,
        'UDF_VoteShare': round(front_votes['UDF'] / total_votes * 100, 2) if total_votes else 0,
        'NDA_VoteShare': round(front_votes['NDA'] / total_votes * 100, 2) if total_votes else 0,
    })

# Sort by constituency number
results.sort(key=lambda x: x['Constituency_No'])

# Write output
fieldnames = list(results[0].keys())
with open(OUTPUT_FILE, 'w', newline='', encoding='utf-8') as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(results)

print(f"Processed {len(results)} constituencies")
print(f"Output: {OUTPUT_FILE}")

# Summary
ldf_wins = sum(1 for r in results if r['Winner_Front'] == 'LDF')
udf_wins = sum(1 for r in results if r['Winner_Front'] == 'UDF')
nda_wins = sum(1 for r in results if r['Winner_Front'] == 'NDA')
oth_wins = sum(1 for r in results if r['Winner_Front'] == 'OTH')
print(f"\nLDF: {ldf_wins}, UDF: {udf_wins}, NDA: {nda_wins}, Others: {oth_wins}")
