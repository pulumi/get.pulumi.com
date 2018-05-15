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
    if ! VERSION=$(curl --fail --silent -L "https://docs.pulumi.com/latest-version"); then
        say_red "error: could not determine latest version of Pulumi, try passing --version X.Y.Z to"
        say_red "       install an explicit version"
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

# While we are in closed beta, we have special npm and PyPI registires we want to use
say_green "+ Since Pulumi is in private beta, we need to configure private package sources for both NodeJS and Python."
say_green "+ We'll do this now if you have \`npm\` or \`pip\` installed"

if command -v npm > /dev/null; then
    say_green "+ Registering npmjs.pulumi.com"
    npm config set @pulumi:registry=https://npmjs.pulumi.com/ || {
        say_yellow "+ warning: \`npm config set @pulumi:registry=https://npmjs.pulumi.com/\` failed, you will need to run this manually before using Pulumi with NodeJS. Please see https://docs.pulumi.com/reference/javascript.html for more help"
    }
fi

if command -v pip > /dev/null; then
    say_green "+ Registering pypi.pulumi.com"

    # pip config is new in pip 10.0.0, so try that first
    if pip config list >/dev/null 2>/dev/null; then
        pip config set global.extra-index-url https://pypi.pulumi.com/simple || {
            say_yellow "+ warning: \`pip config set global.extra-index-url https://pypi.pulumi.com/simple\` failed, you will need to run this manually before using Pulumi with Python. Please see https://docs.pulumi.com/reference/python.html for more help"
        }
    else
        # We can't use pip config, so let's add things to pip.conf.

        # First, let's figure out where pip is going to look for its config file.
        PIP_CONFIG_LOCATION="${HOME}/.config/pip"
        if [ "$(uname)" = "Darwin" ] && [ -e "$HOME/Library/Application Support/pip" ]; then
            # per https://pip.pypa.io/en/stable/user_guide/#config-file, on macOS, if $HOME/Library/Application Support/pip exists, the pip config lives there
            PIP_CONFIG_LOCATION="$HOME/Library/Application Support/pip"
        fi

        # When PIP_CONFIG_FILE is unset use it, otherwise set it to `pip.conf` in the directory we infered above.
        if [ -z "${PIP_CONFIG_FILE:-}" ]; then
            PIP_CONFIG_FILE="${PIP_CONFIG_LOCATION}/pip.conf"
        fi

        if [ ! -e "${PIP_CONFIG_FILE}" ]; then
            # Ensure the folder we'll write the PIP configuration to exists
            mkdir -p "$(dirname "${PIP_CONFIG_FILE}")"

            printf "[global]\\nextra-index-url=https://pypi.pulumi.com/simple\\n" > "${PIP_CONFIG_FILE}"
        elif grep -q "extra-index-url=https://pypi.pulumi.com/simple" "${PIP_CONFIG_FILE}"; then
            # If the above test passed, then our extra-index-url is already in the configuration file (perhaps from a previous run of this
            # script) and we have nothing to do.
            true
        else
            say_yellow "+ warning: Sorry, we couldn't automatically add the Pulumi private package index to ${PIP_CONFIG_LOCATION}/pip.conf, so you'll have to do that yourself, before using Pulumi with Python. Please see https://docs.pulumi.com/reference/python.html for more help"
        fi
    fi
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
