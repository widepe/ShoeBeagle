const sql = `
  with candidate_deals as (
    select
      d.brand,
      d.model,
      coalesce(nullif(lower(d.gender), ''), 'unknown') as gender,
      coalesce(nullif(lower(d.surface), ''), 'unknown') as surface,

      min(d.listing_name) as sample_listing_name,
      min(d.listing_url) as sample_listing_url,
      min(d.image_url) as sample_image_url,
      min(d.store) as sample_store,

      max(d.scraped_at) as latest_seen_at,
      count(*) as deal_count,

      (
        lower(trim(coalesce(d.brand, ''))) || '|' ||
        lower(trim(coalesce(d.model, ''))) || '|' ||
        lower(trim(coalesce(nullif(d.gender, ''), 'unknown')))
      ) as normalized_key

    from sb_shoe_deals d

    where coalesce(trim(d.brand), '') <> ''
      and coalesce(trim(d.model), '') <> ''

    group by
      d.brand,
      d.model,
      coalesce(nullif(lower(d.gender), ''), 'unknown'),
      coalesce(nullif(lower(d.surface), ''), 'unknown')
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
  order by latest_seen_at desc nulls last, deal_count desc
  limit $1;
`;
