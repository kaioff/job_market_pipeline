with matches as (

    select
        job_url,
        explode(
            regexp_extract_all(
                lower(description_text),
                '([0-9]{1,2})[ -]*[+]?[ ]*years?',
                1
            )
        ) as years_str
    from {{ ref('silver_linkedin_postings') }}
    where description_text is not null

),

parsed as (

    select
        job_url,
        cast(years_str as int) as years_val
    from matches
    where years_str is not null and years_str != ''

),

per_posting_min as (

    select
        job_url,
        min(years_val) as years_min
    from parsed
    where years_val between 0 and 20
    group by job_url

)

select
    p.job_url,
    pp.years_min
from {{ ref('silver_linkedin_postings') }} p
left join per_posting_min pp on p.job_url = pp.job_url