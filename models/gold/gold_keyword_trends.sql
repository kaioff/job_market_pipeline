select
    keyword,
    snapshot_date,
    posting_count
from {{ source('silver', 'linkedin_keyword_snapshots') }}
where keyword not in {{ noise_terms() }}
  and length(keyword) > 1
order by snapshot_date, posting_count desc