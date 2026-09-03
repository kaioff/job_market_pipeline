-- Headline stats per skill: how common it is, and how much experience
-- postings mentioning it tend to ask for.
--
-- Built on silver_posting_keywords (posting-level matches), so the counts
-- here are "postings whose description text mentions this skill". They
-- may differ slightly from gold_keyword_latest, which reports what the
-- upstream extraction counted -- see the note in silver_posting_keywords.

with skill_postings as (

    select job_url, keyword
    from {{ ref('silver_posting_keywords') }}

),

total as (

    select count(distinct job_url) as total_postings
    from {{ ref('silver_linkedin_postings') }}
    where description_text is not null

),

experience as (

    select job_url, years_min
    from {{ ref('silver_experience_requirements') }}

)

select
    sp.keyword,
    count(distinct sp.job_url) as posting_count,
    round(100.0 * count(distinct sp.job_url) / t.total_postings, 1) as pct,
    -- experience asked for by postings mentioning this skill; null
    -- years_min means the posting never stated a number, so these are
    -- averages over the postings that did
    round(avg(e.years_min), 1) as avg_years_min,
    percentile_approx(e.years_min, 0.5) as median_years_min,
    count(e.years_min) as postings_with_experience_stated
from skill_postings sp
cross join total t
left join experience e on sp.job_url = e.job_url
group by sp.keyword, t.total_postings
order by posting_count desc
