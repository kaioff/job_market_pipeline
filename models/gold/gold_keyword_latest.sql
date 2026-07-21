with latest_date as (
    select max(snapshot_date) as max_date
    from {{ source('silver', 'linkedin_keyword_snapshots') }}
),

total as (
    select count(distinct job_url) as total_postings
    from {{ ref('silver_linkedin_postings') }}
    where description_text is not null
)

select
    k.keyword,
    k.posting_count,
    k.snapshot_date,
    round(100.0 * k.posting_count / t.total_postings, 1) as pct
from {{ source('silver', 'linkedin_keyword_snapshots') }} k
cross join total t
where k.snapshot_date = (select max_date from latest_date)
  and k.keyword not in {{ noise_terms() }}
  and length(k.keyword) > 1
order by k.posting_count desc