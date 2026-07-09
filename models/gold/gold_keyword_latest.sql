-- models/gold/gold_keyword_latest.sql
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
order by posting_count desc