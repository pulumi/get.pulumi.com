homedir = ENV["HOME"]

describe file("#{homedir}/.pulumi") do
  it { should be_directory }
end

describe file("#{homedir}/.pulumi/bin") do
  it { should be_directory }
end

# FIXME: readd pulumi-language-python-exec
installed_files = %w[
  pulumi
  pulumi-analyzer-policy
  pulumi-analyzer-policy-python
  pulumi-language-dotnet
  pulumi-language-go
  pulumi-language-nodejs
  pulumi-language-python
  pulumi-resource-pulumi-nodejs
  pulumi-resource-pulumi-python
]

installed_files.each do |file|
  describe file("#{homedir}/.pulumi/bin/#{file}") do
    it { should exist }
    its('type') { should eq :file }
    its('mode') { should cmp '00755' }
    its('size') { should be > 64 }
  end
end
