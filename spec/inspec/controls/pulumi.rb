homedir = ENV["HOME"]

describe file("#{homedir}/.pulumi") do
  it { should be_directory }
end

describe file("#{homedir}/.pulumi/bin") do
  it { should be_directory }
end

describe file("#{homedir}/.pulumi") do
  it { should be_directory }
end

describe file("#{homedir}/.pulumi/bin/pulumi") do
  it { should exist }
  its('type') { should eq :file }
  its('mode') { should cmp '00755' }
  its('size') { should be > 64 }
end
