with vocabulary as (

    select distinct keyword
    from {{ source('silver', 'linkedin_keyword_snapshots') }}
    where keyword not in {{ noise_terms() }}
      and length(keyword) > 1

),

postings as (

    select job_url, lower(description_text) as description_lower
    from {{ ref('silver_linkedin_postings') }}
    where description_text is not null

),

candidates as (

    select
        p.job_url,
        v.keyword,
        p.description_lower,
        -- escape regex metacharacters in the keyword so it's matched
        -- literally, then wrap in word boundaries
        regexp_replace(lower(v.keyword), '([\\+\\*\\?\\.\\(\\)\\[\\]\\^\\$\\|\\\\])', '\\\\$1') as escaped_keyword,
        -- word characters at both ends -> boundary match is meaningful
        v.keyword rlike '^\\w.*\\w$|^\\w$' as has_word_boundaries
    from postings p
    cross join vocabulary v

),

matched as (

    select job_url, keyword
    from candidates
    where
        case
            when has_word_boundaries
                then description_lower rlike concat('(?i)\\b', escaped_keyword, '\\b')
            else
                instr(description_lower, lower(keyword)) > 0
        end

)

select job_url, keyword
from matched
