param(
    [string]$Version
)

Set-StrictMode -Version Latest
$ErrorActionPreference="Stop"
$ProgressPreference="SilentlyContinue"

# Some versions of PowerShell do not support Tls1.2 out of the box, but pulumi.com requires it
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($Version -eq $null -or $Version -eq "") {
    # TODO: removed hardcoded version
    $latestVersion="0.4.5"

    # TODO: add latest-version support for pulumi/esc
    # Query pulumi.com/latest-version for the most recent release. Because this approach
    # is now used by third parties as well (e.g., GitHub Actions virtual environments),
    # changes to this API should be made with care to avoid breaking any services that
    # rely on it (and ideally be accompanied by PRs to update them accordingly). Known
    # consumers of this API include:
    #
    # * https://github.com/actions/virtual-environments
    #
#    $latestVersion = (Invoke-WebRequest -UseBasicParsing https://www.pulumi.com/latest-version).Content.Trim()
    $Version = $latestVersion
}

$downloadUrl = "https://get.pulumi.com/esc/releases/esc-v${Version}-windows-x64.zip"

Write-Host "Downloading $downloadUrl"

# Download to a temp file, Expand-Archive requires that the extention of the file be "zip", so we do a bit of work here
# to generate the filename.
$tempZip = New-Item -Type File (Join-Path $env:TEMP ([System.IO.Path]::ChangeExtension(([System.IO.Path]::GetRandomFileName()), "zip")))
Invoke-WebRequest $downloadUrl -OutFile $tempZip

# Extract the zip we've downloaded. It contains a single root folder named "Pulumi" with a sub-directory named "bin"
$tempDir = New-Item -Type Directory (Join-Path $env:TEMP ([System.IO.Path]::GetRandomFileName()))

# PowerShell 5.0 added a nice Expand-Archive command, which we'll use when its present, otherwise we fallback to using .NET
if ($PSVersionTable.PSVersion.Major -ge 5) {
    Expand-Archive $tempZip $tempDir
} else {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($tempZip, $tempDir)
}

# Install into %USERPROFILE%\.pulumi\bin
$pulumiInstallRoot = (Join-Path $env:UserProfile ".pulumi")
$binRoot = (Join-Path $pulumiInstallRoot "bin")
$escPath = (Join-Path $binRoot "esc")

Write-Host "Copying Pulumi ESC to $binRoot"

# If we have a previous install, delete it.
if (Test-Path -Path $escPath) {
    Remove-Item -Path $escPath -Force
}

# Create the %USERPROFILE%\.pulumi\bin directory if it doesn't exist
if (-not (Test-Path -Path $binRoot -PathType Container)) {
    New-Item -Path $binRoot -ItemType Directory
}

# Copy the esc binary to %USERPROFILE%\.pulumi\bin
Move-Item -Path (Join-Path $tempDir "esc") -Destination $escPath -Force


# Attempt to add ourselves to the $PATH, but if we can't, don't fail the overall script.
try {
    $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree);
    $val = $envKey.GetValue("PATH", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);
    if ($val -notlike "*${binRoot};*") {
        $envKey.SetValue("PATH", "$binRoot;$val", [Microsoft.Win32.RegistryValueKind]::ExpandString);
        Write-Host "Added $binRoot to the `$PATH. Changes may not be visible until after a restart."
    }
    $envKey.Close();
} catch {
}

if ($env:PATH -notlike "*$binRoot*") {
    $env:PATH = "$binRoot;$env:PATH"
}

# And cleanup our temp files
Remove-Item -Force $tempZip
Remove-Item -Recurse -Force $tempDir

Write-Host "Pulumi ESC is now installed!"
Write-Host ""
Write-Host "Ensure that $binRoot is on your `$PATH to use it."
Write-Host ""
Write-Host "Get started with Pulumi ESC: https://www.pulumi.com/docs/pulumi-cloud/esc/get-started"
