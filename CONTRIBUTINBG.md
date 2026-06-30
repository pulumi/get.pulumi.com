# Releasing

Code merged to `master` is deployed to staging on `https://get.pulumi-staging.io`. To release changes to to production, merge the `master` branch into `production`. This will trigger a deployment to `https://get.pulumi.com`.

Additionally, in production there is a Cloudflare cache in front of the site. The cache is stored in the R2 bucket (`get-pulumi-com-mirror` bucket in the `get.pulumi.com` account) and files need to be manually deleted.

For example to update `install.sh`, login to Cloudflare using the credentials in 1Password, go the the `get-pulumi-com` bucket and delete the file `install.sh`. The Cloudflare [worker](https://github.com/pulumi/get.pulumi.com/blob/37dcdeeff875e857d834246376a11d50c63ce099/infrastructure/cloudflare/mirror-worker/src/index.ts#L54-L83) will pull the updated file from the origin on the next request.

Validate with `curl -v https://get.pulumi.com`.
