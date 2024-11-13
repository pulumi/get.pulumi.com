// Copyright 2016-2018, Pulumi Corporation.  All rights reserved.

import * as fs from "fs";
import * as mime from "mime";
import * as path from "path";

import * as aws from "@pulumi/aws";
import * as std from "@pulumi/std";
import * as pulumi from "@pulumi/pulumi";

import requestRewriteLambda, { awsUsEast1 } from "./requestRewriter";

const cfg = new pulumi.Config(pulumi.getProject());

const subDomain = "get";
const domain = cfg.require("domain");
const fullDomain = `${subDomain}.${domain}`;
const certificateArn = cfg.require("certificateArn");
const canonicalUserId = aws.s3.getCanonicalUserId({});
const productionCanonicalId = canonicalUserId.then(user => user.id);
const repoDefaultDescription = "Pulumi’s modern infrastructure as code platform empowers cloud engineering teams to work better together to ship faster using the world’s most popular programming languages. Pulumi works with AWS, Kubernetes, and over 50 cloud infrastructure providers."

const contentBucket = new aws.s3.Bucket(
    `${fullDomain}-bucket`,
    {
        bucket: fullDomain,
        acl: "public-read",
        versioning: {
            enabled: true,
        },
    },
    { protect: true });

// contentBucket needs to have the "public-read" ACL so its contents can be ready by CloudFront and
// served. But we deny the s3:ListBucket permission to prevent unintended disclosure of the bucket's
// contents. We also explicitly grant GetObject, in the event that the per-file ACL isn't set.
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
                {
                    Sid: "PluginsPublicRead",
                    Effect: "Allow",
                    Principal: "*",
                    Action: ["s3:GetObject"],
                    Resource: [`${arn}/releases/plugins/*`],
                },
                {
                    Sid: "SDKPublicRead",
                    Effect: "Allow",
                    Principal: "*",
                    Action: ["s3:GetObject"],
                    Resource: [`${arn}/releases/sdk/*`],
                },
                {
                    Sid: "ESCPublicRead",
                    Effect: "Allow",
                    Principal: "*",
                    Action: ["s3:GetObject"],
                    Resource: [`${arn}/esc/releases/*`],
                },
            ],
        })),
    };

    const denyListPolicy = new aws.s3.BucketPolicy("deny-list", denyListPolicyState);
});

// IAM Role available to CI/CD bots to allow them to upload binaries as part of the release process.
// Previously we copied them to s3://rel.pulumi.com, but we later changed to uploading the binaries
// directly to s3://get.pulumi.com.
const uploadReleaseRole = new aws.iam.Role("PulumiUploadRelease", {
    name: "PulumiUploadRelease",
    description: "Upload new releases of the Pulumi SDK to get.pulumi.com.",
    // The max of 2 hours.
    maxSessionDuration: 2 * 60 * 60,
    assumeRolePolicy: {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Principal: {
                    AWS: [
                        // Pulumi's AWS bastion account. The IAM Users we use for CI/CD will be defined there.
                        "arn:aws:iam::318722933755:root",
                    ],
                },
                Action: "sts:AssumeRole",
                // Block assuming this role unless the external ID matches the following. This
                // isn't a security measure so much as a double-checking intent.
                Condition: {
                    StringEquals: {
                        "sts:ExternalId": [
                            "upload-pulumi-release",
                        ],
                    },
                },
            },
            // Allow the assumer to also set session tags.
            {
                Effect: "Allow",
                Principal: {
                    AWS: [
                        "arn:aws:iam::318722933755:root",
                    ],
                },
                Action: "sts:TagSession",
            },
        ],
    },
    tags: {
        "stack": `${pulumi.getProject()}/${pulumi.getStack()}`,
    },
});

// ARN of the role we need to hook up to our CI bots to enable them to upload releases.
export const uploadReleaseRoleArn = uploadReleaseRole.arn;

const uploadPolicyReleaseContentBucketStatement: aws.iam.PolicyStatement = {
    Effect: "Allow",
    // Only allow uploading data. So `aws s3 cp` or `aws s3 ls` won't work.
    Action: [
        "s3:PutObject",
        "s3:PutObjectAcl",
    ],
    // Only allow uploading objects with certain prefixes.
    Resource: [
        pulumi.interpolate`${contentBucket.arn}/esc/releases/*`,
        pulumi.interpolate`${contentBucket.arn}/releases/plugins/*`,
        pulumi.interpolate`${contentBucket.arn}/releases/sdk/*`,
    ],
};

const uploadPolicyReleaseEcrAuthorizationTokenStatement: aws.iam.PolicyStatement = {
    Effect: "Allow",
    Action: [
        "ecr-public:GetAuthorizationToken",
        "sts:GetServiceBearerToken",
    ],
    Resource: ["*"],
};

interface RepoInfo {
    name: string,
    about?: string,
}

const repositoryNames: RepoInfo[] = [
    { name: "esc", about: "Pulumi ESC container"},
    { name: "pulumi", about: "Pulumi CLI container"},
    { name: "pulumi-dotnet", about: "Pulumi CLI container for dotnet"},
    { name: "pulumi-dotnet-6.0", about: "Pulumi CLI container for dotnet 6.0"},
    { name: "pulumi-dotnet-8.0", about: "Pulumi CLI container for dotnet 8.0"},
    { name: "pulumi-dotnet-9.0", about: "Pulumi CLI container for dotnet 9.0"},
    { name: "pulumi-go", about: "Pulumi CLI container for Go"},
    { name: "pulumi-nodejs", about: "Pulumi CLI container for NodeJS"},
    { name: "pulumi-nodejs-18", about: "Pulumi CLI container for NodeJS 18"},
    { name: "pulumi-nodejs-20", about: "Pulumi CLI container for NodeJS 20"},
    { name: "pulumi-nodejs-22", about: "Pulumi CLI container for NodeJS 22"},
    { name: "pulumi-nodejs-23", about: "Pulumi CLI container for NodeJS 23"},
    { name: "pulumi-python", about: "Pulumi CLI container for Python"},
    { name: "pulumi-python-3.9", about: "Pulumi CLI container for Python 3.9"},
    { name: "pulumi-python-3.10", about: "Pulumi CLI container for Python 3.10"},
    { name: "pulumi-python-3.11", about: "Pulumi CLI container for Python 3.11"},
    { name: "pulumi-python-3.12", about: "Pulumi CLI container for Python 3.12"},
    { name: "pulumi-python-3.13", about: "Pulumi CLI container for Python 3.13"},
    { name: "pulumi-base", about: "Pulumi CLI container base"},
    { name: "pulumi-provider-build-environment"},
    { name: "pulumi-java", about: "Pulumi CLI container for Java"},
    { name: "pulumi-kubernetes-operator", about: 
        "The Pulumi Kubernetes Operator is an extension pattern that enables Kubernetes users to create a Stack as a first-class API resource, and use the StackController to drive the updates of the Stack until success.\n\n" +
        "Deploying Pulumi Stacks in Kubernetes provides the capability to build out CI/CD and automation systems into your clusters, creating native support to manage your infrastructure alongside your Kubernetes workloads."
    },
]

const repos = repositoryNames.map(repoInfo =>
    new aws.ecrpublic.Repository(repoInfo.name, {
        repositoryName: repoInfo.name,
        catalogData: {
            description: repoDefaultDescription,
            aboutText: repoInfo.about || undefined,
            logoImageBlob: std.filebase64({
                input: "pulumi_repo_logo.png",
            }).then(invoke => invoke.result),
        }
    }, { provider: awsUsEast1 }) // Public repos have to be in us-east-1
);

const uploadPolicyReleaseEcrUploadImageStatement: aws.iam.PolicyStatement = {
    Effect: "Allow",
    Action: [
        "ecr-public:BatchCheckLayerAvailability",
        "ecr-public:CompleteLayerUpload",
        "ecr-public:DescribeImages",
        "ecr-public:DescribeImageTags",
        "ecr-public:DescribeRepositories",
        "ecr-public:GetRepositoryPolicy",
        "ecr-public:InitiateLayerUpload",
        "ecr-public:UploadLayerPart",
        "ecr-public:PutImage",
    ],
    Resource: repos.map(repo => repo.arn),
};

// Permissions granted to those who assume the upload releases role.
const uploadReleasePolicy = new aws.iam.Policy("PulumiUploadReleasePolicy", {
    name: "PulumiUploadReleasePolicy",
    description: "Upload Pulumi ",
    policy: {
        Version: "2012-10-17",
        Statement: [
            uploadPolicyReleaseContentBucketStatement,
            uploadPolicyReleaseEcrAuthorizationTokenStatement,
            uploadPolicyReleaseEcrUploadImageStatement,
        ],
    },
});

const rolePolicyAttachment = new aws.iam.RolePolicyAttachment("PulumiUploadReleasePolicyAttachment", {
    role: uploadReleaseRole,
    policyArn: uploadReleasePolicy.arn,
});

const logsBucket = new aws.s3.Bucket(`${fullDomain}-logs`);

const logsBucketOwnershipControl = new aws.s3.BucketOwnershipControls(
    `${fullDomain}-logs-ownership`,
    {
        bucket: logsBucket.id,
        rule: {
            objectOwnership: "BucketOwnerPreferred",
        },
    },
    { dependsOn: logsBucket },
    );

// Add ACL for Data Account to access this bucket

// Data AWS Account Canonical ID
const airflowStackRef = new pulumi.StackReference(`pulumi/dwh-workflows-orchestrate-airflow/production`);
const dataAccountCanonicalID = airflowStackRef.requireOutputValue("dataAccountCanonicalID");

// Constant Canonical ID for cloudfront, documented here:
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/AccessLogs.html
const cloudFrontCanonicalID = "c4c1ede66af53448b93c283ce9448c4ba468c9432aa01d700d3878632f77d2d0";
const logsBucketACL = new aws.s3.BucketAclV2(
    `${fullDomain}-logs-acl`,
    {
        bucket: logsBucket.id,
        accessControlPolicy: {
            grants: [
                {
                    grantee: {
                        type: "Group",
                        uri: "http://acs.amazonaws.com/groups/s3/LogDelivery",
                    },
                    permission: "READ_ACP",
                },
                {
                    grantee: {
                        type: "Group",
                        uri: "http://acs.amazonaws.com/groups/s3/LogDelivery",
                    },
                    permission: "WRITE",
                },
                {
                    grantee: {
                        type: "CanonicalUser",
                        id: cloudFrontCanonicalID,
                    },
                    permission: "FULL_CONTROL",
                },
                {
                    grantee: {
                        type: "CanonicalUser",
                        id: productionCanonicalId,
                    },
                    permission: "FULL_CONTROL",
                },
                {
                    grantee: {
                        type: "CanonicalUser",
                        id: dataAccountCanonicalID,
                    },
                    permission: "READ",
                },
                {
                    grantee: {
                        type: "CanonicalUser",
                        id: dataAccountCanonicalID,
                    },
                    permission: "READ_ACP",
                },
            ],
            owner: {
                id: productionCanonicalId,
            },
        },
    },
    {
        dependsOn: logsBucketOwnershipControl,
    },
);

const buildDateHeaderName: string = "build-date";
const buildDateHeaderValue: string = new Date().valueOf().toString();

const cfViewerRequestFunction = new aws.cloudfront.Function(
    "cf-viewer-request",
    {
        runtime: "cloudfront-js-1.0",
        publish: true,
        code: `function handler(event){
var request = event.request;
request.headers[${JSON.stringify(buildDateHeaderName)}] = {
    value: ${JSON.stringify(buildDateHeaderValue)},
};
return request;
}`,
    },
);

const distributionArgs: aws.cloudfront.DistributionArgs = {
    aliases: [fullDomain],
    defaultCacheBehavior: {
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        forwardedValues: {
            headers: [buildDateHeaderName],
            cookies: {
                forward: "none",
            },
            queryString: false,
        },
        targetOriginId: contentBucket.bucketDomainName.apply(d => `S3-${d}`),
        viewerProtocolPolicy: "redirect-to-https",

        // tslint:disable-next-line:max-line-length
        // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-response-headers-policies.html#managed-response-headers-policies-security
        // tslint:disable-next-line:max-line-length
        responseHeadersPolicyId: "67f7725c-6f97-4210-82d7-5512b31e9d03", // SecurityHeadersPolicy from https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-response-headers-policies.html

        // TTLs. These are used since presumably there aren't any cache control settings
        // for the individual S3 objects.
        minTtl: 0,
        defaultTtl: 604800,  // One week.
        maxTtl: 31536000,  // One year, the default.

        compress: true,

        functionAssociations: [{
            eventType: "viewer-request",
            functionArn: cfViewerRequestFunction.arn,
        }],

        // Include a Lambda to rewrite origin requests including a '+' to using '%2B'
        // since S3 interprets '+' incorrectly
        lambdaFunctionAssociations: [{
            eventType: "origin-request",
            lambdaArn: requestRewriteLambda,
        }],
    },
    enabled: true,
    origins: [{
        domainName: contentBucket.bucketDomainName,
        originId: contentBucket.bucketDomainName.apply(d => `S3-${d}`),
    }],
    // Cache content from all CloudFront edge locations, meaning it will have the
    // best performance. Other price classes restrict some locations, which means
    // you would pay less for hosting the CDN.
    priceClass: "PriceClass_All",
    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },
    viewerCertificate: {
        acmCertificateArn: certificateArn,
        sslSupportMethod: "sni-only",
        minimumProtocolVersion: "TLSv1.2_2018",
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
    zoneId: aws.route53.getZone({ name: domain }).then(x => x.zoneId),
    aliases: [
        {
            name: cloudfront.domainName,
            zoneId: cloudfront.hostedZoneId,
            evaluateTargetHealth: false,
        },
    ],
});

// Upload all the files in ../dist. We force the Content-Type header to text/plain, so it renders nicely in a web
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

// Upload all the files in ../dist/esc. We force the Content-Type header to text/plain, so it renders nicely in a web
// browser when you view the page directly (for example, to inspect the script).
const escRoot = path.join(distRoot, "esc");

for (let entry of fs.readdirSync(escRoot)) {
    const entryPath = path.join(escRoot, entry);
    if (fs.statSync(entryPath).isFile()) {
        // tslint:disable-next-line
        new aws.s3.BucketObject(`esc/${entry}`, {
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
