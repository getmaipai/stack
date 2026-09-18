const result = await Bun.$`git log --format=%s $(git describe --tags --abbrev=0 2>/dev/null || echo HEAD~20)..HEAD`.text();
const lines = result.trim().split("\n").filter(Boolean).map((line) => `- ${line}`);
console.log(["## [Unreleased]", "", "### Changed", "", ...lines].join("\n"));
