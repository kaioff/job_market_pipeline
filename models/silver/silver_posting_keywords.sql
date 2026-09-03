with vocabulary as (
    select distinct keyword
    from {{ source('silver', 'linkedin_keyword_snapshots') }}
    where keyword not in {{ noise_terms() }}
      and length(keyword) > 1
      and length(keyword) <= 40
      and size(split(trim(keyword), '\\s+')) <= 4
      and keyword not rlike '(?i)https?://|www\\.|\\.com|\\.html|\\.pdf|<|>|="|@'

),

patterns as (

    select
        keyword,
        length(keyword) as keyword_length,
        case
            -- word characters at both ends -> a word-boundary match is
            -- meaningful; otherwise (symbol-heavy keywords) fall back to
            -- a plain literal match
            when keyword rlike '^\\w.*\\w$|^\\w$'
                then concat(
                    '\\b',
                    regexp_replace(lower(keyword), '([\\+\\*\\?\\.\\(\\)\\[\\]\\^\\$\\|\\\\])', '\\\\$1'),
                    '\\b'
                )
            else regexp_replace(lower(keyword), '([\\+\\*\\?\\.\\(\\)\\[\\]\\^\\$\\|\\\\])', '\\\\$1')
        end as pattern
    from vocabulary

),

combined_pattern as (

    select
        concat(
            '(?i)(',
            concat_ws(
                '|',
                transform(
                    -- longest keyword first, so e.g. "react native" wins
                    -- over "react" matching as a substring of it
                    array_sort(
                        collect_list(struct(-keyword_length as ord, pattern as p)),
                        (l, r) -> l.ord - r.ord
                    ),
                    x -> x.p
                )
            ),
            ')'
        ) as full_pattern
    from patterns

),

postings as (

    select job_url, lower(description_text) as description_lower
    from {{ ref('silver_linkedin_postings') }}
    where description_text is not null

),

matches as (

    select
        p.job_url,
        explode(regexp_extract_all(p.description_lower, cp.full_pattern, 1)) as matched_text
    from postings p
    cross join combined_pattern cp

)

select distinct m.job_url, v.keyword
from matches m
inner join vocabulary v on lower(m.matched_text) = lower(v.keyword)
---test