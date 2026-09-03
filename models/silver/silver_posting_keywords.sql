-- Posting-level skill membership: one row per (job_url, skill) match.
--
-- linkedin_keyword_snapshots only carries daily aggregate counts per
-- keyword, with no link back to individual postings, so it can't answer
-- "which postings mention Python" or "what else shows up alongside
-- Python". This model derives that link by matching a curated skill
-- vocabulary against each posting's description text.
--
-- Why a curated seed instead of the extracted keywords: the upstream
-- extraction does generic noun-phrase extraction, not skill recognition,
-- so its vocabulary is roughly half boilerplate ('veteran', 'salary
-- range', 'degree', 'hands-on experience'). Blocklisting that via
-- noise_terms() is endless whack-a-mole, since every new batch of
-- postings brings new junk. The seed inverts it: nothing unlisted can
-- enter, aliases are handled explicitly ('amazon web services' -> aws),
-- and the smaller vocabulary makes the downstream co-occurrence join
-- dramatically cheaper. Cost: a genuinely new technology has to be added
-- to seeds/skills.csv to show up here.
--
-- Matching is case-insensitive and word-boundary aware, so 'go' won't
-- match inside 'google'. Symbol-heavy skills ('c++', 'c#', 'node.js')
-- fall back to a plain literal containment check, since \b doesn't apply
-- around non-word characters.

with skill_terms as (

    -- one row per searchable term: the canonical skill name plus each of
    -- its aliases, all mapping back to the canonical skill
    select
        skill,
        category,
        lower(trim(term)) as term
    from (
        select
            skill,
            category,
            explode(
                split(concat_ws('|', skill, coalesce(aliases, '')), '\\|')
            ) as term
        from {{ ref('skills') }}
    )
    where trim(term) != ''

),

postings as (

    select job_url, lower(description_text) as description_lower
    from {{ ref('silver_linkedin_postings') }}
    where description_text is not null

),

matched as (

    select
        p.job_url,
        s.skill,
        s.category
    from postings p
    cross join skill_terms s
    where
        case
            -- word characters at both ends -> a word-boundary match is
            -- meaningful; otherwise ('c++', 'node.js', 'ci/cd') fall back
            -- to a plain literal containment check
            when s.term rlike '^\\w.*\\w$|^\\w$'
                then p.description_lower rlike concat(
                    '(?i)\\b',
                    regexp_replace(s.term, '([\\+\\*\\?\\.\\(\\)\\[\\]\\^\\$\\|\\\\])', '\\\\$1'),
                    '\\b'
                )
            else instr(p.description_lower, s.term) > 0
        end

)

-- distinct collapses the case where a posting matches both the canonical
-- name and one of its aliases
select distinct
    job_url,
    skill as keyword,
    category
from matched
