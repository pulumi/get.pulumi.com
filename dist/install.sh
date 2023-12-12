#!/bin/sh
set -e

RESET="\\033[0m"
RED="\\033[31;1m"
GREEN="\\033[32;1m"
YELLOW="\\033[33;1m"
BLUE="\\033[34;1m"
WHITE="\\033[37;1m"

print_unsupported_platform()
{
    >&2 say_red "error: We're sorry, but it looks like Pulumi is not supported on your platform"
    >&2 say_red "       We support 64-bit versions of Linux and macOS and are interested in supporting"
    >&2 say_red "       more platforms.  Please open an issue at https://github.com/pulumi/pulumi and"
    >&2 say_red "       let us know what platform you're using!"
}

say_green()
{
    [ -z "${SILENT}" ] && printf "%b%s%b\\n" "${GREEN}" "$1" "${RESET}"
    return 0
}

say_red()
{
    printf "%b%s%b\\n" "${RED}" "$1" "${RESET}"
}

say_yellow()
{
    [ -z "${SILENT}" ] && printf "%b%s%b\\n" "${YELLOW}" "$1" "${RESET}"
    return 0
}

say_blue()
{
    [ -z "${SILENT}" ] && printf "%b%s%b\\n" "${BLUE}" "$1" "${RESET}"
    return 0
}

say_white()
{
    [ -z "${SILENT}" ] && printf "%b%s%b\\n" "${WHITE}" "$1" "${RESET}"
    return 0
}

at_exit()
{
    # shellcheck disable=SC2181
    # https://github.com/koalaman/shellcheck/wiki/SC2181
    # Disable because we don't actually know the command we're running
    if [ "$?" -ne 0 ]; then
        >&2 say_red
        >&2 say_red "We're sorry, but it looks like something might have gone wrong during installation."
        >&2 say_red "If you need help, please join us on https://slack.pulumi.com/"
    fi
}

trap at_exit EXIT

VERSION=""
SILENT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            if [ "$2" != "latest" ]; then
                VERSION=$2
            fi
            ;;
        --silent)
            SILENT="--silent"
            ;;
     esac
     shift
done

if [ "${VERSION}" = "dev" ]; then
    if ! VERSION=$(curl --retry 3 --fail --silent -L "https://www.pulumi.com/latest-dev-version"); then
        >&2 say_red "error: could not determine latest dev version of Pulumi, try passing --version X.Y.Z to"
        >&2 say_red "       install an explicit version, or no argument to get the latest release version"
        exit 1
    fi
fi

if [ -z "${VERSION}" ]; then

    # Query pulumi.com/latest-version for the most recent release. Because this approach
    # is now used by third parties as well (e.g., GitHub Actions virtual environments),
    # changes to this API should be made with care to avoid breaking any services that
    # rely on it (and ideally be accompanied by PRs to update them accordingly). Known
    # consumers of this API include:
    #
    # * https://github.com/actions/virtual-environments
    #

    if ! VERSION=$(curl --retry 3 --fail --silent -L "https://www.pulumi.com/latest-version"); then
        >&2 say_red "error: could not determine latest version of Pulumi, try passing --version X.Y.Z to"
        >&2 say_red "       install an explicit version"
        exit 1
    fi
fi

OS=""
case $(uname) in
    "Linux") OS="linux";;
    "Darwin") OS="darwin";;
    *)
        print_unsupported_platform
        exit 1
        ;;
esac

ARCH=""
case $(uname -m) in
    "x86_64") ARCH="x64";;
    "arm64") ARCH="arm64";;
    "aarch64") ARCH="arm64";;
    *)
        print_unsupported_platform
        exit 1
        ;;
esac

TARBALL_URL="https://github.com/pulumi/pulumi/releases/download/v${VERSION}/"
TARBALL_URL_FALLBACK="https://get.pulumi.com/releases/sdk/"
TARBALL_PATH=pulumi-v${VERSION}-${OS}-${ARCH}.tar.gz

if ! command -v pulumi >/dev/null; then
    say_blue "=== Installing Pulumi v${VERSION} ==="
else
    say_blue "=== Upgrading Pulumi $(pulumi version) to v${VERSION} ==="
fi

TARBALL_DEST=$(mktemp -t pulumi.tar.gz.XXXXXXXXXX)

download_tarball() {
    # Try to download from github first, then fallback to get.pulumi.com
    say_white "+ Downloading ${TARBALL_URL}${TARBALL_PATH}..."
    # This should opportunistically use the GITHUB_TOKEN to avoid rate limiting
    # ...I think. It's hard to test accurately. But it at least doesn't seem to hurt.
    if ! curl --fail ${SILENT} -L \
        --header "Authorization: Bearer $GITHUB_TOKEN" \
        -o "${TARBALL_DEST}" "${TARBALL_URL}${TARBALL_PATH}"; then
        say_white "+ Error encountered, falling back to ${TARBALL_URL_FALLBACK}${TARBALL_PATH}..."
        if ! curl --retry 2 --fail ${SILENT} -L -o "${TARBALL_DEST}" "${TARBALL_URL_FALLBACK}${TARBALL_PATH}"; then
            return 1
        fi
    fi
}

if download_tarball; then
    say_white "+ Extracting to $HOME/.pulumi/bin"

    # If `~/.pulumi/bin` exists, remove previous files with a pulumi prefix
    if [ -e "${HOME}/.pulumi/bin/pulumi" ]; then
        rm "${HOME}/.pulumi/bin"/pulumi*
    fi

    mkdir -p "${HOME}/.pulumi"

    # Yarn's shell installer does a similar dance of extracting to a temp
    # folder and copying to not depend on additional tar flags
    EXTRACT_DIR=$(mktemp -dt pulumi.XXXXXXXXXX)
    tar zxf "${TARBALL_DEST}" -C "${EXTRACT_DIR}"

    # Our tarballs used to have a top level bin folder, so support that older
    # format if we detect it. Newer tarballs just have all the binaries in
    # the top level Pulumi folder.
    if [ -d "${EXTRACT_DIR}/pulumi/bin" ]; then
        mv "${EXTRACT_DIR}/pulumi/bin" "${HOME}/.pulumi/"
    else
        cp -r "${EXTRACT_DIR}/pulumi/." "${HOME}/.pulumi/bin/"
    fi

    rm -f "${TARBALL_DEST}"
    rm -rf "${EXTRACT_DIR}"
else
    >&2 say_red "error: failed to download ${TARBALL_URL}"
    >&2 say_red "       check your internet and try again; if the problem persists, file an"
    >&2 say_red "       issue at https://github.com/pulumi/pulumi/issues/new/choose"
    exit 1
fi

# Now that we have installed Pulumi, if it is not already on the path, let's add a line to the
# user's profile to add the folder to the PATH for future sessions.
if ! command -v pulumi >/dev/null; then
    # If we can, we'll add a line to the user's .profile adding $HOME/.pulumi/bin to the PATH
    SHELL_NAME=$(basename "${SHELL}")
    PROFILE_FILE=""

    case "${SHELL_NAME}" in
        "bash")
            # Terminal.app on macOS prefers .bash_profile to .bashrc, so we prefer that
            # file when trying to put our export into a profile. On *NIX, .bashrc is
            # preferred as it is sourced for new interactive shells.
            if [ "$(uname)" != "Darwin" ]; then
                if [ -e "${HOME}/.bashrc" ]; then
                    PROFILE_FILE="${HOME}/.bashrc"
                elif [ -e "${HOME}/.bash_profile" ]; then
                    PROFILE_FILE="${HOME}/.bash_profile"
                fi
            else
                if [ -e "${HOME}/.bash_profile" ]; then
                    PROFILE_FILE="${HOME}/.bash_profile"
                elif [ -e "${HOME}/.bashrc" ]; then
                    PROFILE_FILE="${HOME}/.bashrc"
                fi
            fi
            ;;
        "zsh")
            if [ -e "${ZDOTDIR:-$HOME}/.zshrc" ]; then
                PROFILE_FILE="${ZDOTDIR:-$HOME}/.zshrc"
            fi
            ;;
    esac

    if [ -n "${PROFILE_FILE}" ]; then
        LINE_TO_ADD="export PATH=\$PATH:\$HOME/.pulumi/bin"
        if ! grep -q "# add Pulumi to the PATH" "${PROFILE_FILE}"; then
            say_white "+ Adding \$HOME/.pulumi/bin to \$PATH in ${PROFILE_FILE}"
            printf "\\n# add Pulumi to the PATH\\n%s\\n" "${LINE_TO_ADD}" >> "${PROFILE_FILE}"
        fi

        EXTRA_INSTALL_STEP="+ Please restart your shell or add $HOME/.pulumi/bin to your \$PATH"
    else
        EXTRA_INSTALL_STEP="+ Please add $HOME/.pulumi/bin to your \$PATH"
    fi
elif [ "$(command -v pulumi)" != "$HOME/.pulumi/bin/pulumi" ]; then
    say_yellow
    say_yellow "warning: Pulumi has been installed to $HOME/.pulumi/bin, but it looks like there's a different copy"
    say_yellow "         on your \$PATH at $(dirname "$(command -v pulumi)"). You'll need to explicitly invoke the"
    say_yellow "         version you just installed or modify your \$PATH to prefer this location."
fi

say_blue
say_blue "=== Pulumi is now installed! 🍹 ==="
if [ "$EXTRA_INSTALL_STEP" != "" ]; then
    say_white "${EXTRA_INSTALL_STEP}"
fi
say_green "+ Get started with Pulumi: https://www.pulumi.com/docs/quickstart"
