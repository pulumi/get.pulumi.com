// Copyright 2016-2018, Pulumi Corporation.  All rights reserved.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const subDomain = "get";
const domain = "pulumi.com";
const fullDomain = `${subDomain}.${domain}`;
const certificateArn = "arn:aws:acm:us-east-1:058607598222:certificate/a3f72a2b-e715-4639-b126-1e4efc0b634b";


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
