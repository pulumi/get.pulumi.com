// Copyright 2020 Pulumi Corporation. All rights reserved.
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const name = "RewriterLambdaEdge"

const role = new aws.iam.Role(`${name}-Role`, {
    assumeRolePolicy: {
        Version: "2012-10-17",
        Statement: [
            {
                Action: "sts:AssumeRole",
                Principal: aws.iam.Principals.LambdaPrincipal,
                Effect: "Allow",
            },
            {
                Action: "sts:AssumeRole",
                Principal: aws.iam.Principals.EdgeLambdaPrincipal,
                Effect: "Allow",
            },
        ],
    },
});

const rolePolicy = new aws.iam.RolePolicyAttachment(`${name}-RolePolicyAttachment`, {
    role,
    policyArn: aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole,
});

// Some resources _must_ be put in us-east-1, such as Lambda at Edge.
export const awsUsEast1 = new aws.Provider("us-east-1", { region: "us-east-1" });
const lambda = new aws.lambda.CallbackFunction(`${name}-Function`, {
    publish: true,
    role,
    timeout: 5,
    callback: async (event: any, context: aws.lambda.Context) => {
        const request = event.Records[0].cf.request;
        // if the origin request includes a '+' we should rewrite it as '%2B' for S3
        console.log("Recieving request for", request.uri);
        if (request.uri.includes("+")) {
            const old = request.uri;
            const allPlus = /\+/g;
            request.uri = request.uri.replace(allPlus, "%2B");
            console.log(`rewriting request from ${old} to ${request.uri}`);
        }

        return request;
    }
}, { provider: awsUsEast1 });

// Not using qualifiedArn here due to some bugs around sometimes returning $LATEST
export default pulumi.interpolate`${lambda.arn}:${lambda.version}`;
