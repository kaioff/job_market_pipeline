with latest_date as (
    select max(snapshot_date) as max_date
    from {{ source('silver', 'linkedin_keyword_snapshots') }}
)

select
    keyword,
    posting_count,
    snapshot_date
from {{ source('silver', 'linkedin_keyword_snapshots') }}
where snapshot_date = (select max_date from latest_date)
  and keyword not in {{ noise_terms() }}
  and length(keyword) > 1
order by posting_count desc