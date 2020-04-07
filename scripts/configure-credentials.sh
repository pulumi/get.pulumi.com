#! /bin/bash
#
# Set the environment variables to use the right AWS account/identity
# based on the current branch.

if [ -z "${TRAVIS_BRANCH:-}" ]; then
    echo "WARNING: TRAVIS_BRANCH not set. Aborting."
fi

# When running on CI, which stack should we update? (And as a result, which
# set of credentials should we be using?)
#
# Using TRAVIS_BRANCH "just works in most cases. For "push" jobs directly
# to "staging" or "production" will target the right environment, otherwise
# will default to testing for pushes to "master" or feature branches.
# (Since for "push" jobs TRAVIS_BRANCH is the name of the branch pushed to.)
#
# If the Travis job type is "pull_request", then we want the environment to
# target to match the branch the pull request will be merged _into_. For
# example, a pull request to be merged into the staging branch should target
# the staging environment. (For "pull_request" jobs TRAVIS_BRANCH is the name
# of the branch targeted in the pull request.)
#
# For pushes to other topic branches (e.g. "joe/feature-x") we don't do anything,
# since we don't expect to be touching cloud resources.

export AWS_ACCESS_KEY_ID="${CI_AWS_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${CI_AWS_SECRET_ACCESS_KEY}"

case ${TRAVIS_BRANCH} in
    master)
        export AWS_ASSUME_ROLE_ARN="${CI_STAGING_ROLE_ARN}"
        ;;
    production)
        export AWS_ASSUME_ROLE_ARN="${CI_PRODUCTION_ROLE_ARN}"
        ;;
    *)
        echo "WARNING: Did not recognize TRAVIS_BRANCH (${TRAVIS_BRANCH}), defaulting to staging."
        export AWS_ASSUME_ROLE_ARN="${CI_STAGING_ROLE_ARN}"
        ;;
esac

# Create a default config for AWS
aws configure set aws_access_key_id $AWS_ACCESS_KEY_ID
aws configure set aws_secret_access_key $AWS_SECRET_ACCESS_KEY
aws configure set region "${AWS_REGION:-us-west-2}"

echo "Travis information         :"
echo "TRAVIS_BRANCH              : ${TRAVIS_BRANCH}"
echo "TRAVIS_EVENT_TYPE          : ${TRAVIS_EVENT_TYPE}"
echo "TRAVIS_JOB_NUMBER          : ${TRAVIS_JOB_NUMBER}"
echo "TRAVIS_PULL_REQUEST_BRANCH : ${TRAVIS_PULL_REQUEST_BRANCH}"

echo "AWS credentials           :"
echo "AWS_ACCESS_KEY_ID         : ${AWS_ACCESS_KEY_ID}"
echo "AWS_ASSUME_ROLE_ARN       : ${AWS_ASSUME_ROLE_ARN}"

echo "Current AWS identity:"
aws sts get-caller-identity
