This is a [Cloudflare Worker](https://developers.cloudflare.com/workers/) that functions similar to [Sippy](https://developers.cloudflare.com/r2/data-migration/sippy/#_top).

The worker will try to serve files from 3 different tiers in order

   Cache  ->  R2  ->  S3

When serving from S3, objects will be pulled into R2 and the cache.

## Development

Worker development benefits from the [wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

To run a dev version:

 * npx wrangler dev --remote

To deploy a new version of the worker:

 * npx wrangler deploy

To tail live logs:

 * npx wrangler tail
