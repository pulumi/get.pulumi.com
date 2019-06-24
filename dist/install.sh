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

say_blue()
{
    printf "%b%s%b\\n" "${BLUE}" "$1" "${RESET}"
}

say_white()
{
    printf "%b%s%b\\n" "${WHITE}" "$1" "${RESET}"
}

at_exit()
{
    if [ "$?" -ne 0 ]; then
        >&2 say_red
        >&2 say_red "We're sorry, but it looks like something might have gone wrong during install."
        >&2 say_red "If you need help, please join the #install channel on https://slack.pulumi.io/"
    fi
}

trap at_exit EXIT

VERSION=""
if [ "$1" = "--version" ] && [ "$2" != "latest" ]; then
    VERSION=$2
else
    if ! VERSION=$(curl --fail --silent -L "https://www.pulumi.com/latest-version"); then
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

if [ "$(uname -m)" != "x86_64" ]; then
        print_unsupported_platform
        exit 1
fi

TARBALL_URL="https://get.pulumi.com/releases/sdk/pulumi-v${VERSION}-${OS}-x64.tar.gz"

if ! command -v pulumi >/dev/null; then
    say_blue "=== Installing Pulumi v${VERSION} ==="
else
    say_blue "=== Upgrading Pulumi $(pulumi version) to v${VERSION} ==="
fi

say_white "+ Downloading ${TARBALL_URL}..."

TARBALL_DEST=$(mktemp -t pulumi.tar.gz.XXXXXXXXXX)

if curl --fail -L -o "${TARBALL_DEST}" "${TARBALL_URL}"; then
    say_white "+ Extracting to $HOME/.pulumi/bin"

    # If `~/.pulumi/bin exists, clear it out
    if [ -e "${HOME}/.pulumi/bin" ]; then
        rm -rf "${HOME}/.pulumi/bin"
    fi

    mkdir -p "${HOME}/.pulumi"

    # Yarn's shell installer does a similar dance of extracting to a temp
    # folder and copying to not depend on additional tar flags
    EXTRACT_DIR=$(mktemp -d pulumi.XXXXXXXXXX)
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
        if ! grep -q "# add Pulumi to the PATH" "${PROFILE_FILE}"; then
            say_white "+ Adding \$HOME/.pulumi/bin to \$PATH in ${PROFILE_FILE}"
            printf "\\n# add Pulumi to the PATH\\n%s\\n" "${LINE_TO_ADD}" >> "${PROFILE_FILE}"
        fi

        EXTRA_INSTALL_STEP="+ Please restart your shell or add add $HOME/.pulumi/bin to your \$PATH"
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
say_green "+ If you're new to Pulumi, get started: https://www.pulumi.com/docs/quickstart"
