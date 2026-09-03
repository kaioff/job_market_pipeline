-- Posting-level keyword membership: one row per (job_url, keyword) match.
--
-- linkedin_keyword_snapshots only carries daily aggregate counts per
-- keyword, with no link back to individual postings, so it can't answer
-- "which postings mention Python" or "what else shows up alongside
-- Python". This model re-derives that link by matching a keyword
-- vocabulary against each posting's own description text.
--
-- Why the vocabulary is aggressively narrowed below: the upstream
-- extraction emits ~thousands of "keywords", but most are boilerplate
-- noun phrases lifted out of descriptions ("fast-paced, cross-functional
-- environment", "preferred qualifications experience") rather than
-- skills. Matching all of them is both meaningless for a skill lookup
-- and expensive -- the postings x vocabulary cross join is what makes
-- this model slow. Real skill terms are short and recur across many
-- postings, so we keep only the most common short terms.
--
-- Matching is case-insensitive and word-boundary aware, so 'go' won't
-- match inside 'google'. It won't catch aliases the extraction job may
-- special-case (e.g. "AWS" vs "Amazon Web Services"), and symbol-heavy
-- keywords like 'c++' or 'c#' fall back to a plain literal match since
-- \b doesn't apply around non-word characters. Per-keyword posting
-- counts here may therefore drift slightly from
-- linkedin_keyword_snapshots -- treat this model as the source for
-- posting-level drill-downs (co-occurrence, top titles/companies for a
-- skill), not as a replacement for the trend counts already served by
-- gold_keyword_latest / gold_keyword_trends.

{% set max_vocabulary_size = 400 %}

with vocabulary as (

    select keyword
    from (
        select
            keyword,
            sum(posting_count) as total_mentions
        from {{ source('silver', 'linkedin_keyword_snapshots') }}
        where keyword not in {{ noise_terms() }}
          and length(keyword) between 2 and 30
          -- skills are one or two words ("python", "apache spark"),
          -- never sentence fragments
          and size(split(trim(keyword), '\\s+')) <= 2
          -- drop scraped junk: urls, markup, emails
          and keyword not rlike '(?i)https?://|www\\.|\\.com|\\.html|\\.pdf|<|>|="|@'
          -- a real skill term recurs; one-off phrases are extraction noise
          and keyword rlike '^[a-z0-9][a-z0-9 .+#/-]*$'
        group by keyword
    )
    order by total_mentions desc
    limit {{ max_vocabulary_size }}

),

postings as (

    select job_url, lower(description_text) as description_lower
    from {{ ref('silver_linkedin_postings') }}
    where description_text is not null

),

matched as (

    select
        p.job_url,
        v.keyword
    from postings p
    cross join vocabulary v
    where
        case
            -- word characters at both ends -> a word-boundary match is
            -- meaningful; otherwise (symbol-heavy keywords like 'c++')
            -- fall back to a plain literal containment check
            when v.keyword rlike '^\\w.*\\w$|^\\w$'
                then p.description_lower rlike concat(
                    '(?i)\\b',
                    regexp_replace(lower(v.keyword), '([\\+\\*\\?\\.\\(\\)\\[\\]\\^\\$\\|\\\\])', '\\\\$1'),
                    '\\b'
                )
            else instr(p.description_lower, lower(v.keyword)) > 0
        end

)

select distinct job_url, keyword
from matched
