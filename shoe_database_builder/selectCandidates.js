export async function getResearchCandidates(db, limit = 2) {
  const sql = `
    with candidate_deals as (
      select
        d.brand,
        d.model,
        coalesce(nullif(lower(d.gender), ''), 'unknown') as gender,
        d.surface,
        max(d.scraped_at) as latest_seen_at,
        count(*) as deal_count
      from sb_shoe_deals d
      where coalesce(trim(d.brand), '') <> ''
        and coalesce(trim(d.model), '') <> ''
      group by d.brand, d.model, coalesce(nullif(lower(d.gender), ''), 'unknown'), d.surface
    ),
    missing as (
      select c.*
      from candidate_deals c
      left join sb_shoe_database s
        on lower(s.brand) = lower(c.brand)
       and lower(s.model) = lower(c.model)
       and lower(s.gender) = lower(c.gender)
      where s.id is null
    )
    select *
    from missing
    order by latest_seen_at desc, deal_count desc
    limit $1;
  `;

  const { rows } = await db.query(sql, [limit]);
  return rows;
}
