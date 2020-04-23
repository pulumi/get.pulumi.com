// Copyright 2016-2018, Pulumi Corporation.  All rights reserved.

import * as fs from "fs";
import * as mime from "mime";
import * as path from "path";

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const cfg = new pulumi.Config(pulumi.getProject());

const subDomain = "get";
const domain = cfg.require("domain");
const fullDomain = `${subDomain}.${domain}`;
const certificateArn = cfg.require("certificateArn");

const contentBucket = new aws.s3.Bucket(`${fullDomain}-bucket`, {
    bucket: fullDomain,
    acl: "public-read",
});

// contentBucket needs to have the "public-read" ACL so its contents can be ready by CloudFront and
// served. But we deny the s3:ListBucket permission to prevent unintended disclosure of the bucket's
// contents.
aws.getCallerIdentity().then((callerIdentity) => {
    const denyListPolicyState: aws.s3.BucketPolicyArgs = {
        bucket: contentBucket.bucket,
        policy: contentBucket.arn.apply((arn: string) => JSON.stringify({
            Version: "2008-10-17",
            Statement: [
                {
                    Effect: "Deny",
                    Principal: "*",
                    Action: "s3:ListBucket",
                    Resource: arn,
                    Condition: {
                        StringNotEquals: {
                            "aws:PrincipalAccount": callerIdentity.accountId,
                        },
                    },
                },
            ],
        })),
    };

    const denyListPolicy = new aws.s3.BucketPolicy("deny-list", denyListPolicyState);
});

const logsBucket = new aws.s3.Bucket(`${fullDomain}-logs`, {
    acl: "log-delivery-write",
});

// Times, in seconds.
const oneHour = 60 * 60;
const oneDay = 24 * oneHour;

// Faux configuration for the "rel.pulumi.com" S3 bucket. It isn't managed by this stack, and only exists in
// the production AWS account. (So `aws.s3.Bucket.get` is frought with peril.)
const releaseBucketState = {
    // String to uniquely identify the bucket as a "target origin ID" when configuring the CloudFront distribution.
    originId: "S3-rel.pulumi.com",
    // Domain name of the S3 bucket, which CloudFront will use to read its contents.
    domainName: "rel.pulumi.com.s3.us-west-2.amazonaws.com",
};

// Returns a CloudFront cache behavior serving content via `releaseBucketState`.
function serveFromReleasesBucket(pathPattern: string): aws.types.input.cloudfront.DistributionOrderedCacheBehavior {
    return {
        // Pattern, e.g. images/*.jpg, that the behavior belongs to.
        pathPattern: pathPattern,

        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        forwardedValues: {
            cookies: {
                forward: "none",
            },
            queryString: false,
        },
        targetOriginId: releaseBucketState.originId,
        viewerProtocolPolicy: "redirect-to-https",
        minTtl: 0,
        defaultTtl: oneHour,
        maxTtl: oneDay,
        compress: true,
    };
}

// Unique CloudFront identity we associate with the s3://rel.pulumi.com origin in the CDN. This will
// allow us to grant just CloudFront access to the bucket's contents (and not need to make the contents
// publicly visible). See: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html
const releasesBucketOai = new aws.cloudfront.OriginAccessIdentity("releasesBucketOAI", {
    comment: `CloudFront Origin Access Identity for the get.pulumi.com (${pulumi.getStack()} stack)`,
});
export const originAccessIdentity = releasesBucketOai.iamArn;

const distributionArgs: aws.cloudfront.DistributionArgs = {
    aliases: [fullDomain],
    // An ordered list of cache behaviors, in precidence order.
    orderedCacheBehaviors: [
        serveFromReleasesBucket("/releases/plugins/*"),
        serveFromReleasesBucket("/releases/sdk/*"),
    ],
    // Last cache behavior, in case no other behavior matched.
    // Serve everything else from the "get.pulumi.com" content bucket.
    defaultCacheBehavior: {
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        forwardedValues: {
            cookies: {
                forward: "none",
            },
            queryString: false,
        },
        targetOriginId: contentBucket.bucketDomainName.apply(d => `S3-${d}`),
        viewerProtocolPolicy: "redirect-to-https",
        minTtl: 0,
        defaultTtl: oneHour, // Default is one day.
        maxTtl: oneDay,  // Default is one year.
        compress: true,
    },
    enabled: true,
    origins: [
        // S3-<content-bucket-name>, where we serve most get.pulumi.com content.
        {
            domainName: contentBucket.bucketDomainName,
            originId: contentBucket.bucketDomainName.apply(d => `S3-${d}`),
        },
        // The s3://rel.pulumi.com, where we publish plugins and SDK releases to.
        // This stack doesn't manage that bucket, and it may even exist in a different
        // AWS account. We just hook things up so that the "S3-rel.pulumi.com" origin
        // will route to that bucket's contents. (Which we assume are readable, etc.)
        {
            domainName: releaseBucketState.domainName,
            originId: releaseBucketState.originId,
            // IMPORTANT: Unlike `contentBucket`, objects aren't inheritly world readable. So
            // we need to create an "Origin Access Identity" for Cloud Front. This identity
            // then needs to be granted access on the rel.pulumi.com Bucket's access policy.
            s3OriginConfig: {
                originAccessIdentity: releasesBucketOai.cloudfrontAccessIdentityPath,
            },
        },
    ],
    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },
    viewerCertificate: {
        acmCertificateArn: certificateArn,
        sslSupportMethod: "sni-only",
        minimumProtocolVersion: "TLSv1_2016",
    },
    loggingConfig: {
        bucket: logsBucket.bucketDomainName,
        includeCookies: false,
        prefix: `${fullDomain}/`,
    },
    defaultRootObject: "install.sh",
};

const cloudfront = new aws.cloudfront.Distribution(`${fullDomain}-cf`, distributionArgs, { dependsOn: [releasesBucketOai] });

const record = new aws.route53.Record(`${fullDomain}-record`, {
    name: subDomain,
    type: "A",
    zoneId: aws.route53.getZone({ name: domain }).then(x => x.zoneId),
    aliases: [
        {
            name: cloudfront.domainName,
            zoneId: cloudfront.hostedZoneId,
            evaluateTargetHealth: false,
        },
    ],
});

// Upload all the files in ../dist. We force the Content-Type header to text/plain so it renders nicely in a web
// browser when you view the page directly (for example, to inspect the script).
const distRoot = path.join("..", "dist");

for (let entry of fs.readdirSync(distRoot)) {
    const entryPath = path.join(distRoot, entry);
    if (fs.statSync(entryPath).isFile()) {
        // tslint:disable-next-line
        new aws.s3.BucketObject(entry, {
            bucket: contentBucket,
            contentType: "text/plain",
            source: new pulumi.asset.FileAsset(entryPath),
            acl: "public-read",
        });
    }
}

// Upload all the files in ../dist/new. We use the mime library to determine the Content-Type header of each file.
const distNewRoot = path.join(distRoot, "new");

for (let entry of fs.readdirSync(distNewRoot)) {
    const entryPath = path.join(distNewRoot, entry);
    if (fs.statSync(entryPath).isFile()) {
        // tslint:disable-next-line
        new aws.s3.BucketObject("new/" + entry, {
            bucket: contentBucket,
            contentType: mime.getType(entryPath) || undefined,
            source: new pulumi.asset.FileAsset(entryPath),
            acl: "public-read",
        });
    }
}
