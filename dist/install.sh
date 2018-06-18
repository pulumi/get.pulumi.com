#!/bin/sh
set -e

RESET="\\033[0m"
RED="\\033[31m"
GREEN="\\033[32m"
YELLOW="\\033[33m"

print_unsupported_platform()
{
        >&2 say_red "error: We're sorry to say that it looks like Pulumi is not supported on your platform"
        >&2 say_red "       we support 64 bit versions of Linux and macOS but we're interested in supporting"
        >&2 say_red "       more platforms.  Please open an issue at https://github.com/pulumi/pulumi and"
        >&2 say_red "       let us know what platform you're using!"
}

say_green()
{
    printf "%b%s%b\\n" "${GREEN}" "$1" "${RESET}"
}

say_red()
{
    printf "%b%s%b\\n" "${RED}" "$1" "${RESET}"
}

say_yellow()
{
    printf "%b%s%b\\n" "${YELLOW}" "$1" "${RESET}"
}

VERSION=""
if [ "$1" = "--version" ]; then
    VERSION=$2
else
    if ! VERSION=$(curl --fail --silent -L "https://pulumi.io/latest-version"); then
        say_red "error: could not determine latest version of Pulumi, try passing --version X.Y.Z to"
        say_red "       install an explicit version"
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

if [ "$(uname -m)" != "x86_64" ]; then
        print_unsupported_platform
        exit 1
fi

TARBALL_URL="https://get.pulumi.com/releases/sdk/pulumi-v${VERSION}-${OS}-x64.tar.gz"

say_green "+ Downloading Pulumi from ${TARBALL_URL}"

TARBALL_DEST=$(mktemp -t pulumi.tar.gz.XXXXXXXXXX)

if curl --fail -L -o "${TARBALL_DEST}" "${TARBALL_URL}"; then
    say_green "+ Extracting Pulumi to $HOME/.pulumi/bin"

    # If `~/.pulumi/bin exists, clear it out
    if [ -e "${HOME}/.pulumi/bin" ]; then
        rm -rf "${HOME}/.pulumi/bin"
    fi

    mkdir -p "${HOME}/.pulumi"

    # Yarn's shell installer does a similar dance of extracting to a temp
    # folder and copying to not depend on additional tar flags
    EXTRACT_DIR=$(mktemp -d pulumi.XXXXXXXXXX)
    tar zxf "${TARBALL_DEST}" -C "${EXTRACT_DIR}"
    mv "${EXTRACT_DIR}/pulumi/bin" "${HOME}/.pulumi/"

    rm -f "${TARBALL_DEST}"
    rm -rf "${EXTRACT_DIR}"
else
    say_red "serror: failed to download ${TARBALL_URL}"
    exit 1
fi

# If we can, we'll add a line to the user's .profile adding $HOME/.pulumi/bin to the PATH
SHELL_NAME=$(basename "${SHELL}")
PROFILE_FILE=""

case "${SHELL_NAME}" in
    "bash")
        # Terminal.app on macOS prefers .bash_profile to .bashrc, so we prefer that
        # file when trying to put our export into a profile. On *NIX, .bashrc is
        # prefered as it is sourced for new interactive shells.
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
        if [ -e "${HOME}/.zshrc" ]; then
            PROFILE_FILE="${HOME}/.zshrc"
        fi
        ;;
esac

if [ ! -z "${PROFILE_FILE}" ]; then
    LINE_TO_ADD="export PATH=\$PATH:\$HOME/.pulumi/bin"
    if ! grep -q "${LINE_TO_ADD}" "${PROFILE_FILE}"; then
        say_green "+ Adding \$HOME/.pulumi/bin to \$PATH in ${PROFILE_FILE}"
        printf "\\n# add Pulumi to the PATH\\n%s\\n" "${LINE_TO_ADD}" >> "${PROFILE_FILE}"
    fi

    say_green "+ Pulumi has been installed! Please restart your shell, or add add $HOME/.pulumi/bin to your \$PATH, to start using it"
else
    say_green "+ Pulumi has been installed! Please add $HOME/.pulumi/bin to your \$PATH to start using it"
fi
