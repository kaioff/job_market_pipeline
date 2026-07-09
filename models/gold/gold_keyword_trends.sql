select
    keyword,
    snapshot_date,
    posting_count
from {{ source('silver', 'linkedin_keyword_snapshots') }}
order by snapshot_date, posting_count desc