with total as (
    select count(distinct job_url) as total_postings
    from {{ ref('silver_linkedin_postings') }}
    where description_text is not null
)

select
    k.keyword,
    k.snapshot_date,
    k.posting_count,
    round(100.0 * k.posting_count / t.total_postings, 1) as pct
from {{ source('silver', 'linkedin_keyword_snapshots') }} k
cross join total t
where k.keyword not in {{ noise_terms() }}
  and length(k.keyword) > 1
order by k.snapshot_date, k.posting_count desc