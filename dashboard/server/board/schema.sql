-- Hot-path landing table for the live job board.
--
-- Sits in bronze alongside linkedin_postings_raw, but differs from it in
-- one important way: this table is deduped on posting_id, where the 6h
-- scrape table is append-only-with-duplicates. It is written every few
-- minutes by the dashboard poller (server/board/poller.py), never by dbt.
--
-- Reads on the request path are served from process memory, so nothing
-- queries this table except the once-per-boot seed. It exists for
-- durability across restarts and as a feed into the medallion layers.

CREATE TABLE IF NOT EXISTS job_market.bronze.linkedin_postings_live (
  posting_id   STRING    NOT NULL COMMENT 'LinkedIn numeric job ID, parsed from the card href. Stable across fetches, unlike the URL, which carries per-request tracking params.',
  title        STRING    COMMENT 'Job title as shown on the search card.',
  company      STRING,
  location     STRING,
  job_url      STRING    COMMENT 'Canonical apply link, tracking params stripped.',
  posted_at    DATE      COMMENT 'Posted date from the search card. Date-only, so it rounds a 40-minute-old job to midnight.',
  posted_at_precise TIMESTAMP COMMENT 'Absolute time parsed from the detail page relative age ("40 minutes ago"). What the board displays.',
  applicants   INT       COMMENT 'Applicant count at the moment we first fetched the posting.',
  retrieved_at TIMESTAMP COMMENT 'When the poller first saw this posting. The board sorts on this, not posted_at.',
  source       STRING    COMMENT 'Source adapter name, e.g. linkedin-guest. Lets a second feed land here without ambiguity.'
)
USING DELTA
COMMENT 'Deduped, near-real-time job postings feeding the live board.'
TBLPROPERTIES (
  -- Small frequent writes produce many tiny files; auto-compaction keeps
  -- file count sane without a scheduled OPTIMIZE job.
  'delta.autoOptimize.optimizeWrite' = 'true',
  'delta.autoOptimize.autoCompact'   = 'true'
);
