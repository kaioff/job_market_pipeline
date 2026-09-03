-- Top titles / companies / locations / experience bands for the postings
-- that mention each skill, in one long table keyed by dimension so a
-- single API call can populate every breakdown panel.
--
-- dimension: 'title' | 'company' | 'location' | 'experience_band'
-- Capped at the top 10 values per (skill, dimension).
--
-- Note on titles: these are raw scraped job titles, so near-duplicates
-- ("Senior Data Engineer" vs "Sr. Data Engineer, Remote") count
-- separately. Good enough to show what a skill is hired for; not a clean
-- taxonomy.

with skill_postings as (

    select job_url, keyword
    from {{ ref('silver_posting_keywords') }}

),

postings as (

    select job_url, title, company, location
    from {{ ref('silver_linkedin_postings') }}

),

experience_bands as (

    select
        job_url,
        case
            when years_min is null then 'not_specified'
            when years_min <= 2 then '0-2'
            when years_min <= 5 then '3-5'
            when years_min <= 8 then '5-8'
            else '8+'
        end as experience_band
    from {{ ref('silver_experience_requirements') }}

),

enriched as (

    select
        sp.keyword,
        sp.job_url,
        p.title,
        p.company,
        p.location,
        eb.experience_band
    from skill_postings sp
    inner join postings p on sp.job_url = p.job_url
    left join experience_bands eb on sp.job_url = eb.job_url

),

skill_totals as (

    select keyword, count(distinct job_url) as skill_postings
    from skill_postings
    group by keyword

),

unpivoted as (

    select keyword, 'title' as dimension, title as value, job_url
    from enriched
    where title is not null

    union all

    select keyword, 'company' as dimension, company as value, job_url
    from enriched
    where company is not null

    union all

    select keyword, 'location' as dimension, location as value, job_url
    from enriched
    where location is not null

    union all

    select keyword, 'experience_band' as dimension, experience_band as value, job_url
    from enriched
    where experience_band is not null

),

counted as (

    select
        keyword,
        dimension,
        value,
        count(distinct job_url) as posting_count
    from unpivoted
    group by keyword, dimension, value

)

select
    c.keyword,
    c.dimension,
    c.value,
    c.posting_count,
    round(100.0 * c.posting_count / t.skill_postings, 1) as pct_of_skill_postings
from counted c
inner join skill_totals t on c.keyword = t.keyword
qualify row_number() over (
    partition by c.keyword, c.dimension
    order by c.posting_count desc
) <= 10
