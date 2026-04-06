#!/usr/bin/env python3
"""
Extract voter counts from ECI SIR Electoral Roll PDFs (image-based).

These are scanned/image PDFs in Malayalam. Each PDF is one polling station part.
The first page has a summary table at the bottom with:
    Part_No | Serials | Male | Female | Third_Gender | Total

The last page also has a detailed summary table with the same data.

We OCR the FIRST page (which has the summary table) and extract the numbers.

Usage:
    pip3 install pdfplumber pytesseract pypdfium2
    python3 scripts/extract_sir_voters.py --folder /path/to/pdfs --constituency kochi
"""
import os
import re
import csv
import json
import argparse
import glob
import sys
from collections import defaultdict

import pypdfium2
import pytesseract
from PIL import Image


def extract_part_number(filename):
    """Extract part number from ECI PDF filename like ...-MAL-123-WI.pdf"""
    base = os.path.splitext(os.path.basename(filename))[0]
    # ECI format: ...-MAL-{PART_NO}-WI
    m = re.search(r'MAL[_\-](\d+)[_\-]', base)
    if m:
        return int(m.group(1))
    # Fallback: last number in filename
    nums = re.findall(r'(\d+)', base)
    if nums:
        return int(nums[-1])
    return 0


def extract_voters_from_pdf(filepath):
    """
    Extract voter count from a single ECI SIR electoral roll PDF.

    Strategy: OCR the first page which contains the summary table at bottom.
    The table has columns: Part | Serials | Male | Female | Third Gender | Total

    Returns dict with male, female, third_gender, total, method.
    """
    result = {
        'male': 0, 'female': 0, 'third_gender': 0, 'total': 0,
        'method': 'failed', 'part_name': ''
    }

    try:
        pdf = pypdfium2.PdfDocument(filepath)
        num_pages = len(pdf)

        # Strategy 1: OCR first page - has summary table at bottom
        page = pdf[0]
        bitmap = page.render(scale=3)  # High res for accurate OCR
        img = bitmap.to_pil()

        # Crop bottom 30% of first page where the summary table is
        w, h = img.size
        bottom_crop = img.crop((0, int(h * 0.65), w, h))

        text = pytesseract.image_to_string(bottom_crop, lang='eng', config='--psm 6')

        # Look for the voter count row: typically "1  502  221  275  0  496"
        # Pattern: a sequence of numbers at the end, we want the last 4 (M, F, TG, Total)
        lines = text.strip().split('\n')
        for line in lines:
            # Find lines with multiple numbers
            nums = re.findall(r'(\d+)', line)
            if len(nums) >= 4:
                # The pattern is: part_no, serials, male, female, third_gender, total
                # Or just: male, female, third_gender, total
                int_nums = [int(n) for n in nums]

                # Find the right set: total should be ~ male + female + third_gender
                # Try from the end
                for start in range(len(int_nums) - 4, -1, -1):
                    m, f, tg, t = int_nums[start:start+4]
                    if t > 0 and abs(t - (m + f + tg)) <= 2:  # Allow tiny rounding
                        result['male'] = m
                        result['female'] = f
                        result['third_gender'] = tg
                        result['total'] = t
                        result['method'] = 'page1_table'
                        break

                if result['total'] > 0:
                    break

        # Strategy 2: If page 1 failed, try last page (also has summary)
        if result['total'] == 0:
            for page_idx in range(num_pages - 1, max(num_pages - 4, -1), -1):
                page = pdf[page_idx]
                bitmap = page.render(scale=3)
                img = bitmap.to_pil()
                text = pytesseract.image_to_string(img, lang='eng', config='--psm 6')

                lines = text.strip().split('\n')
                for line in lines:
                    nums = re.findall(r'(\d+)', line)
                    if len(nums) >= 3:
                        int_nums = [int(n) for n in nums]
                        for start in range(len(int_nums) - 4, -1, -1):
                            if start + 4 > len(int_nums):
                                continue
                            m, f, tg, t = int_nums[start:start+4]
                            if t > 0 and abs(t - (m + f + tg)) <= 2:
                                result['male'] = m
                                result['female'] = f
                                result['third_gender'] = tg
                                result['total'] = t
                                result['method'] = 'last_page'
                                break
                        if result['total'] > 0:
                            break

                        # Try 3-number pattern (M, F, Total) with no third gender
                        for start in range(len(int_nums) - 3, -1, -1):
                            m, f, t = int_nums[start:start+3]
                            if t > 0 and abs(t - (m + f)) <= 2 and t > 100:
                                result['male'] = m
                                result['female'] = f
                                result['total'] = t
                                result['method'] = 'last_page_3col'
                                break
                        if result['total'] > 0:
                            break

                if result['total'] > 0:
                    break

        # Strategy 3: Fallback — count max serial number from voter entry pages
        if result['total'] == 0:
            max_serial = 0
            # Check a few pages near the end (where last entries are)
            for page_idx in range(max(0, num_pages - 5), num_pages):
                page = pdf[page_idx]
                bitmap = page.render(scale=2)
                img = bitmap.to_pil()
                text = pytesseract.image_to_string(img, lang='eng', config='--psm 6')
                serials = re.findall(r'(?:^|\s)(\d{1,4})(?:\s|$)', text)
                for s in serials:
                    n = int(s)
                    if 10 < n < 3000 and n > max_serial:
                        max_serial = n
            if max_serial > 50:
                result['total'] = max_serial
                result['method'] = 'serial_count'

        pdf.close()

    except Exception as e:
        result['method'] = f'error: {str(e)[:80]}'

    return result


def process_folder(folder_path, constituency_key):
    """Process all PDFs in a folder and output consolidated results."""
    pdf_files = sorted(
        glob.glob(os.path.join(folder_path, '*.pdf')) +
        glob.glob(os.path.join(folder_path, '*.PDF')),
        key=lambda f: extract_part_number(f)
    )

    if not pdf_files:
        print(f"  ERROR: No PDF files found in {folder_path}")
        return

    print(f"{'=' * 70}")
    print(f"  ECI SIR ELECTORAL ROLL - VOTER EXTRACTION (OCR)")
    print(f"  Constituency: {constituency_key.upper()}")
    print(f"  Folder: {folder_path}")
    print(f"  PDFs found: {len(pdf_files)}")
    print(f"{'=' * 70}\n")

    results = []
    errors = []

    for i, filepath in enumerate(pdf_files, 1):
        filename = os.path.basename(filepath)
        part_no = extract_part_number(filepath)

        sys.stdout.write(f"\r  [{i:3d}/{len(pdf_files)}] Part {part_no:3d}...")
        sys.stdout.flush()

        data = extract_voters_from_pdf(filepath)
        data['part_no'] = part_no
        data['filename'] = filename

        if data['total'] > 0:
            status = f"M={data['male']:>4d} F={data['female']:>4d} T={data['total']:>4d} ({data['method']})"
            results.append(data)
        else:
            status = f"FAILED ({data['method']})"
            errors.append(data)

        sys.stdout.write(f"\r  [{i:3d}/{len(pdf_files)}] Part {part_no:3d}: {status}\n")
        sys.stdout.flush()

    # Sort by part number
    results.sort(key=lambda x: x['part_no'])

    # Compute totals
    total_male = sum(r['male'] for r in results)
    total_female = sum(r['female'] for r in results)
    total_third = sum(r['third_gender'] for r in results)
    total_voters = sum(r['total'] for r in results)
    parts_ok = len(results)
    parts_fail = len(errors)

    print(f"\n{'=' * 70}")
    print(f"  RESULTS SUMMARY")
    print(f"{'=' * 70}")
    print(f"  Parts processed:  {parts_ok} / {len(pdf_files)}")
    if parts_fail:
        print(f"  Parts FAILED:     {parts_fail}")
        for e in errors:
            print(f"    - Part {e['part_no']}: {e['filename']} ({e['method']})")
    print(f"\n  TOTAL VOTERS:     {total_voters:,}")
    if total_male > 0:
        print(f"    Male:           {total_male:,}")
        print(f"    Female:         {total_female:,}")
        if total_third > 0:
            print(f"    Third Gender:   {total_third:,}")
    print(f"\n  Avg per part:     {total_voters // max(parts_ok, 1):,}")
    print(f"{'=' * 70}")

    # Method distribution
    methods = defaultdict(int)
    for r in results:
        methods[r['method']] += 1
    print(f"\n  Extraction methods used:")
    for method, count in sorted(methods.items(), key=lambda x: -x[1]):
        print(f"    {method}: {count} parts")

    # Save CSV
    out_dir = f'data/constituencies/{constituency_key}'
    os.makedirs(out_dir, exist_ok=True)

    csv_path = os.path.join(out_dir, 'sir_voters.csv')
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=[
            'part_no', 'part_name', 'male', 'female', 'third_gender', 'total', 'method', 'filename'
        ])
        writer.writeheader()
        for r in results:
            writer.writerow({
                'part_no': r['part_no'],
                'part_name': r.get('part_name', ''),
                'male': r['male'],
                'female': r['female'],
                'third_gender': r['third_gender'],
                'total': r['total'],
                'method': r['method'],
                'filename': r['filename'],
            })
    print(f"\n  Saved: {csv_path}")

    # Save summary JSON
    summary = {
        'constituency': constituency_key,
        'total_voters': total_voters,
        'male': total_male,
        'female': total_female,
        'third_gender': total_third,
        'parts_total': len(pdf_files),
        'parts_extracted': parts_ok,
        'parts_failed': parts_fail,
        'avg_per_part': total_voters // max(parts_ok, 1),
        'source': 'ECI SIR Electoral Roll 2026 (OCR extracted)',
    }

    summary_path = os.path.join(out_dir, 'sir_summary.json')
    with open(summary_path, 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"  Saved: {summary_path}")

    # Update vote_arithmetic.json if it exists
    arith_path = os.path.join(out_dir, 'vote_arithmetic.json')
    if os.path.exists(arith_path):
        with open(arith_path, encoding='utf-8') as f:
            arith = json.load(f)
        old_total = arith.get('total_voters_2026', 0)
        arith['total_voters_2026'] = total_voters
        arith['sir_data'] = {
            'total_voters': total_voters,
            'male': total_male,
            'female': total_female,
            'third_gender': total_third,
            'parts': parts_ok,
            'source': 'ECI SIR 2026 (OCR extracted from PDFs)',
        }
        with open(arith_path, 'w', encoding='utf-8') as f:
            json.dump(arith, f, ensure_ascii=False, indent=2)
        print(f"  Updated: {arith_path} (voters: {old_total:,} -> {total_voters:,})")

    print(f"\n  Next step: python3 scripts/deep_prediction.py --constituency {constituency_key}")
    print(f"{'=' * 70}")

    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Extract voter counts from ECI SIR Electoral Roll PDFs (OCR)',
        epilog='Example: python3 scripts/extract_sir_voters.py --folder ~/Downloads/votersdata --constituency kochi'
    )
    parser.add_argument('--folder', required=True,
                        help='Path to folder containing ECI electoral roll PDFs')
    parser.add_argument('--constituency', required=True,
                        help='Constituency name (e.g., kochi, kalamassery)')
    args = parser.parse_args()

    if not os.path.isdir(args.folder):
        print(f"ERROR: Folder not found: {args.folder}")
        exit(1)

    process_folder(args.folder, args.constituency.lower())
