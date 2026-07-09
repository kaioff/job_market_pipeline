with postings_ranked as (
    select
        *,
        row_number() over (
            partition by job_url
            order by scraped_at desc
        ) as rn
    from {{ source('bronze', 'linkedin_postings_raw') }}),

postings_deduped as (
    select
        job_url,
        title,
        company,
        location,
        posted_date,
        search_keyword,
        search_location,
        scraped_at
    from postings_ranked
    where rn = 1),

postings_with_dates as (
    select
        job_url,
        title,
        company,
        location,
        try_cast(posted_date as date) as posted_date,
        search_keyword,
        search_location,
        min(scraped_at) over (partition by job_url) as first_seen_at,
        max(scraped_at) over (partition by job_url) as last_seen_at
    from postings_deduped),

descriptions as (
    select
        job_url,
        description_text
    from {{ source('bronze', 'linkedin_postings_descriptions_raw') }}
    where fetch_status = 'ok')

select
    p.job_url,
    p.title,
    p.company,
    p.location,
    p.posted_date,
    p.search_keyword,
    p.search_location,
    p.first_seen_at,
    p.last_seen_at,
    d.description_text
from postings_with_dates p
left join descriptions d
    on p.job_url = d.job_url