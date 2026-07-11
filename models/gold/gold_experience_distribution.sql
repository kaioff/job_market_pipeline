with req as (
    select * from {{ ref('silver_experience_requirements') }}
),

banded as (
    select
        job_url,
        case
            when years_min is null then 'not_specified'
            when years_min <= 2 then '0-2'
            when years_min <= 5 then '3-5'
            when years_min <= 8 then '5-8'
            else '8+'
        end as experience_band
    from req
),

totals as (
    select count(*) as total_postings from banded
)

select
    b.experience_band,
    count(*) as posting_count,
    round(100.0 * count(*) / t.total_postings, 1) as pct
from banded b
cross join totals t
group by b.experience_band, t.total_postings
order by
    case b.experience_band
        when '0-2' then 1
        when '3-5' then 2
        when '5-8' then 3
        when '8+' then 4
        else 5
    end