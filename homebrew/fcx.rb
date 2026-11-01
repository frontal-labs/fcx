class Fcx < Formula
  desc "fcx - Frontal Codex Extra Small, a local coding agent"
  homepage "https://github.com/frontal-labs/fcx"
  version "0.0.0"
  license "Apache-2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/frontal-labs/fcx/releases/download/v0.0.0/fcx-darwin-arm64"
      sha256 "placeholder-arm64"
    else
      url "https://github.com/frontal-labs/fcx/releases/download/v0.0.0/fcx-darwin-x64"
      sha256 "placeholder-x64"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/frontal-labs/fcx/releases/download/v0.0.0/fcx-linux-arm64"
      sha256 "placeholder-arm64"
    else
      url "https://github.com/frontal-labs/fcx/releases/download/v0.0.0/fcx-linux-x64"
      sha256 "placeholder-x64"
    end
  end

  def install
    bin.install "fcx"
  end

  test do
    system "#{bin}/fcx", "--version"
  end
end
