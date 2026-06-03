# Discovery Rules

Rules that govern how a session discovers and selects posts to engage with.
The thresholds live in `lib/discovery.ts`; the niche keywords/queries live in
`lib/discovery.ts` (CORE_KEYWORDS / RELEVANCE_KEYWORDS) and `lib/intent.ts`
(BUYER_INTENT_QUERIES). Fill those in for your niche.

## Feed scrolling

- Scrolls the configured discovery source with human-like mouse-wheel movements.
- Default discovery source is the X home feed.
- `--home` forces the baseline home-feed flow.
- `--community <url-or-id>` switches to a specific X community timeline.
- `--search "exact words"` switches to X search for an exact query.
- `--keywords` runs the saved `keywords` search set (`KEYWORD_SEARCH_SET` in lib/session-cli.ts).
- `--buyer-intent` runs the buyer-intent search rotation (`BUYER_INTENT_QUERIES` in lib/intent.ts).
- `--search-set <alias>` rotates through a named set (`buyers`/`intent` use the buyer-intent queries).
- Deduplicates by tweet ID across scrolls.

## Filtering

Every discovered post must pass all of the following to be eligible:

| Rule | Threshold |
|------|-----------|
| Not own post | Excludes the authenticated account |
| Not already liked | Skips posts with an active "unlike" button |
| Not promoted/ad | Skips Promoted/placement-tracked posts |
| Like count range | Min **3**, max **50,000** likes |
| Post age | Max **3 hours** old (from the Snowflake tweet ID) |
| No retweets / quote tweets | Skipped via social-context + `RT @` detection |
| No low-signal posts | Skips empty/emoji-only/greeting-only posts |
| Not a sensitive topic | Skips politics/religion/geopolitics/etc. (lib/sensitive-content.ts) |
| Keyword relevance | Must match your niche keywords (or the active search query) |
| Follower cap | Skips authors over **50,000** followers unless `isPriorityAccountProfile` exempts them |

In **targeted** acquisition mode (`--buyer-intent` / `--search-set buyers`), posts are
gated and ranked by the buyer-intent score from `lib/intent.ts` instead of the broad
keyword list.

## Like execution rule

- Likes require a known author follower count below **8,000**.
- If the count is unavailable or **8,000+**, the session may still comment but skips the like.

## Prioritization

Posts are scored and sorted before selection:
- **Core keywords** score **2 pts** each; **secondary keywords** score **1 pt** each.
- **Freshness** is rewarded across the first **3 hours**.
- **Sub-10-minute posts** are treated as thread-winning opportunities.
- **Author size band** is rewarded around **2–10x** your own follower count.
- **Priority accounts** (per `isPriorityAccountProfile`) are exempt from the large-account cap.

## Blocked accounts

Accounts listed in `lib/hard-rules.ts` (`BLOCKED_USERNAMES`) are never engaged by any
persona. Retweets and quote tweets are also hard-blocked there.
