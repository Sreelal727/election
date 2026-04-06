#!/usr/bin/env python3
"""Parse 2026 Kerala election candidate data from Wikipedia API."""
import json
import csv
import re
import sys
import urllib.request

with open('/tmp/wiki_2026.json') as f:
    data = json.load(f)

text = data['parse']['wikitext']['*']
lines = text.split('\n')

# Find the constituency table
# Pattern: ! <num> \n | [[Constituency]] \n | LDF party \n | LDF candidate \n | UDF party \n | UDF candidate \n | NDA party \n | NDA candidate
constituencies = []
i = 0
current_district = ""
while i < len(lines):
    line = lines[i].strip()

    # Detect district
    if 'rowspan' in line and 'district' in line.lower():
        m = re.search(r'\[\[([^|]+?)(?:\|([^]]+))?\]\]', line)
        if m:
            current_district = m.group(2) if m.group(2) else m.group(1)
            current_district = current_district.replace(' district', '').strip()

    # Detect constituency number
    if re.match(r'^!\s*\d+\s*$', line):
        const_no = int(line.replace('!', '').strip())

        # Next line should be constituency name
        if i + 1 < len(lines):
            const_line = lines[i + 1].strip()
            m = re.search(r'\[\[([^|]+?)(?:\|([^]]+))?\]\]', const_line)
            const_name = ""
            if m:
                const_name = m.group(2) if m.group(2) else m.group(1)
                const_name = re.sub(r'\s*\(.*?\)', '', const_name).strip()
                const_name = const_name.replace('<nowiki/>', '').strip()

            # Parse next 6 lines: LDF party, LDF candidate, UDF party, UDF candidate, NDA party, NDA candidate
            ldf_party = ""
            ldf_candidate = ""
            udf_party = ""
            udf_candidate = ""
            nda_party = ""
            nda_candidate = ""

            j = i + 2
            fields = []
            while j < min(i + 20, len(lines)) and len(fields) < 6:
                l = lines[j].strip()
                if l.startswith('|-') or l.startswith('|}') or re.match(r'^!\s*\d+\s*$', l):
                    break
                if l.startswith('|') or l.startswith('!'):
                    # Extract party name
                    party_match = re.search(r'Party name with color\|([^}]+)\}', l)
                    # Extract candidate name
                    candidate_match = re.search(r'\[\[([^|]+?)(?:\|([^]]+))?\]\]', l)
                    plain_text = re.sub(r'\{\{[^}]*\}\}', '', l)
                    plain_text = re.sub(r'\[\[([^|]*?\|)?([^]]*)\]\]', r'\2', plain_text)
                    plain_text = re.sub(r'[|!]', '', plain_text).strip()

                    if party_match:
                        fields.append(('party', party_match.group(1).strip()))
                    elif candidate_match:
                        name = candidate_match.group(2) if candidate_match.group(2) else candidate_match.group(1)
                        name = re.sub(r'\s*\([^)]*\)', '', name).strip()
                        fields.append(('candidate', name))
                    elif plain_text and not plain_text.startswith('{'):
                        # Could be a candidate without wiki link
                        clean = re.sub(r'<[^>]*>', '', plain_text).strip()
                        if clean and len(clean) > 1:
                            fields.append(('candidate', clean))
                j += 1

            # Assign fields to fronts
            parties = []
            candidates = []
            for ftype, fval in fields:
                if ftype == 'party':
                    parties.append(fval)
                elif ftype == 'candidate':
                    candidates.append(fval)

            # Map parties to short codes
            def short_party(p):
                p = p.lower()
                if 'marxist' in p and 'communist' in p:
                    return 'CPM'
                if 'communist party of india' in p:
                    return 'CPI'
                if 'indian national congress' in p:
                    return 'INC'
                if 'muslim league' in p:
                    return 'IUML'
                if 'bharatiya janata' in p:
                    return 'BJP'
                if 'janata dal' in p and 'secular' in p:
                    return 'JD(S)'
                if 'kerala congress' in p and '(m)' in p:
                    return 'KC(M)'
                if 'nationalist congress' in p:
                    return 'NCP'
                if 'revolutionary socialist' in p:
                    return 'RSP'
                return p[:15]

            # Usually: LDF party, UDF party, NDA party followed by candidates
            # or interleaved: party, candidate, party, candidate, party, candidate
            if len(parties) >= 3 and len(candidates) >= 3:
                ldf_party = short_party(parties[0])
                udf_party = short_party(parties[1])
                nda_party = short_party(parties[2])
                ldf_candidate = candidates[0]
                udf_candidate = candidates[1]
                nda_candidate = candidates[2]
            elif len(fields) >= 6:
                # Interleaved
                idx = 0
                fronts = ['LDF', 'UDF', 'NDA']
                front_data = {}
                current_party = None
                front_idx = 0
                for ftype, fval in fields:
                    if ftype == 'party':
                        current_party = short_party(fval)
                    elif ftype == 'candidate' and front_idx < 3:
                        front_data[fronts[front_idx]] = {
                            'party': current_party or '',
                            'candidate': fval
                        }
                        front_idx += 1
                        current_party = None

                ldf_party = front_data.get('LDF', {}).get('party', '')
                ldf_candidate = front_data.get('LDF', {}).get('candidate', '')
                udf_party = front_data.get('UDF', {}).get('party', '')
                udf_candidate = front_data.get('UDF', {}).get('candidate', '')
                nda_party = front_data.get('NDA', {}).get('party', '')
                nda_candidate = front_data.get('NDA', {}).get('candidate', '')

            constituencies.append({
                'Constituency_No': const_no,
                'Constituency': const_name,
                'District': current_district,
                'LDF_Candidate': ldf_candidate,
                'LDF_Party': ldf_party,
                'UDF_Candidate': udf_candidate,
                'UDF_Party': udf_party,
                'NDA_Candidate': nda_candidate,
                'NDA_Party': nda_party,
            })

    i += 1

# Sort by constituency number
constituencies.sort(key=lambda x: x['Constituency_No'])

# Write CSV
output_file = 'data/candidates_2026.csv'
with open(output_file, 'w', newline='', encoding='utf-8') as f:
    writer = csv.DictWriter(f, fieldnames=constituencies[0].keys())
    writer.writeheader()
    writer.writerows(constituencies)

print(f"Extracted {len(constituencies)} constituencies")
for c in constituencies[:5]:
    print(f"  {c['Constituency_No']}. {c['Constituency']}: LDF={c['LDF_Candidate']} ({c['LDF_Party']}), UDF={c['UDF_Candidate']} ({c['UDF_Party']}), NDA={c['NDA_Candidate']} ({c['NDA_Party']})")
print("...")
for c in constituencies[-3:]:
    print(f"  {c['Constituency_No']}. {c['Constituency']}: LDF={c['LDF_Candidate']} ({c['LDF_Party']}), UDF={c['UDF_Candidate']} ({c['UDF_Party']}), NDA={c['NDA_Candidate']} ({c['NDA_Party']})")
