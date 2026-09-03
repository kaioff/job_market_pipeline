-- "Skills that show up alongside this one": for each skill, the other
-- skills most often mentioned in the same posting.
--
-- pct_of_skill_postings is the share of *this skill's* postings that also
-- mention the related skill -- e.g. 'airflow' with pct 62 under 'python'
-- means 62% of postings mentioning python also mention airflow. Capped at
-- the top 15 per skill, which is more than any UI panel will show.

with skill_postings as (

    select job_url, keyword
    from {{ ref('silver_posting_keywords') }}

),

skill_totals as (

    select keyword, count(distinct job_url) as skill_postings
    from skill_postings
    group by keyword

),

pairs as (

    select
        a.keyword,
        b.keyword as related_keyword,
        count(distinct a.job_url) as co_posting_count
    from skill_postings a
    inner join skill_postings b
        on a.job_url = b.job_url
       and a.keyword != b.keyword
    group by a.keyword, b.keyword

)

select
    p.keyword,
    p.related_keyword,
    p.co_posting_count,
    round(100.0 * p.co_posting_count / t.skill_postings, 1) as pct_of_skill_postings
from pairs p
inner join skill_totals t on p.keyword = t.keyword
qualify row_number() over (
    partition by p.keyword
    order by p.co_posting_count desc
) <= 15
