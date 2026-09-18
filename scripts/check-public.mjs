import { execFileSync } from "node:child_process";

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
const files = git(["ls-files", "-z"]).split("\0").filter(Boolean);
const checks = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["GitHub credential", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["provider credential", /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{30,}\b/],
  ["personal Windows path", /\b[A-Za-z]:[\\/]Users[\\/][^\s/\\]+/i],
  ["personal Unix path", /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
];
const forbiddenFile =
  /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|vault\.enc|master\.key)$|\.(?:pem|key|sqlite|db|log)$/i;
let failures = 0;
for (const file of files) {
  if (forbiddenFile.test(file)) {
    console.error("A private runtime or credential file is tracked; filename withheld");
    failures++;
    continue;
  }
  const body = git(["show", `:${file}`]);
  for (const [label, pattern] of checks)
    if (pattern.test(body) || pattern.test(file)) {
      console.error(`Public-data check failed: ${label}; matched content withheld`);
      failures++;
    }
}
if (failures) process.exitCode = 1;
else
  console.log(
    `Public-data patterns checked in ${files.length} staged/tracked files. Manual review is still required.`,
  );
