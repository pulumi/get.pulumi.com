#! /bin/bash
#
# Run the CI/CD workflow the Pulumi stack associated with this repo.
#
# This script should be called from the root of the repository, and will infer
# all it needs from environment variables.

set -o nounset -o errexit -o pipefail

# Use the AWS access key passed to Travis CI to assume role into the AWS account
# where the stack's resources are housed.
export AWS_ACCESS_KEY_ID="${CI_AWS_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${CI_AWS_SECRET_ACCESS_KEY}"

# The TRAVIS_BRANCH environment variable has different meanings depending on the job type.
# For "push" jobs, it is the branch that was pushed to. For "pull_request" jobs, it is the
# branch that the pull request will be _merged_ into. In either case, we use the environment
# variable to determine which stack and AWS account to use.
#
# The TRAVIS_EVENT_TYPE indicates how the job was triggered. For "push" jobs (e.g. code has
# been committed) we want to update the target stack. For "pull_request" jobs we want to
# preview changes.
#
# We switch against both to figure out what we should do.

# The "get-pulumi-com" project has two stacks:
# - pulumi/get-pulumi-com/staging, which is updated on pushes to the "master" branch.
# - pulumi/get-pulumi-com/production, which is updated on pushes to the "production" branch.
echo "Inferring what to do from '${TRAVIS_EVENT_TYPE}-${TRAVIS_BRANCH}'..."
case "${TRAVIS_EVENT_TYPE}-${TRAVIS_BRANCH}" in
    # Push jobs trigger updates.
    "push-master")
        export ACTION="update"
        export AWS_ASSUME_ROLE_ARN="${CI_STAGING_ROLE_ARN}"
        export TARGET_STACK="pulumi/get-pulumi-com/staging"
        ;;
    "push-production")
        export ACTION="update"
        export AWS_ASSUME_ROLE_ARN="${CI_PRODUCTION_ROLE_ARN}"
        export TARGET_STACK="pulumi/get-pulumi-com/production"
        ;;
    "push-*")
        echo "Push job for an unknown branch. Ignoring."
        exit 0
        ;;

    # Pull requests trigger previews.
    "pull_request-master")
        export ACTION="preview"
        export AWS_ASSUME_ROLE_ARN="${CI_STAGING_ROLE_ARN}"
        export TARGET_STACK="pulumi/get-pulumi-com/staging"
        ;;
    "pull_request-production")
        export ACTION="preview"
        export AWS_ASSUME_ROLE_ARN="${CI_PRODUCTION_ROLE_ARN}"
        export TARGET_STACK="pulumi/get-pulumi-com/production"
        ;;
    "pull_request-*")
        echo "Pull Request which will be merged into an unknown branch. Ignoring."
        exit 0
        ;;

    # Some other Travis job type, ignore.
    *)
        echo "Ignoring other Travis CI job type. Ignoring."
        exit 0
        ;;
esac

echo "Inferred CI Operation"
echo "ACTION              : ${ACTION}"
echo "AWS_ASSUME_ROLE_ARN : ${AWS_ASSUME_ROLE_ARN}"
echo "TARGET_STACK        : ${TARGET_STACK}"
echo ""

aws configure set aws_access_key_id $AWS_ACCESS_KEY_ID
aws configure set aws_secret_access_key $AWS_SECRET_ACCESS_KEY
aws configure set region "${AWS_REGION:-us-west-2}"

# Assume the desired IAM Role. Note that we pass the target stack name as the
# external-id, in case that is required by the particular Role.
readonly CREDS_JSON=$(aws sts assume-role \
                 --role-arn "${AWS_ASSUME_ROLE_ARN}" \
                 --role-session-name "get.pulumi.com-travis-job-${TRAVIS_JOB_NUMBER}" \
                 --external-id "${TARGET_STACK}")

export AWS_ACCESS_KEY_ID=$(echo "${CREDS_JSON}"     | jq ".Credentials.AccessKeyId" --raw-output)
export AWS_SECRET_ACCESS_KEY=$(echo "${CREDS_JSON}" | jq ".Credentials.SecretAccessKey" --raw-output)
export AWS_SESSION_TOKEN=$(echo "${CREDS_JSON}"     | jq ".Credentials.SessionToken" --raw-output)

echo "AWS identity:"
aws sts get-caller-identity

# Run Pulumi!

cd infrastructure
yarn install

pulumi stack select "${TARGET_STACK}"

case ${ACTION} in
    "preview")
        pulumi preview --diff
        ;;
    "update")
        pulumi up --yes
        ;;
    *)
        echo "ERROR: Unknown ACTION."
        exit 1
esac

echo "All done!"
