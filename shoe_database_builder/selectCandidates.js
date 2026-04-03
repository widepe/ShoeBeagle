export async function getResearchCandidates(db, limit = 2) {
  const sql = `
    with base as (
      select
        trim(d.brand) as brand,
        trim(d.model) as model,
        lower(trim(coalesce(nullif(d.gender, ''), 'unknown'))) as gender,
        d.listing_name,
        d.listing_url,
        d.image_url,
        d.store,
        d.scraped_at
      from sb_shoe_deals d
      where coalesce(trim(d.brand), '') <> ''
        and coalesce(trim(d.model), '') <> ''
    ),
    candidate_deals as (
      select
        b.brand,
        b.model,
        b.gender,
        min(b.listing_name) as sample_listing_name,
        min(b.listing_url) as sample_listing_url,
        min(b.image_url) as sample_image_url,
        min(b.store) as sample_store,
        max(b.scraped_at) as latest_seen_at,
        count(*) as deal_count
      from base b
      group by
        b.brand,
        b.model,
        b.gender
    )
    select c.*
    from candidate_deals c
    where not exists (
      select 1
      from sb_shoe_database s
      where lower(trim(s.brand)) = lower(trim(c.brand))
        and lower(trim(s.model)) = lower(trim(c.model))
        and lower(trim(coalesce(nullif(s.gender, ''), 'unknown'))) = lower(trim(c.gender))
    )
    order by c.latest_seen_at desc nulls last, c.deal_count desc, c.brand asc, c.model asc
    limit $1;
  `;

  const { rows } = await db.query(sql, [limit]);
  return rows;
}
