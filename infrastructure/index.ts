// Copyright 2016-2018, Pulumi Corporation.  All rights reserved.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";
import * as fs from "fs";

const cfg = new pulumi.Config(pulumi.getProject());

const subDomain = "get";
const domain = cfg.require("domain");
const fullDomain = `${subDomain}.${domain}`;
const certificateArn = cfg.require("certificateArn");

const contentBucket = new aws.s3.Bucket(`${fullDomain}-bucket`, {
    bucket: fullDomain,
    acl: "public-read",
});

const logsBucket = new aws.s3.Bucket(`${fullDomain}-logs`, {
    acl: "log-delivery-write",
});

const distributionArgs: aws.cloudfront.DistributionArgs = {
    aliases: [fullDomain],
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
        defaultTtl: 60,
        maxTtl: 60,
    },
    enabled: true,
    origins: [{
        domainName: contentBucket.bucketDomainName,
        originId: contentBucket.bucketDomainName.apply(d => `S3-${d}`),
    }],
    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },
    viewerCertificate: {
        acmCertificateArn: certificateArn,
        sslSupportMethod: "sni-only",
    },
    loggingConfig: {
        bucket: logsBucket.bucketDomainName,
        includeCookies: false,
        prefix: `${fullDomain}/`,
    },
    defaultRootObject: "install.sh",
};

const cloudfront = new aws.cloudfront.Distribution(`${fullDomain}-cf`, distributionArgs);

const record = new aws.route53.Record(`${fullDomain}-record`, {
    name: subDomain,
    type: "A",
    zoneId: aws.route53.getZone({name: domain}).then(x => x.zoneId),
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
