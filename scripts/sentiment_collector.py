#!/usr/bin/env python3
"""
Social Media Sentiment Collector for Kerala 2026 Election Predictions.

Collects and analyzes sentiment from:
1. Reddit (r/Kerala, r/Kochi, r/india) - election/political discussions
2. General social media sentiment indicators
3. Meme sentiment tracking (pro/anti party memes in Ernakulam context)

Data is stored as structured JSON for integration with the prediction model.

Usage:
    python scripts/sentiment_collector.py --constituency kalamassery
    python scripts/sentiment_collector.py --constituency kalamassery --update
"""
import json
import os
import csv
import copy
import argparse
from datetime import datetime

FRONT_SENTIMENT_TEMPLATE = {
    "LDF": {
        "score": 0.0,
        "positive_mentions": 0,
        "negative_mentions": 0,
        "neutral_mentions": 0,
        "key_themes": [],
        "sample_posts": []
    },
    "UDF": {
        "score": 0.0,
        "positive_mentions": 0,
        "negative_mentions": 0,
        "neutral_mentions": 0,
        "key_themes": [],
        "sample_posts": []
    },
    "NDA": {
        "score": 0.0,
        "positive_mentions": 0,
        "negative_mentions": 0,
        "neutral_mentions": 0,
        "key_themes": [],
        "sample_posts": []
    }
}

SENTIMENT_TEMPLATE = {
    "meta": {
        "constituency": "",
        "district": "",
        "last_updated": "",
        "collection_method": "manual_entry",
        "notes": "Sentiment scores: -1.0 (strongly negative) to +1.0 (strongly positive)"
    },
    "reddit_sentiment": {
        "subreddits_tracked": ["r/Kerala", "r/Kochi", "r/india"],
        "sample_size": 0,
        "date_range": {"from": "", "to": ""},
        "topics": [],
        "front_sentiment": copy.deepcopy(FRONT_SENTIMENT_TEMPLATE)
    },
    "facebook_sentiment": {
        "pages_tracked": [],
        "groups_tracked": [],
        "sample_size": 0,
        "date_range": {"from": "", "to": ""},
        "front_sentiment": copy.deepcopy(FRONT_SENTIMENT_TEMPLATE)
    },
    "twitter_sentiment": {
        "handles_tracked": [],
        "hashtags_tracked": [],
        "sample_size": 0,
        "date_range": {"from": "", "to": ""},
        "front_sentiment": copy.deepcopy(FRONT_SENTIMENT_TEMPLATE)
    },
    "instagram_sentiment": {
        "hashtags_tracked": [],
        "pages_tracked": [],
        "sample_size": 0,
        "date_range": {"from": "", "to": ""},
        "front_sentiment": copy.deepcopy(FRONT_SENTIMENT_TEMPLATE)
    },
    "meme_sentiment": {
        "platforms_tracked": ["Instagram", "Facebook", "Twitter/X", "WhatsApp_groups"],
        "total_memes_analyzed": 0,
        "date_range": {"from": "", "to": ""},
        "ernakulam_targeted": {
            "total": 0,
            "pro_LDF": 0,
            "pro_UDF": 0,
            "pro_NDA": 0,
            "anti_LDF": 0,
            "anti_UDF": 0,
            "anti_NDA": 0,
            "neutral_political": 0,
            "viral_memes": []
        },
        "kalamassery_specific": {
            "total": 0,
            "candidate_memes": {
                "P. Rajeeve (LDF)": {"positive": 0, "negative": 0, "neutral": 0},
                "V. E. Abdul Gafoor (UDF)": {"positive": 0, "negative": 0, "neutral": 0},
                "M. P. Binu (NDA)": {"positive": 0, "negative": 0, "neutral": 0}
            },
            "development_memes": 0,
            "corruption_memes": 0,
            "communal_memes": 0,
        }
    },
    "social_media_general": {
        "candidate_followings": {
            "P. Rajeeve (LDF)": {"followers": 0, "engagement_rate": 0.0, "growth_30d": 0.0},
            "V. E. Abdul Gafoor (UDF)": {"followers": 0, "engagement_rate": 0.0, "growth_30d": 0.0},
            "M. P. Binu (NDA)": {"followers": 0, "engagement_rate": 0.0, "growth_30d": 0.0}
        },
        "trending_hashtags": [],
        "issue_sentiment": {
            "development": {"dominant_front": "", "score": 0.0},
            "corruption": {"dominant_front": "", "score": 0.0},
            "employment": {"dominant_front": "", "score": 0.0},
            "welfare": {"dominant_front": "", "score": 0.0},
            "communal_harmony": {"dominant_front": "", "score": 0.0},
            "local_issues": []
        }
    },
    "ground_reports": {
        "booth_level_intel": [],
        "local_events": [],
        "candidate_visibility": {
            "LDF": {"rallies": 0, "door_to_door": "", "media_presence": ""},
            "UDF": {"rallies": 0, "door_to_door": "", "media_presence": ""},
            "NDA": {"rallies": 0, "door_to_door": "", "media_presence": ""}
        }
    },
    "computed_sentiment_adjustment": {
        "LDF_adjustment": 0.0,
        "UDF_adjustment": 0.0,
        "NDA_adjustment": 0.0,
        "confidence": "low",
        "methodology": "Weighted average: Reddit(0.10) + Facebook(0.10) + Twitter(0.05) + Instagram(0.20) + Memes(0.10) + GroundReports(0.45)"
    }
}


# Constituency configs for candidate lookup
CONSTITUENCY_CONFIG = {
    'kalamassery': {'no': 77, 'district': 'Ernakulam'},
    'kochi': {'no': 80, 'district': 'Ernakulam'},
}


def get_candidates(constituency_no):
    """Load 2026 candidates for a constituency."""
    with open('data/candidates_2026.csv', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            if int(row['Constituency_No']) == constituency_no:
                return {
                    'LDF': f"{row['LDF_Candidate']} ({row['LDF_Party']})",
                    'UDF': f"{row['UDF_Candidate']} ({row['UDF_Party']})",
                    'NDA': f"{row['NDA_Candidate']} ({row['NDA_Party']})",
                }
    return {'LDF': 'TBD', 'UDF': 'TBD', 'NDA': 'TBD'}


def initialize_sentiment(constituency_key):
    """Create initial sentiment data file for a constituency."""
    out_dir = f'data/constituencies/{constituency_key}'
    os.makedirs(out_dir, exist_ok=True)
    filepath = os.path.join(out_dir, 'sentiment_data.json')

    if os.path.exists(filepath):
        print(f"  Sentiment file already exists: {filepath}")
        print(f"  Use --update to modify existing data")
        return filepath

    config = CONSTITUENCY_CONFIG.get(constituency_key, {'no': 0, 'district': 'Ernakulam'})
    candidates = get_candidates(config['no'])

    data = copy.deepcopy(SENTIMENT_TEMPLATE)
    data['meta']['constituency'] = constituency_key.title()
    data['meta']['district'] = config['district']
    data['meta']['last_updated'] = datetime.now().isoformat()

    # Set candidate-specific fields
    data['meme_sentiment']['kalamassery_specific'] = {
        'total': 0,
        'candidate_memes': {
            candidates['LDF']: {"positive": 0, "negative": 0, "neutral": 0},
            candidates['UDF']: {"positive": 0, "negative": 0, "neutral": 0},
            candidates['NDA']: {"positive": 0, "negative": 0, "neutral": 0},
        },
        'development_memes': 0,
        'corruption_memes': 0,
        'communal_memes': 0,
    }
    # Rename the key to match constituency
    data['meme_sentiment'][f'{constituency_key}_specific'] = data['meme_sentiment'].pop('kalamassery_specific')

    data['social_media_general']['candidate_followings'] = {
        candidates['LDF']: {"followers": 0, "engagement_rate": 0.0, "growth_30d": 0.0},
        candidates['UDF']: {"followers": 0, "engagement_rate": 0.0, "growth_30d": 0.0},
        candidates['NDA']: {"followers": 0, "engagement_rate": 0.0, "growth_30d": 0.0},
    }

    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"  Initialized sentiment template: {filepath}")
    print(f"  Candidates: {candidates}")
    print(f"  Fill in the data manually or via automated collection scripts")
    return filepath


def _score_platform_sentiment(data, platform_key, weight, adjustments):
    """Score a platform's front_sentiment and add weighted adjustment. Returns weight if data exists."""
    platform = data.get(platform_key, {}).get('front_sentiment', {})
    if any(platform.get(f, {}).get('score', 0) != 0 for f in ['LDF', 'UDF', 'NDA']):
        for front in ['LDF', 'UDF', 'NDA']:
            score = platform.get(front, {}).get('score', 0)
            adjustments[front] += score * 3.0 * weight
        return weight
    return 0.0


def compute_sentiment_score(data):
    """
    Compute vote share adjustment from sentiment data.

    Platform weights (data-driven, based on swing pool overlap):
    - Reddit sentiment:    10% (educated urban, policy-focused, ~12% of swing pool)
    - Facebook sentiment:  10% (broadest Kerala demographic, groups/pages, older voters)
    - Twitter/X sentiment:  5% (political junkies, noisy/astroturfed, low Kerala penetration)
    - Instagram sentiment: 20% (18-35 youth, highest Kerala social penetration, turnout gauge)
    - Meme sentiment:      10% (cross-platform amplifier, virality indicator)
    - Ground reports:      45% (only source for fishermen, BDJS, community-level decisions)

    Returns adjustment in vote share percentage points (-3 to +3 range).
    """
    MAX_ADJUSTMENT = 3.0  # Cap at ±3 percentage points

    adjustments = {'LDF': 0.0, 'UDF': 0.0, 'NDA': 0.0}
    weights_used = 0.0

    # Platform sentiments with individual weights
    PLATFORM_WEIGHTS = {
        'reddit_sentiment':    0.10,
        'facebook_sentiment':  0.10,
        'twitter_sentiment':   0.05,
        'instagram_sentiment': 0.20,
    }

    for platform_key, weight in PLATFORM_WEIGHTS.items():
        weights_used += _score_platform_sentiment(data, platform_key, weight, adjustments)

    # Meme sentiment (weight: 0.10)
    memes = data.get('meme_sentiment', {}).get('ernakulam_targeted', {})
    total_memes = memes.get('total', 0)
    if total_memes > 0:
        for front in ['LDF', 'UDF', 'NDA']:
            pro = memes.get(f'pro_{front}', 0)
            anti = memes.get(f'anti_{front}', 0)
            net = (pro - anti) / total_memes
            adjustments[front] += net * MAX_ADJUSTMENT * 0.10
        weights_used += 0.10

    # Ground reports - manual qualitative override (weight: 0.45)
    ground = data.get('ground_reports', {})
    vis = ground.get('candidate_visibility', {})
    total_rallies = sum(vis.get(f, {}).get('rallies', 0) for f in ['LDF', 'UDF', 'NDA'])
    if total_rallies > 0:
        for front in ['LDF', 'UDF', 'NDA']:
            rally_share = vis.get(front, {}).get('rallies', 0) / total_rallies
            adjustments[front] += (rally_share - 0.33) * MAX_ADJUSTMENT * 0.45
        weights_used += 0.45

    # Normalize if we have partial data
    if weights_used > 0 and weights_used < 1.0:
        for front in adjustments:
            adjustments[front] = adjustments[front] / weights_used * weights_used

    # Clamp
    for front in adjustments:
        adjustments[front] = max(-MAX_ADJUSTMENT, min(MAX_ADJUSTMENT, round(adjustments[front], 2)))

    confidence = 'low'
    if weights_used >= 0.7:
        confidence = 'high'
    elif weights_used >= 0.4:
        confidence = 'medium'

    return {
        'LDF_adjustment': adjustments['LDF'],
        'UDF_adjustment': adjustments['UDF'],
        'NDA_adjustment': adjustments['NDA'],
        'confidence': confidence,
        'weights_used': round(weights_used, 2),
    }


def update_sentiment_scores(constituency_key):
    """Recompute sentiment adjustments from current data."""
    filepath = f'data/constituencies/{constituency_key}/sentiment_data.json'
    if not os.path.exists(filepath):
        print(f"  No sentiment data found. Run without --update first.")
        return

    with open(filepath, encoding='utf-8') as f:
        data = json.load(f)

    scores = compute_sentiment_score(data)
    data['computed_sentiment_adjustment'] = {
        **scores,
        'methodology': SENTIMENT_TEMPLATE['computed_sentiment_adjustment']['methodology'],
    }
    data['meta']['last_updated'] = datetime.now().isoformat()

    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"  Updated sentiment adjustments for {constituency_key}:")
    print(f"    LDF: {scores['LDF_adjustment']:+.2f}%")
    print(f"    UDF: {scores['UDF_adjustment']:+.2f}%")
    print(f"    NDA: {scores['NDA_adjustment']:+.2f}%")
    print(f"    Confidence: {scores['confidence']}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Social media sentiment collector')
    parser.add_argument('--constituency', default='kalamassery')
    parser.add_argument('--update', action='store_true',
                        help='Recompute sentiment scores from existing data')
    args = parser.parse_args()

    if args.update:
        update_sentiment_scores(args.constituency)
    else:
        initialize_sentiment(args.constituency)
