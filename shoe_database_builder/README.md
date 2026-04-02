# shoe_database_builder

First working ingestion pipeline for building `sb_shoe_database` and `sb_shoe_evidence` from `sb_shoe_deals`.

## What it does

- selects shoes in `sb_shoe_deals` that do not yet exist in `sb_shoe_database`
- processes 2 shoes per run by default
- fetches the retailer page from `sample_listing_url`
- sends snippets to OpenAI for structured extraction
- inserts one canonical row into `sb_shoe_database`
- inserts evidence rows into `sb_shoe_evidence`
- backfills `sb_shoe_deals.shoe_id`

## Required env vars

```bash
DATABASE_URL=your_neon_connection_string
OPENAI_API_KEY=your_openai_api_key
