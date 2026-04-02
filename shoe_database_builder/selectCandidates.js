export async function getResearchCandidates(db, limit = 2) {
  const sql = `
    with base as (
      select
        d.brand,
        d.model,
        lower(trim(coalesce(nullif(d.gender, ''), 'unknown'))) as gender,
        lower(trim(coalesce(nullif(d.surface, ''), 'unknown'))) as surface,
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
        b.surface,
        min(b.listing_name) as sample_listing_name,
        min(b.listing_url) as sample_listing_url,
        min(b.image_url) as sample_image_url,
        min(b.store) as sample_store,
        max(b.scraped_at) as latest_seen_at,
        count(*) as deal_count,
        (
          lower(trim(coalesce(b.brand, ''))) || '|' ||
          lower(trim(coalesce(b.model, ''))) || '|' ||
          b.gender
        ) as normalized_key
      from base b
      group by
        b.brand,
        b.model,
        b.gender,
        b.surface
    ),
    missing as (
      select c.*
      from candidate_deals c
      left join sb_shoe_database s
        on lower(trim(s.brand)) = lower(trim(c.brand))
       and lower(trim(s.model)) = lower(trim(c.model))
       and lower(trim(s.gender)) = lower(trim(c.gender))
      where s.id is null
    )
    select *
    from missing
    order by latest_seen_at desc nulls last, deal_count desc, brand asc, model asc
    limit $1;
  `;

  const { rows } = await db.query(sql, [limit]);
  return rows;
}
